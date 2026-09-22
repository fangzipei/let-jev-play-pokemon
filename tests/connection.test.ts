import {describe, expect, it} from 'vitest';
import {nullLogger} from '../src/log/logger.js';
import {PsConnection, splitFrames, type WsLike} from '../src/ps/connection.js';

class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }

  open(): void {
    this.emit('open');
  }

  message(data: string): void {
    this.emit('message', data);
  }
}

function mkConn(
  sockets: FakeWs[],
  opts: {maxReconnects?: number; reconnectDelayMs?: number} = {},
): PsConnection {
  return new PsConnection({
    serverUrl: 'wss://example.invalid/ws',
    logger: nullLogger,
    wsFactory: url => {
      const ws = new FakeWs(url);
      sockets.push(ws);
      return ws;
    },
    maxReconnects: opts.maxReconnects ?? 3,
    reconnectDelayMs: opts.reconnectDelayMs ?? 5,
  });
}

// 说明（与计划的偏差）：计划原版假设"半行可能跨 socket 帧拆分"并做跨帧缓冲。
// 实测（连接 wss://sim3.psim.us 抓帧）+ 官方 PROTOCOL.md（"结尾有无换行应同样对待"）
// + 服务器实现（server/users.ts：非 lobby 房间每次发送都重新带 `>roomid` 头）表明：
// 每个 websocket 帧都是完整消息，帧与帧互相独立，不应跨帧缓冲半行。
describe('splitFrames', () => {
  it('解析房间块与相邻房间块（真实帧不以换行结尾）', () => {
    const messages = splitFrames('>battle-1\n|player|p1|me\n|request|{}\n>development\n|chat|hi');
    expect(messages).toEqual([
      {roomId: 'battle-1', lines: ['|player|p1|me', '|request|{}']},
      {roomId: 'development', lines: ['|chat|hi']},
    ]);
  });

  it('无房间头的行归到全局（真实帧：updateuser 与 formats 由服务器合并在一次发送里）', () => {
    const messages = splitFrames('|updateuser| Guest|0|101|{}\n|formats|,1|A|B|');
    expect(messages).toEqual([
      {roomId: '', lines: ['|updateuser| Guest|0|101|{}', '|formats|,1|A|B|']},
    ]);
  });

  it('空帧 / 空行 / 孤立房间头都被忽略', () => {
    expect(splitFrames('')).toEqual([]);
    expect(splitFrames('\n\n')).toEqual([]);
    expect(splitFrames('>battle-2\n')).toEqual([]);
  });
});

describe('PsConnection', () => {
  it('连接、收发编码与消息分发', async () => {
    const sockets: FakeWs[] = [];
    const conn = mkConn(sockets);
    const seen: Array<{roomId: string; lines: string[]}> = [];
    conn.onMessage(msg => seen.push(msg));
    const connected = conn.connect();
    sockets[0].open();
    await connected;
    conn.command('/trn me,0,assert');
    conn.send('battle-1', '/choose move 1 +1');
    expect(sockets[0].sent).toEqual(['|/trn me,0,assert', 'battle-1|/choose move 1 +1']);
    sockets[0].message('>battle-1\n|player|p1|me');
    expect(seen).toEqual([{roomId: 'battle-1', lines: ['|player|p1|me']}]);
  });

  it('每个帧独立解析：无尾换行的最后一行也会立即分发', async () => {
    const sockets: FakeWs[] = [];
    const conn = mkConn(sockets);
    const seen: string[] = [];
    conn.onMessage(msg => seen.push(msg.lines[0]));
    const connected = conn.connect();
    sockets[0].open();
    await connected;
    sockets[0].message('|challstr|4|abc');
    sockets[0].message('>battle-1\n|turn|1');
    expect(seen).toEqual(['|challstr|4|abc', '|turn|1']);
  });

  it('断开后自动重连并触发 onReconnect', async () => {
    const sockets: FakeWs[] = [];
    const conn = mkConn(sockets, {reconnectDelayMs: 2});
    const reconnects: number[] = [];
    conn.onReconnect(() => reconnects.push(sockets.length));
    const connected = conn.connect();
    sockets[0].open();
    await connected;
    sockets[0].close();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(sockets.length).toBe(2);
    sockets[1].open();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(reconnects).toEqual([2]);
  });
});
