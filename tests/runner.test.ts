import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadConfig, type AppConfig} from '../src/config.js';
import * as policy from '../src/decide/policy.js';
import type {DecisionOutcome} from '../src/decide/policy.js';
import * as advisorModule from '../src/jev/advisor.js';
import * as jevModule from '../src/jev/client.js';
import {PsSession} from '../src/ps/session.js';
import {nullLogger} from '../src/log/logger.js';
import {runMatch, summarizeBattles} from '../src/match/runner.js';
import type {WsLike} from '../src/ps/connection.js';
import {mkDex} from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const SIMPLE_PASTE = [
  'Golisopod @ Golisopite',
  'Ability: Emergency Exit',
  '- Iron Head',
  '',
  'Tyranitar @ Choice Scarf',
  'Ability: Sand Stream',
  '- Rock Slide',
].join('\n');

const PREVIEW_REQUEST =
  '{"teamPreview":true,"rqid":1,"side":{"name":"JevBot1000","id":"p1","pokemon":[' +
  '{"ident":"p1: Golisopod","details":"Golisopod, L50, M","condition":"150/150","active":false},' +
  '{"ident":"p1: Tyranitar","details":"Tyranitar, L50, M","condition":"175/175","active":false},' +
  '{"ident":"p1: Chandelure","details":"Chandelure, L50, F","condition":"135/135","active":false},' +
  '{"ident":"p1: Excadrill","details":"Excadrill, L50, F","condition":"165/165","active":false},' +
  '{"ident":"p1: Salamence","details":"Salamence, L50, M","condition":"170/170","active":false},' +
  '{"ident":"p1: Rotom-Wash","details":"Rotom-Wash, L50","condition":"135/135","active":false}]}}';

async function startHarness(overrides: Partial<AppConfig> = {}, fetchImpl?: typeof fetch) {
  const sockets: FakeWs[] = [];
  const cfg = {...loadConfig({JEV_MOCK: '1', PS_USERNAME: 'JevBot1000', PS_PASSWORD: ''}), ...overrides};
  const runPromise = runMatch({
    cfg, logger: nullLogger, dex: mkDex(), paste: SIMPLE_PASTE, waitBattleTimeoutMs: 3000,
    fetchImpl,
    wsFactory: url => {
      const socket = new FakeWs(url);
      sockets.push(socket);
      return socket;
    },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].open();
  return {sockets, runPromise};
}

const requestFrame = `>battle-wiring\n|request|${PREVIEW_REQUEST}\n`;
const wiringDecision: DecisionOutcome = {
  kind: 'team-preview', command: '/choose team 123456|1', chosen: [], adjusted: [], fallback: false,
};

describe('runMatch 主接线', () => {
  it.each([
    {level: 1 as const, mock: false, key: 'advisor-test-key'},
    {level: 2 as const, mock: false, key: 'advisor-test-key'},
    {level: 3 as const, mock: true, key: 'advisor-test-key'},
    {level: 3 as const, mock: false, key: '   '},
  ])('L$level mock=$mock key="$key" 不创建 advisor', async ({level, mock, key}) => {
    const makeAdvisor = vi.spyOn(advisorModule, 'createAdvisorClient');
    const makeJev = vi.spyOn(jevModule, 'createJevClient');
    const decide = vi.spyOn(policy, 'decideChoice').mockResolvedValue(null);
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('不应发起 HTTP'); });
    const {sockets, runPromise} = await startHarness({
      jevContextLevel: level, jevMock: mock, jevAdvisorApiKey: key,
      openrouterApiKey: 'main-test-key', jevTransport: 'fetch',
    }, fetchImpl);
    sockets[0].message(requestFrame);
    expect(makeAdvisor).not.toHaveBeenCalled();
    expect(decide.mock.calls[0][0].advisor).toBeNull();
    if (mock) expect(makeJev).not.toHaveBeenCalled();
    else expect(makeJev).toHaveBeenCalledWith(expect.objectContaining({fetchImpl}));
    expect(fetchImpl).not.toHaveBeenCalled();
    sockets[0].message('>battle-wiring\n|win|JevBot1000\n');
    await runPromise;
  });

  it('L3 通过真实客户端使用注入 fetch，并透传 advisor 配置与双路成本', async () => {
    const globalFetch = vi.fn<typeof fetch>(async () => { throw new Error('禁止访问真实网络'); });
    vi.stubGlobal('fetch', globalFetch);
    const makeAdvisor = vi.spyOn(advisorModule, 'createAdvisorClient');
    const makeJev = vi.spyOn(jevModule, 'createJevClient');
    const fetchImpl = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith('/chat/completions')) {
        return Response.json({choices: [{message: {content: 'RECOMMEND: legal leads'}}], usage: {cost: 0.02}});
      }
      if (String(url).endsWith('/decisions')) return Response.json({answers: {}, usage: {cost: 0.03}});
      throw new Error('未知 HTTP 端点');
    });
    // 隔离主代理的 policy 实现，仅模拟约定接口；两个客户端与其传输均为真实实现。
    const decide = vi.spyOn(policy, 'decideChoice').mockImplementation(async ctx => {
      const advice = await ctx.advisor?.analyze({kind: 'team-preview', state: {}, questions: {}}, ctx.control);
      if (advice) ctx.onUsage?.(advice.usage, 'advisor');
      const result = await ctx.jev!.decide({state: {}, questions: {}}, ctx.control);
      ctx.onUsage?.(result.usage, 'jev');
      return {...wiringDecision, usage: result.usage, advisorUsage: advice?.usage};
    });
    const {sockets, runPromise} = await startHarness({
      jevMock: false, jevContextLevel: 3, openrouterApiKey: 'main-test-key',
      jevAdvisorApiKey: 'advisor-test-key', jevAdvisorModel: 'advisor-test-model',
      jevAdvisorTimeoutMs: 7654, jevAdvisorMaxTokens: 3072, jevAdvisorReasoning: 'low', jevDecisionBudgetMs: 8765, jevTransport: 'fetch', jevRetry: 0,
    }, fetchImpl);
    sockets[0].message(requestFrame);
    await waitFor(() => sockets[0].sent.some(line => line.includes('/choose')));
    expect(makeAdvisor).toHaveBeenCalledOnce();
    expect(makeAdvisor).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'advisor-test-key', model: 'advisor-test-model', timeoutMs: 7654, maxTokens: 3072,
      reasoningEffort: 'low', fetchImpl,
    }));
    expect(makeJev).toHaveBeenCalledWith(expect.objectContaining({fetchImpl}));
    expect(decide.mock.calls[0][0].advisor).toBe(makeAdvisor.mock.results[0].value);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal);
    sockets[0].message('>battle-wiring\n|win|JevBot1000\n');
    const result = await runPromise;
    expect(result.totalCostUsd).toBeCloseTo(0.05);
    expect(result.summaries[0].costUsd).toBeCloseTo(0.05);
  });

  it('连接关闭取消旧决策，真实重连后相同请求可以重新处理', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    let resolve!: (outcome: DecisionOutcome) => void;
    const pending = new Promise<DecisionOutcome>(yes => { resolve = yes; });
    const decide = vi.spyOn(policy, 'decideChoice').mockReturnValueOnce(pending).mockResolvedValue(wiringDecision);
    const {sockets, runPromise} = await startHarness();
    sockets[0].message(requestFrame);
    const signal = decide.mock.calls[0][0].control?.signal;
    sockets[0].close();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].message(requestFrame);
    resolve(wiringDecision);
    await vi.advanceTimersByTimeAsync(0);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(sockets[1].sent).toEqual([`battle-wiring|${wiringDecision.command}`]);
    sockets[1].message('>battle-wiring\n|win|JevBot1000\n');
    await runPromise;
  });

  it('正常 finally 在关闭连接前取消其他房间的飞行决策', async () => {
    let resolve!: (outcome: DecisionOutcome) => void;
    const pending = new Promise<DecisionOutcome>(yes => { resolve = yes; });
    const decide = vi.spyOn(policy, 'decideChoice').mockReturnValue(pending);
    const dispose = vi.spyOn(PsSession.prototype, 'dispose');
    const {sockets, runPromise} = await startHarness();
    sockets[0].message('>battle-main\n|player|p1|JevBot1000\n');
    sockets[0].message(requestFrame);
    const signal = decide.mock.calls[0][0].control?.signal;
    // 不触发 onClose，单独验证 finally 的主动清理。
    const close = vi.spyOn(sockets[0], 'close').mockImplementation(() => {
      expect(signal?.aborted).toBe(true);
    });
    sockets[0].message('>battle-main\n|win|JevBot1000\n');
    await runPromise;
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    const sentBeforeLateResolve = sockets[0].sent.length;
    resolve(wiringDecision);
    await new Promise(done => setTimeout(done, 0));
    expect(sockets[0].sent.slice(sentBeforeLateResolve)).toEqual([]);
  });

  it('异常 finally 同样清理，顶层 default 后迟到错误不重复发送', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<DecisionOutcome>((_, no) => { reject = no; });
    const decide = vi.spyOn(policy, 'decideChoice').mockReturnValue(pending);
    const dispose = vi.spyOn(PsSession.prototype, 'dispose');
    const {sockets, runPromise} = await startHarness();
    const rejected = expect(runPromise).rejects.toThrow('会话失败');
    sockets[0].message(requestFrame);
    sockets[0].message('|popup|fatal test failure\n');
    const signal = decide.mock.calls[0][0].control?.signal;
    vi.spyOn(sockets[0], 'close').mockImplementation(() => {});
    await rejected;
    expect(dispose).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(sockets[0].sent).toEqual(['battle-wiring|/timer on', 'battle-wiring|/choose default']);
    reject(new Error('取消后失败'));
    await new Promise(done => setTimeout(done, 0));
    expect(sockets[0].sent).toEqual(['battle-wiring|/timer on', 'battle-wiring|/choose default']);
  });
});

describe('summarizeBattles', () => {
  it('统计胜负与总花费', () => {
    const result = summarizeBattles([
      {battleId: 'b1', won: true, turns: 8, decisions: 8, fallbacks: 0, costUsd: 0.01, finished: true},
      {battleId: 'b2', winner: 'foe', won: false, turns: 10, decisions: 10, fallbacks: 2, costUsd: 0.02, finished: true},
    ]);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.03);
  });
});

describe('runMatch（最小流程）', () => {
  it('登录 → 搜索 → 战斗房间 → team preview 决策 → 胜利汇总', async () => {
    const sockets: FakeWs[] = [];
    const cfg = loadConfig({JEV_MOCK: '1', PS_USERNAME: 'JevBot1000', PS_PASSWORD: '', MAX_BATTLES: '1'});
    const runPromise = runMatch({
      cfg,
      logger: nullLogger,
      dex: mkDex(),
      paste: SIMPLE_PASTE,
      waitBattleTimeoutMs: 3000,
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      fetchImpl: (async () => new Response(']{"assertion":"assert-1"}', {status: 200})) as typeof fetch,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0].open();
    sockets[0].message('|challstr|4|12345\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn JevBot1000,0,')));
    sockets[0].message('|updateuser|JevBot1000|1|1\n');
    await waitFor(() => sockets[0].sent.includes('|/search gen9championsvgc2026regmc'));
    sockets[0].message(
      '>battle-gen9championsvgc2026regmc-1000\n' +
        '|player|p1|JevBot1000|1|1500\n' +
        '|player|p2|foe|2|1500\n' +
        '|teampreview|4\n' +
        `|request|${PREVIEW_REQUEST}\n`,
    );
    await waitFor(() => sockets[0].sent.some(s => s.includes('|/choose team ')));
    expect(sockets[0].sent.some(s => s === 'battle-gen9championsvgc2026regmc-1000|/choose team 123456|1')).toBe(true);
    // 真实服务器发送房间消息时总会带 `>roomid` 头（server/users.ts sendTo），这里保持一致
    sockets[0].message('>battle-gen9championsvgc2026regmc-1000\n|win|JevBot1000\n');
    const result = await runPromise;
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(0);
    expect(result.summaries[0].battleId).toBe('battle-gen9championsvgc2026regmc-1000');
    expect(result.summaries[0].turns).toBe(0);
  });

  it('等待战斗超时抛出可读错误', async () => {
    const sockets: FakeWs[] = [];
    const cfg = loadConfig({JEV_MOCK: '1', PS_USERNAME: 'JevBot2000', PS_PASSWORD: ''});
    const runPromise = runMatch({
      cfg,
      logger: nullLogger,
      dex: mkDex(),
      paste: SIMPLE_PASTE,
      waitBattleTimeoutMs: 400,
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      fetchImpl: (async () => new Response(']{"assertion":"assert-1"}', {status: 200})) as typeof fetch,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0].open();
    sockets[0].message('|challstr|4|999\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn ')));
    sockets[0].message('|updateuser|JevBot2000|1|1\n');
    await expect(runPromise).rejects.toThrow(/超时/);
  });
});
