import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  // 默认关闭 Pikalytics 预拉并隔离先验/经验目录：测试不触网、不读写工作区 .cache。
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-scratch-'));
  const cfg = {
    ...loadConfig({JEV_MOCK: '1', PS_USERNAME: 'JevBot1000', PS_PASSWORD: ''}),
    pikaEnabled: false, pikaDir: path.join(scratch, 'pika'), memoryDir: path.join(scratch, 'memory'),
    chamdbDir: path.join(scratch, 'chamdb'),
    ...overrides,
  };
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
    let resolve!: (outcome: DecisionOutcome) => void;
    const pending = new Promise<DecisionOutcome>(yes => { resolve = yes; });
    const decide = vi.spyOn(policy, 'decideChoice').mockReturnValueOnce(pending).mockResolvedValue(wiringDecision);
    // 启动阶段用真实定时器：runner 启动含文件 I/O（经验库加载），startHarness 内部的 waitFor 依赖真实 setTimeout。
    // 启动完成后才冻结定时器，使 close→重连（1000ms）与决策窗口由测试推进。
    const {sockets, runPromise} = await startHarness();
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
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
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-scratch-'));
    const cfg = {
      ...loadConfig({JEV_MOCK: '1', PS_USERNAME: 'JevBot1000', PS_PASSWORD: '', MAX_BATTLES: '1'}),
      chamdbDir: path.join(scratch, 'chamdb'),
    };
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
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-scratch-'));
    const cfg = {
      ...loadConfig({JEV_MOCK: '1', PS_USERNAME: 'JevBot2000', PS_PASSWORD: ''}),
      pikaEnabled: false, chamdbDir: path.join(scratch, 'chamdb'),
    };
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

  it('启动时预拉 Pikalytics 先验并加载经验库（失败静默降级）', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: unknown) => {
      calls.push(String(url));
      return {ok: false, status: 503} as Response;
    }) as unknown as typeof fetch;
    const pikaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pika-runner-'));
    const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-runner-'));
    const {sockets, runPromise} = await startHarness({pikaEnabled: true, pikaDir, memoryDir}, fakeFetch);
    sockets[0].open();
    await waitFor(() => calls.some(u => u.includes('cdn.pikalytics.com/scripts/game.js')), 3000);
    sockets[0].emit('close');
    await runPromise.catch(() => {});
    expect(calls.some(u => u.includes('cdn.pikalytics.com/scripts/game.js'))).toBe(true);
  });

  it('默认路径：从 pokechamdb 本地缓存构建先验并透传到决策上下文；缺缓存时静默无先验', async () => {
    // 预置最小可用的 chamdb 缓存（1 物种，无 notes 说明文件）
    const chamdbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chamdb-runner-'));
    const updatedAt = '2026-09-24T00:43:26.072+00:00';
    await fs.writeFile(path.join(chamdbDir, 'meta.json'), JSON.stringify({
      season: 'M-6', format: 'double', limit: 1, fetchedAt: updatedAt, rankingsUpdatedAt: updatedAt,
      speciesCount: 1, fetched: [], skipped: [], failures: [],
    }));
    await fs.writeFile(path.join(chamdbDir, 'rankings-M-6-double.json'), JSON.stringify({
      seasonId: 'M-6', format: 'double', updatedAt,
      entries: [{rank: 1, pokemonJa: 'ゴリランダー', pokemonSlug: 'rillaboom'}],
    }));
    await fs.writeFile(path.join(chamdbDir, 'rillaboom.json'), JSON.stringify({
      slug: 'rillaboom',
      variants: {'M-6:double': {
        seasonId: 'M-6', format: 'double', rank: 1, pokemonJa: 'ゴリランダー', pokemonSlug: 'rillaboom', dexNo: 812,
        moves: [{rank: 1, percentage: 97.5, name: 'グラススライダー'}],
        items: [], abilities: [], natures: [], evs: [], partners: [], updatedAt,
      }},
    }));
    const decide = vi.spyOn(policy, 'decideChoice').mockResolvedValue(wiringDecision);
    const {sockets, runPromise} = await startHarness({chamdbDir});
    sockets[0].message(requestFrame);
    await waitFor(() => decide.mock.calls.length > 0);
    const ctx = decide.mock.calls[0][0];
    expect(ctx.priors?.label).toBe('pokechamdb M-6 double 2026-09-24');
    expect(ctx.priors?.bySpecies.rillaboom.moves[0]).toEqual({name: 'グラススライダー', percent: 97.5});
    sockets[0].message('>battle-wiring\n|win|JevBot1000\n');
    await runPromise;
    // 缺缓存（空目录）时先验为 null，不影响决策链。
    // 注意：decideChoice 已被 spy，二次 vi.spyOn 会返回同一 mock 实例，故复用并按下标区分两轮。
    const callsBefore = decide.mock.calls.length;
    const second = await startHarness();
    second.sockets[0].message(requestFrame);
    await waitFor(() => decide.mock.calls.length > callsBefore);
    expect(decide.mock.calls[callsBefore][0].priors).toBeNull();
    second.sockets[0].message('>battle-wiring\n|win|JevBot1000\n');
    await second.runPromise;
  });
});
