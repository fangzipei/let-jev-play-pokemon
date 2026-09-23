import {afterEach, describe, expect, it, vi} from 'vitest';
import * as policy from '../src/decide/policy.js';
import type {DecisionOutcome} from '../src/decide/policy.js';
import type {AdvisorClient} from '../src/jev/advisor.js';
import {loadConfig} from '../src/config.js';
import {nullLogger, type Logger} from '../src/log/logger.js';
import {PsConnection, type WsLike} from '../src/ps/connection.js';
import {PsSession, type PsSessionOptions} from '../src/ps/session.js';
import {mkDex, mkRequest} from './helpers.js';

afterEach(() => vi.restoreAllMocks());

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

async function mkHarness(cfgOverrides: Record<string, string> = {}, overrides: Partial<PsSessionOptions> = {}) {
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
    ...overrides,
  });
  conn.onMessage(msg => session.handleMessage(msg));
  const connected = conn.connect();
  sockets[0].open();
  await connected;
  return {sockets, conn, session};
}

describe('PsSession', () => {
  it('advisor 与预算配置透传到每个房间的决策上下文', async () => {
    const advisor: AdvisorClient = {analyze: vi.fn(async () => null)};
    const decide = vi.spyOn(policy, 'decideChoice').mockResolvedValue(null);
    const {sockets, conn} = await mkHarness({JEV_CONTEXT_LEVEL: '3', JEV_DECISION_BUDGET_MS: '4321'}, {advisor});
    const now = Date.now();
    for (const id of ['battle-one', 'battle-two']) {
      sockets[0].message(`>${id}\n|request|${JSON.stringify(mkRequest())}\n`);
    }
    expect(decide).toHaveBeenCalledTimes(2);
    for (const [ctx] of decide.mock.calls) {
      expect(ctx.advisor).toBe(advisor);
      expect(ctx.cfg.jevContextLevel).toBe(3);
      expect(ctx.control?.deadlineAt).toBeGreaterThanOrEqual(now + 4321);
    }
    conn.close();
  });

  it.each(['result', 'error'])('dispose 取消所有房间，旧 %s 不发送 default', async kind => {
    let resolve!: (value: DecisionOutcome) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<DecisionOutcome>((yes, no) => { resolve = yes; reject = no; });
    const decide = vi.spyOn(policy, 'decideChoice').mockReturnValue(pending);
    const {sockets, session, conn} = await mkHarness();
    for (const id of ['battle-one', 'battle-two']) {
      sockets[0].message(`>${id}\n|request|${JSON.stringify(mkRequest())}\n`);
    }
    const sentBeforeDispose = sockets[0].sent.length;
    session.dispose();
    session.dispose();
    for (const [ctx] of decide.mock.calls) expect(ctx.control?.signal?.aborted).toBe(true);
    if (kind === 'result') resolve({kind: 'turn', command: '/choose default', chosen: [], adjusted: [], fallback: true});
    else reject(new Error('取消后迟到异常'));
    await new Promise(done => setTimeout(done, 0));
    for (const room of session.rooms.values()) room.sendDefault();
    expect(sockets[0].sent.slice(sentBeforeDispose)).toEqual([]);
    conn.close();
  });

  it('断线清理不永久停用会话，重发相同请求可重新决策', async () => {
    const decide = vi.spyOn(policy, 'decideChoice').mockResolvedValue(null);
    const {sockets, session, conn} = await mkHarness();
    const frame = `>battle-one\n|request|${JSON.stringify(mkRequest())}\n`;
    sockets[0].message(frame);
    const oldSignal = decide.mock.calls[0][0].control?.signal;
    session.dispose();
    sockets[0].message(frame);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(oldSignal?.aborted).toBe(true);
    expect(decide.mock.calls[1][0].control?.signal?.aborted).toBe(false);
    conn.close();
  });

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

  it('进入战斗房间时自动请求开启计时器', async () => {
    const {sockets} = await mkHarness();
    sockets[0].message('|challstr|4|12345\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn ')));
    sockets[0].message('>battle-gen9championsvgc2026regmc-1\n|player|p1|JevBot1000|1|1500\n');
    await waitFor(() => sockets[0].sent.some(s => s === 'battle-gen9championsvgc2026regmc-1|/timer on'));
  });

  it('进入战斗房间时日志包含比赛 URL', async () => {
    const infos: string[] = [];
    const logger: Logger = {...nullLogger, info: msg => infos.push(msg)};
    const {sockets} = await mkHarness({}, {logger});
    sockets[0].message('|challstr|4|12345\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn ')));
    sockets[0].message('>battle-gen9championsvgc2026regmc-1\n|player|p1|JevBot1000|1|1500\n');
    await waitFor(() => infos.some(m => m.includes('https://play.pokemonshowdown.com/battle-gen9championsvgc2026regmc-1')));
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
