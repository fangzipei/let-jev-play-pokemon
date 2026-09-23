import {afterEach, describe, expect, it, vi} from 'vitest';
import * as policy from '../src/decide/policy.js';
import type {DecisionOutcome} from '../src/decide/policy.js';
import type {AdvisorClient, AdvisorResult} from '../src/jev/advisor.js';
import type {DecideResult, JevClient} from '../src/jev/client.js';
import {nullLogger} from '../src/log/logger.js';
import {BattleRoom, type BattleRoomOptions} from '../src/ps/battle-room.js';
import type {PsConnection} from '../src/ps/connection.js';
import {mkDex, mkRequest} from './helpers.js';

async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function mkHarness(overrides: Partial<BattleRoomOptions> = {}): {room: BattleRoom; sent: string[]} {
  const sent: string[] = [];
  const conn = {
    send: (_battleId: string, command: string) => {
      sent.push(command);
    },
  } as unknown as PsConnection;
  const room = new BattleRoom({
    battleId: 'battle-test-1',
    ourName: 'JevBot1234',
    dex: mkDex(),
    jev: null,
    logger: nullLogger,
    conn,
    cfg: {jevMock: false, sendRqid: true},
    ...overrides,
  });
  room.handleLine('|player|p1|JevBot1234|1|1500');
  room.handleLine('|player|p2|opponent|2|1500');
  return {room, sent};
}

/** 双槽位强制换人 request（mkRequest 的替补为 teamIndex 3/4） */
function switchRequestLine(rqid: number): string {
  const req = mkRequest();
  req.active = undefined;
  req.forceSwitch = [true, true];
  req.rqid = rqid;
  return `|request|${JSON.stringify(req)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

const decision: DecisionOutcome = {
  kind: 'force-switch', command: '/choose switch 3, switch 4|9',
  chosen: [], adjusted: [], fallback: false,
};

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function mockPending() {
  const pending = deferred<DecisionOutcome | null>();
  const decide = vi.spyOn(policy, 'decideChoice').mockReturnValue(pending.promise);
  return {pending, decide};
}

const cancellations = [
  '|request|{"wait":true}',
  `|request|${JSON.stringify(mkRequest({wait: true}))}`,
  '|win|JevBot1234', '|tie|', '|deinit|',
] as const;

describe('BattleRoom 请求生命周期', () => {
  it.each([undefined, 1234])('传递 advisor、取消信号及绝对预算 %s', async budget => {
    const {pending, decide} = mockPending();
    const advisor: AdvisorClient = {analyze: vi.fn(async () => null)};
    const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
    const {room} = mkHarness({advisor, cfg: {
      jevMock: false, sendRqid: true, jevContextLevel: 3, jevDecisionBudgetMs: budget,
    }});
    room.handleLine(switchRequestLine(9));
    const ctx = decide.mock.calls[0][0];
    expect(ctx.advisor).toBe(advisor);
    expect(ctx.control?.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.control?.deadlineAt).toBe(10000 + (budget ?? 35000));
    now.mockReturnValue(10100);
    expect(ctx.control?.deadlineAt).toBe(10000 + (budget ?? 35000));
    pending.resolve(decision);
    await flush();
  });

  it('相同 JSON 在飞行中及已答复后只调用一次', async () => {
    const {pending, decide} = mockPending();
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    room.handleLine(switchRequestLine(9));
    expect(decide).toHaveBeenCalledTimes(1);
    pending.resolve(decision);
    await flush();
    room.handleLine(switchRequestLine(9));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([decision.command]);
  });

  it('已答复后同 rqid 的不同 payload 仍需重新决策', async () => {
    const decide = vi.spyOn(policy, 'decideChoice').mockResolvedValue(decision);
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await flush();
    room.handleLine(`|request|${JSON.stringify(mkRequest({rqid: 9}))}`);
    await flush();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
  });

  it('没有 rqid 的相同 JSON 也只调用一次', async () => {
    const {pending, decide} = mockPending();
    const {room, sent} = mkHarness();
    const line = `|request|${JSON.stringify(mkRequest({rqid: undefined}))}`;
    room.handleLine(line);
    room.handleLine(line);
    pending.resolve(decision);
    await flush();
    room.handleLine(line);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([decision.command]);
  });

  it.each(['新 rqid', '同 rqid 不同 payload'])('%s 取消旧任务并处理新请求', async kind => {
    const {pending, decide} = mockPending();
    const newer = deferred<DecisionOutcome | null>();
    decide.mockReturnValueOnce(pending.promise).mockReturnValueOnce(newer.promise);
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    const oldControl = decide.mock.calls[0][0].control;
    const next = kind === '新 rqid' ? switchRequestLine(10)
      : `|request|${JSON.stringify(mkRequest({rqid: 9, active: undefined, forceSwitch: [true, false]}))}`;
    room.handleLine(next);
    expect(oldControl?.signal?.aborted).toBe(true);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[1][0].control?.signal?.aborted).toBe(false);
    pending.resolve(decision);
    await flush();
    expect(sent).toEqual([]);
    newer.resolve({...decision, command: '/choose switch 3, pass'});
    await flush();
    expect(sent).toEqual(['/choose switch 3, pass']);
  });

  for (const line of cancellations) {
    it.each(['result', 'error'])(`${line} 取消后忽略旧 %s 与 default`, async kind => {
      const {pending, decide} = mockPending();
      const {room, sent} = mkHarness();
      room.handleLine(switchRequestLine(9));
      room.handleLine(line);
      expect(decide.mock.calls[0][0].control?.signal?.aborted).toBe(true);
      if (kind === 'result') pending.resolve(decision);
      else pending.reject(new Error('旧任务失败'));
      await flush();
      room.sendDefault();
      expect(sent).toEqual([]);
      expect(room.getSummary().decisions).toBe(0);
    });
  }

  it('显式取消清除去重标记，恢复连接后可重收同一请求', async () => {
    const {pending, decide} = mockPending();
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    room.cancelPendingDecision();
    expect(decide.mock.calls[0][0].control?.signal?.aborted).toBe(true);
    room.handleLine(switchRequestLine(9));
    expect(decide).toHaveBeenCalledTimes(2);
    pending.resolve(decision);
    await flush();
    expect(sent).toEqual([decision.command]);
  });

  it('结束之后的新请求和顶层 default 均不发送', async () => {
    const {decide} = mockPending();
    const {room, sent} = mkHarness();
    room.handleLine('|win|opponent');
    room.handleLine(switchRequestLine(10));
    room.sendDefault();
    await flush();
    expect(decide).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it.each(['result', 'error'])('顶层 default 先取消飞行任务，旧 %s 不再发指令', async kind => {
    const {pending, decide} = mockPending();
    const {room, sent} = mkHarness();
    room.sendDefault();
    expect(sent).toEqual([]);
    room.handleLine(switchRequestLine(9));
    room.sendDefault();
    expect(decide.mock.calls[0][0].control?.signal?.aborted).toBe(true);
    expect(sent).toEqual(['/choose default']);
    if (kind === 'result') pending.resolve(decision);
    else pending.reject(new Error('取消后失败'));
    await flush();
    room.sendDefault();
    room.handleLine(switchRequestLine(9));
    expect(sent).toEqual(['/choose default']);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('当前请求解析失败保留原 default 兜底，但取消旧任务且不重复发送', async () => {
    const {pending, decide} = mockPending();
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    room.handleLine('|request|{bad-json');
    expect(decide.mock.calls[0][0].control?.signal?.aborted).toBe(true);
    expect(sent).toEqual(['/choose default']);
    pending.reject(new Error('旧请求失败'));
    await flush();
    room.handleLine('|request|{bad-json');
    room.sendDefault();
    expect(sent).toEqual(['/choose default']);
  });

  it('当前任务意外异常时只安全发送一次 default', async () => {
    const {pending} = mockPending();
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    pending.reject(new Error('当前失败'));
    await flush();
    room.sendDefault();
    expect(sent).toEqual(['/choose default']);
  });

  it('新请求开始就清除旧 pending，不对旧非法指令重试', async () => {
    const {pending, decide} = mockPending();
    decide.mockResolvedValueOnce(decision).mockReturnValue(pending.promise);
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await flush();
    room.handleLine(switchRequestLine(10));
    room.handleLine('|error|[Invalid choice] old choice');
    expect(decide).toHaveBeenCalledTimes(2);
    pending.resolve(null);
    await flush();
    expect(sent).toEqual([decision.command]);
  });

  it('新 rqid 开始后旧 too late 不取消新决策，且无需补发 request 即可发送', async () => {
    const {pending, decide} = mockPending();
    decide.mockResolvedValueOnce(decision).mockReturnValue(pending.promise);
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await flush();
    expect(sent).toEqual([decision.command]);

    room.handleLine(switchRequestLine(10));
    const newControl = decide.mock.calls[1][0].control;
    room.handleLine('|error|[Invalid choice] Sorry, too late to make a different move; the next turn has already started');
    await flush();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([decision.command]);

    const newCommand = '/choose switch 4, switch 3|10';
    pending.resolve({...decision, command: newCommand});
    await flush();
    expect(sent).toEqual([decision.command, newCommand]);
    expect(newControl?.signal?.aborted).toBe(false);
    expect(room.getSummary()).toMatchObject({decisions: 2, fallbacks: 0});

    room.handleLine(switchRequestLine(10));
    await flush();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([decision.command, newCommand]);
  });

  it('too late 废弃已发送 pending，后续非法错误不能重试', async () => {
    const decide = vi.spyOn(policy, 'decideChoice').mockResolvedValue(decision);
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await flush();
    room.handleLine('|error|[Invalid choice] Sorry, too late');
    room.handleLine('|error|[Invalid choice] old choice');
    await flush();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([decision.command]);
  });

  it.each(['result', 'error'])('本地重试被 wait 取消后忽略旧 %s', async kind => {
    const {pending, decide} = mockPending();
    decide.mockResolvedValueOnce(decision).mockReturnValue(pending.promise);
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await flush();
    room.handleLine('|error|[Invalid choice] rejected');
    expect(decide.mock.calls[1][0].jev).toBeNull();
    expect(decide.mock.calls[1][0].advisor).toBeNull();
    room.handleLine('|request|{"wait":true}');
    if (kind === 'result') pending.resolve(decision);
    else pending.reject(new Error('重试已取消'));
    await flush();
    expect(sent).toEqual([decision.command]);
  });
});

describe('BattleRoom 增量成本', () => {
  it('两路 usage 立即入账，outcome 双成本不重复累加', async () => {
    const {pending, decide} = mockPending();
    const {room} = mkHarness();
    room.handleLine(switchRequestLine(9));
    const ctx = decide.mock.calls[0][0];
    expect(ctx.onUsage).toBeTypeOf('function');
    ctx.onUsage?.({cost: 0.02}, 'advisor');
    expect(room.getSummary().costUsd).toBeCloseTo(0.02);
    ctx.onUsage?.({cost: 0.03}, 'jev');
    pending.resolve({...decision, usage: {cost: 0.03}, advisorUsage: {cost: 0.02},
      advisorLatencyMs: 10, totalLatencyMs: 30});
    await flush();
    expect(room.getSummary().costUsd).toBeCloseTo(0.05);
  });

  it.each([undefined, NaN, Infinity, -Infinity, -1, 0])('只接受已知有限非负成本：%s', async cost => {
    const {pending, decide} = mockPending();
    const {room} = mkHarness();
    room.handleLine(switchRequestLine(9));
    const ctx = decide.mock.calls[0][0];
    ctx.onUsage?.({cost}, 'advisor');
    ctx.onUsage?.({cost: 0.01}, 'jev');
    pending.resolve({...decision, usage: {cost}, advisorUsage: {cost}});
    await flush();
    expect(room.getSummary().costUsd).toBeCloseTo(0.01);
  });

  it('advisor 已完成后取消仍保留账单，不记取消后迟到 usage', async () => {
    const {pending, decide} = mockPending();
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    const ctx = decide.mock.calls[0][0];
    ctx.onUsage?.({cost: 0.02}, 'advisor');
    room.handleLine('|request|{"wait":true}');
    ctx.onUsage?.({cost: 0.03}, 'jev');
    pending.resolve({...decision, usage: {cost: 0.03}, advisorUsage: {cost: 0.02}});
    await flush();
    expect(room.getSummary().costUsd).toBeCloseTo(0.02);
    expect(sent).toEqual([]);
  });
});

describe('BattleRoom 真实 policy 集成（仅替换 advisor/jev 客户端）', () => {
  const cfg: BattleRoomOptions['cfg'] = {
    jevMock: false, sendRqid: true, jevContextLevel: 3,
    jevDecisionBudgetMs: 100, jevAdvisorTimeoutMs: 200,
  };
  const advice: AdvisorResult = {
    text: 'RECOMMEND: switch slot 1 to team 4 and slot 2 to team 3.',
    model: 'test/advisor', latencyMs: 12, usage: {cost: 0.02},
  };
  const answer: DecideResult = {
    answers: {
      switch_slot_1: {type: 'choice', choice: 'switch_4'},
      switch_slot_2: {type: 'choice', choice: 'switch_3'},
    },
    usage: {cost: 0.03}, latencyMs: 7, raw: {},
  };

  it('L3 两路费用分阶段入账，发送真实 jev 动作且不重复计费', async () => {
    vi.useFakeTimers();
    const pendingAdvice = deferred<AdvisorResult | null>();
    const pendingAnswer = deferred<DecideResult>();
    const analyze = vi.fn<AdvisorClient['analyze']>(() => pendingAdvice.promise);
    const decide = vi.fn<JevClient['decide']>(() => pendingAnswer.promise);
    const logDecision = vi.fn();
    const {room, sent} = mkHarness({
      advisor: {analyze}, jev: {decide}, cfg,
      logger: {...nullLogger, decision: logDecision},
    });
    room.handleLine(switchRequestLine(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0][0].kind).toBe('force-switch');
    expect(Object.keys(analyze.mock.calls[0][0].questions)).toEqual(['switch_slot_1', 'switch_slot_2']);
    expect(decide).not.toHaveBeenCalled();
    expect(room.getSummary().costUsd).toBe(0);

    pendingAdvice.resolve(advice);
    await vi.advanceTimersByTimeAsync(0);
    expect(decide).toHaveBeenCalledOnce();
    expect(decide.mock.calls[0][0].state).toMatchObject({advisor_analysis: {text: advice.text}});
    expect(Object.values(decide.mock.calls[0][0].questions).every(q => q.instructions.includes(advice.text))).toBe(true);
    expect(room.getSummary()).toMatchObject({decisions: 0, fallbacks: 0, costUsd: 0.02});
    expect(sent).toEqual([]);

    pendingAnswer.resolve(answer);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['/choose switch 4, switch 3|9']);
    expect(room.getSummary()).toMatchObject({decisions: 1, fallbacks: 0});
    expect(room.getSummary().costUsd).toBeCloseTo(0.05);
    expect(logDecision).toHaveBeenCalledOnce();
    expect(logDecision.mock.calls[0][1]).toMatchObject({
      rqid: 9, context_level: 3, fallback: false,
      advisor_usage: {cost: 0.02}, usage: {cost: 0.03},
    });
    room.handleLine(switchRequestLine(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(analyze).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(room.getSummary().costUsd).toBeCloseTo(0.05);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['result', 'error'])('advisor 在飞时 wait 取消，迟到 %s 不产生旧动作或兜底', async kind => {
    vi.useFakeTimers();
    const pendingAdvice = deferred<AdvisorResult | null>();
    const analyze = vi.fn<AdvisorClient['analyze']>(() => pendingAdvice.promise);
    const decide = vi.fn<JevClient['decide']>(async () => answer);
    const logDecision = vi.fn();
    const {room, sent} = mkHarness({
      advisor: {analyze}, jev: {decide}, cfg,
      logger: {...nullLogger, decision: logDecision},
    });
    room.handleLine(switchRequestLine(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(analyze).toHaveBeenCalledOnce();
    const control = analyze.mock.calls[0][1];
    expect(control?.signal?.aborted).toBe(false);
    expect(decide).not.toHaveBeenCalled();

    room.handleLine('|request|{"wait":true}');
    await vi.advanceTimersByTimeAsync(0);
    expect(control?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    if (kind === 'result') pendingAdvice.resolve(advice);
    else pendingAdvice.reject(new Error('旧 advisor 已取消'));
    await vi.advanceTimersByTimeAsync(101);
    expect(decide).not.toHaveBeenCalled();
    expect(logDecision).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(room.getSummary()).toMatchObject({decisions: 0, fallbacks: 0, costUsd: 0});

    analyze.mockResolvedValueOnce(advice);
    room.handleLine(switchRequestLine(10));
    await vi.advanceTimersByTimeAsync(0);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledOnce();
    expect(sent).toEqual(['/choose switch 4, switch 3|10']);
    expect(logDecision).toHaveBeenCalledOnce();
    expect(logDecision.mock.calls[0][1]).toMatchObject({rqid: 10, fallback: false});
    expect(room.getSummary()).toMatchObject({decisions: 1, fallbacks: 0});
    expect(room.getSummary().costUsd).toBeCloseTo(0.05);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['advisor', 'jev'])('%s 忽略取消时仍按共享总预算及时兜底，迟到结果不再发送或计费', async stage => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const pendingAdvice = deferred<AdvisorResult | null>();
    const pendingAnswer = deferred<DecideResult>();
    const analyze = vi.fn<AdvisorClient['analyze']>(() => pendingAdvice.promise);
    const decide = vi.fn<JevClient['decide']>(() => pendingAnswer.promise);
    const logDecision = vi.fn();
    const {room, sent} = mkHarness({
      advisor: {analyze}, jev: {decide}, cfg,
      logger: {...nullLogger, decision: logDecision},
    });
    room.handleLine(switchRequestLine(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0][1]?.deadlineAt).toBe(10100);
    await vi.advanceTimersByTimeAsync(60);
    if (stage === 'jev') {
      pendingAdvice.resolve(advice);
      await vi.advanceTimersByTimeAsync(0);
      expect(decide).toHaveBeenCalledOnce();
      expect(decide.mock.calls[0][1]?.deadlineAt).toBe(10100);
      expect(room.getSummary().costUsd).toBeCloseTo(0.02);
    }
    await vi.advanceTimersByTimeAsync(39);
    expect(sent).toEqual([]);
    expect(room.getSummary().decisions).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['/choose switch 3, switch 4|9']);
    expect(room.getSummary()).toMatchObject({decisions: 1, fallbacks: 1});
    expect(room.getSummary().costUsd).toBeCloseTo(stage === 'jev' ? 0.02 : 0);
    const control = stage === 'jev' ? decide.mock.calls[0][1] : analyze.mock.calls[0][1];
    expect(control?.signal?.aborted).toBe(true);
    expect(logDecision).toHaveBeenCalledOnce();
    expect(logDecision.mock.calls[0][1]).toMatchObject({rqid: 9, fallback: true, total_latency_ms: 100});
    expect(vi.getTimerCount()).toBe(0);

    pendingAdvice.resolve(advice);
    pendingAnswer.resolve(answer);
    await vi.advanceTimersByTimeAsync(101);
    room.handleLine(switchRequestLine(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['/choose switch 3, switch 4|9']);
    expect(analyze).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledTimes(stage === 'jev' ? 1 : 0);
    expect(logDecision).toHaveBeenCalledOnce();
    expect(room.getSummary()).toMatchObject({decisions: 1, fallbacks: 1});
    expect(room.getSummary().costUsd).toBeCloseTo(stage === 'jev' ? 0.02 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('BattleRoom 非法指令恢复', () => {
  it('收到 [Invalid choice] 后用本地启发式重发修正指令（同 rqid）', async () => {
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toBe('/choose switch 3, switch 4|9');
    const parts = /\/choose switch (\d), switch (\d)\|9/.exec(sent[0]);
    expect(parts).not.toBeNull();
    expect(parts![1]).not.toBe(parts![2]); // 两个槽位必须是不同替补（服务器拒绝 can only switch in once）

    room.handleLine("|error|[Invalid choice] Can't switch: The Pokémon in slot 3 can only switch in once");
    await waitFor(() => sent.length === 2);
    expect(sent[1]).toBe('/choose switch 3, switch 4|9');

    // 重试次数用尽后发 default，绝不让计时器判负
    room.handleLine("|error|[Invalid choice] Can't switch: The Pokémon in slot 3 can only switch in once");
    await waitFor(() => sent.length === 3);
    expect(sent[2]).toBe('/choose default');
  });

  it('"too late" 错误不触发重发，也不依赖服务器补发 request', async () => {
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await waitFor(() => sent.length === 1);
    room.handleLine('|error|[Invalid choice] Sorry, too late to make a different move; the next turn has already started');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(sent.length).toBe(1);
  });
});
