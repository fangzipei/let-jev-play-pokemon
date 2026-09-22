import {describe, expect, it} from 'vitest';
import {loadConfig} from '../src/config.js';
import {nullLogger} from '../src/log/logger.js';
import {PsConnection, type WsLike} from '../src/ps/connection.js';
import {PsSession} from '../src/ps/session.js';
import {mkDex} from './helpers.js';

class FakeWs implements WsLike {
  sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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

async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function mkHarness(cfgOverrides: Record<string, string> = {}) {
  const sockets: FakeWs[] = [];
  const conn = new PsConnection({
    serverUrl: 'wss://example.invalid/ws',
    logger: nullLogger,
    wsFactory: url => {
      const ws = new FakeWs(url);
      sockets.push(ws);
      return ws;
    },
  });
  const cfg = loadConfig({
    JEV_MOCK: '1',
    PS_USERNAME: 'JevBot1000',
    PS_PASSWORD: '',
    START_MODE: 'ladder',
    ...cfgOverrides,
  });
  const session = new PsSession({
    conn,
    cfg,
    logger: nullLogger,
    dex: mkDex(),
    jev: null,
    packedTeam: 'PACKED',
    packedTeamFallback: 'PACKED_NO_MEGA',
    fetchImpl: (async () => new Response(']{"assertion":"assert-1"}', {status: 200})) as typeof fetch,
  });
  conn.onMessage(msg => session.handleMessage(msg));
  const connected = conn.connect();
  sockets[0].open();
  await connected;
  return {sockets, conn, session};
}

describe('PsSession', () => {
  it('challstr → /trn，登录成功 → /utm 与 /search', async () => {
    const {sockets} = await mkHarness();
    sockets[0].message('|challstr|4|12345\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn JevBot1000,0,')));
    sockets[0].message('|updateuser|JevBot1000|1|1\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/utm ')));
    expect(sockets[0].sent).toContain('|/utm PACKED');
    expect(sockets[0].sent).toContain('|/search gen9championsvgc2026regmc');
  });

  it('battle-* 房间消息创建 BattleRoom 并转发协议行', async () => {
    const {sockets, session} = await mkHarness();
    sockets[0].message('|challstr|4|12345\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn ')));
    sockets[0].message('|updateuser|JevBot1000|1|1\n');
    sockets[0].message('>battle-gen9championsvgc2026regmc-1\n|player|p1|JevBot1000|1|1500\n|player|p2|foe|2|1500\n');
    await waitFor(() => session.rooms.size === 1);
    const room = [...session.rooms.values()][0];
    expect(room.tracker.state.ourSideId).toBe('p1');
    expect(room.tracker.state.sides.p2?.name).toBe('foe');
  });

  it('nametaken 时游客自动改名并重试一次', async () => {
    const {sockets} = await mkHarness();
    sockets[0].message('|challstr|4|12345\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn JevBot1000,0,')));
    sockets[0].message('|nametaken|JevBot1000|Your username is invalid or already taken.\n');
    await waitFor(() => sockets[0].sent.some(s => /^\|\/trn JevBot1000\d{4},0,/.test(s)));
  });

  it('accept 模式收到挑战自动 /accept', async () => {
    const {sockets} = await mkHarness({START_MODE: 'accept'});
    sockets[0].message('|challstr|4|12345\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn ')));
    sockets[0].message('|updateuser|JevBot1000|1|1\n');
    sockets[0].message('|updatechallenges|{"challengesFrom":{"someone":"gen9championsvgc2026regmc"}}\n');
    await waitFor(() => sockets[0].sent.includes('|/accept someone'));
  });
});
