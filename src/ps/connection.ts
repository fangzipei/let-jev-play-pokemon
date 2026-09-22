import {WebSocket} from 'ws';
import type {Logger} from '../log/logger.js';

export interface PsMessage {
  /** '' = 全局消息 */
  roomId: string;
  lines: string[];
}

/** ws 的最小接口（测试注入 FakeWs） */
export interface WsLike {
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface PsConnectionOptions {
  serverUrl: string;
  logger: Logger;
  wsFactory?: (url: string) => WsLike;
  /** 断线自动重连上限（默认 3） */
  maxReconnects?: number;
  /** 重连基础延迟 ms（默认 1000，指数退避） */
  reconnectDelayMs?: number;
}

/**
 * 把一帧 socket 文本切成协议消息。
 *
 * 依据官方 PROTOCOL.md 与服务器实现（server/users.ts sendTo）：
 * - 每个非 lobby 房间的消息都带 `>roomid` 头，服务器每次发送都会重新加头
 * - lobby/global 消息没有头，`|` 开头的行归到"当前房间"
 * - 帧与帧互相独立：PROTOCOL.md 明确"结尾有无换行应同样对待"，
 *   实测真实帧也不以 \n 结尾，因此不跨帧缓冲半行
 * - 空行忽略；没有内容行的孤立房间头也忽略
 */
export function splitFrames(text: string): PsMessage[] {
  const messages: PsMessage[] = [];
  let current: PsMessage | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line[0] === '>') {
      if (current && current.lines.length > 0) messages.push(current);
      current = {roomId: line.slice(1).trim(), lines: []};
    } else if (line[0] === '|') {
      if (!current) current = {roomId: '', lines: []};
      current.lines.push(line);
    }
  }
  if (current && current.lines.length > 0) messages.push(current);
  return messages;
}

export class PsConnection {
  private socket: WsLike | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;
  private messageHandlers: Array<(msg: PsMessage) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private reconnectHandlers: Array<() => void> = [];

  constructor(private opts: PsConnectionOptions) {}

  onMessage(handler: (msg: PsMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /** socket 关闭（含非主动关闭）时触发 */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  /** 自动重连成功（已 open）后触发，用于重新登录 */
  onReconnect(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.connectOnce();
  }

  private createSocket(): WsLike {
    if (this.opts.wsFactory) return this.opts.wsFactory(this.opts.serverUrl);
    return new WebSocket(this.opts.serverUrl) as unknown as WsLike;
  }

  private connectOnce(): Promise<void> {
    const socket = this.createSocket();
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.on('open', () => {
        if (settled) return;
        settled = true;
        this.reconnectAttempts = 0;
        this.opts.logger.info(`PS 连接成功: ${this.opts.serverUrl}`);
        resolve();
      });
      socket.on('error', (err: unknown) => {
        this.opts.logger.warn(`PS 连接错误: ${err instanceof Error ? err.message : String(err)}`);
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      socket.on('message', (data: unknown) => this.handleData(data));
      socket.on('close', () => this.handleClose());
    });
  }

  private handleData(data: unknown): void {
    const text = typeof data === 'string' ? data : String(data);
    if (!text) return;
    for (const msg of splitFrames(text)) {
      for (const handler of this.messageHandlers) handler(msg);
    }
  }

  private handleClose(): void {
    this.socket = null;
    for (const handler of this.closeHandlers) handler();
    if (this.closedByUser) return;
    const max = this.opts.maxReconnects ?? 3;
    if (this.reconnectAttempts >= max) {
      this.opts.logger.error(`PS 连接断开且重连 ${max} 次仍未成功`);
      return;
    }
    const delay = (this.opts.reconnectDelayMs ?? 1000) * 2 ** this.reconnectAttempts;
    this.reconnectAttempts++;
    this.opts.logger.warn(`PS 连接断开，${delay}ms 后第 ${this.reconnectAttempts}/${max} 次重连`);
    setTimeout(() => {
      this.connectOnce()
        .then(() => {
          for (const handler of this.reconnectHandlers) handler();
        })
        .catch(() => {
          /* 失败会再次触发 close → 下一轮重连 */
        });
    }, delay);
  }

  /** 发到指定房间；roomId 为空 = 全局命令 */
  send(roomId: string, text: string): void {
    if (!this.socket) throw new Error('PS 连接尚未建立');
    this.socket.send(roomId ? `${roomId}|${text}` : `|${text}`);
  }

  command(text: string): void {
    this.send('', text);
  }

  close(): void {
    this.closedByUser = true;
    this.socket?.close();
  }
}
