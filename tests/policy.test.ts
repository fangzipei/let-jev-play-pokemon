import {afterEach, describe, expect, it, vi} from 'vitest';
import type {AdvisorClient} from '../src/jev/advisor.js';
import {decideChoice, type DecisionContext} from '../src/decide/policy.js';
import {parsePikaList, pikaToPriors, type PikaMeta} from '../src/dex/pikalytics.js';
import type {DecideInput, JevClient} from '../src/jev/client.js';
import type {Answer} from '../src/jev/types.js';
import {nullLogger, type Logger} from '../src/log/logger.js';
import type {BattleRequest} from '../src/state/request.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

function mkJev(answers: Record<string, Answer> | ((input: DecideInput) => Record<string, Answer>)): JevClient {
  return {
    async decide(input) {
      const out = typeof answers === 'function' ? answers(input) : answers;
      return {answers: out, usage: {cost: 0.001, input_tokens: 120, output_tokens: 30}, latencyMs: 7, raw: {}};
    },
  };
}

function mkThrowingJev(): JevClient {
  return {
    async decide() {
      throw new Error('network down');
    },
  };
}

function mkCtx(opts: {
  request?: BattleRequest;
  jev?: JevClient | null;
  jevMock?: boolean;
  logger?: Logger;
} = {}): DecisionContext {
  return {
    dex: mkDex(),
    request: opts.request ?? mkRequest(),
    tracker: mkTracker(),
    jev: opts.jev ?? null,
    logger: opts.logger ?? nullLogger,
    battleId: 'battle-test-1',
    cfg: {jevMock: opts.jevMock ?? false, sendRqid: true},
  };
}

describe('整局上下文接线', () => {
  it.each([1, 2, 3] as const)('L%s 连续请求携带已执行双方历史，不把本地选择当作成功动作', async level => {
    const captured: any[] = [];
    const entries: any[] = [];
    const ctx = mkCtx({logger: {...nullLogger, decision: (_id, e) => entries.push(e)}, jev: mkJev(input => {
      captured.push(input);
      return {action_slot_1: {type: 'choice', choice: 'move_1_foe_a'}};
    })});
    ctx.cfg.jevContextLevel = level;
    await decideChoice(ctx);
    ctx.tracker.handleLine('|cant|p1a: Golisopod|flinch');
    ctx.tracker.handleLine('|move|p2a: Victreebel|Sleep Powder|p1b: Chandelure');
    ctx.tracker.handleLine('|-status|p1b: Chandelure|slp');
    ctx.tracker.handleLine('|turn|2');
    ctx.request = {...ctx.request, rqid: 8};
    await decideChoice(ctx);
    expect(captured).toHaveLength(2);
    expect(captured[1].state.battle_context).toBeDefined();
    const context = captured[1].state.battle_context;
    expect(context.turn).toBe(2);
    expect(context.recent_turns[0].events).toEqual([
      '|cant|p1a: Golisopod|flinch', '|move|p2a: Victreebel|Sleep Powder|p1b: Chandelure',
      '|-status|p1b: Chandelure|slp',
    ]);
    expect(JSON.stringify(context.recent_turns)).not.toContain('Iron Head');
    expect(captured[0].state.battle_context.turn).toBe(1);
    expect(entries[1].state.battle_context).toEqual(context);
  });

  it('L2 与 L3 局内上下文同源，advisor 等待期间新增事件不污染当前快照', async () => {
    const payloads: any[] = [];
    const ctx = mkCtx({jev: mkJev(input => { payloads.push(structuredClone(input)); return {}; })});
    ctx.cfg.jevContextLevel = 2;
    await decideChoice(ctx);
    let advisorSnapshot: any;
    ctx.cfg.jevContextLevel = 3;
    ctx.advisor = {analyze: async input => {
      advisorSnapshot = structuredClone(input.state);
      ctx.tracker.handleLine('|move|p2b: Charizard|Heat Wave|p1a: Golisopod');
      ctx.tracker.handleLine('|turn|2');
      return {text: 'Keep the endgame in mind.', model: 'test', latencyMs: 1, usage: {}};
    }};
    await decideChoice(ctx);
    expect(advisorSnapshot.battle_context).toBeDefined();
    expect(advisorSnapshot).toEqual(payloads[0].state);
    const {advisor_analysis, ...state} = payloads[1].state;
    expect(state).toEqual(payloads[0].state);
    expect(advisor_analysis.text).toContain('endgame');
    expect(state.battle_context.turn).toBe(1);
    expect(JSON.stringify(state.battle_context.recent_turns)).not.toContain('Heat Wave');
    expect(ctx.tracker.state.turn).toBe(2);
  });
});

describe('三级上下文与辅助分析接线', () => {
  afterEach(() => vi.useRealTimers());
  const advice = {text: 'RECOMMEND: consider the sand pair against this preview.', model: 'test/advisor', latencyMs: 12, usage: {cost: 0.004, input_tokens: 300, output_tokens: 30}};

  it.each(['team-preview', 'turn', 'force-switch'] as const)('%s 将完整状态与合法选项送给 advisor，再交给 jev', async kind => {
    const request = mkRequest();
    if (kind === 'team-preview') { request.teamPreview = true; request.active = undefined; }
    if (kind === 'force-switch') { request.forceSwitch = [true, false]; request.active = undefined; }
    const analyze = vi.fn<AdvisorClient['analyze']>(async input => {
      expect(input.kind).toBe(kind);
      expect(Object.keys(input.questions).length).toBeGreaterThan(0);
      const state = input.state as any;
      expect(state.sides.ours.preview[0].moves.length).toBeGreaterThan(0);
      expect(state.sides.ours.preview[0].stats).toBeDefined();
      expect(state.sides.ours.team_notes.length).toBeGreaterThan(0);
      expect(state.advisor_analysis).toBeUndefined();
      expect(state.battle_context).toMatchObject({phase: kind, turn: 1});
      expect(Object.values(input.questions).every(q => q.instructions.includes('win the entire battle'))).toBe(true);
      return advice;
    });
    const entries: any[] = [];
    const onUsage = vi.fn();
    const ctx = mkCtx({request, logger: {...nullLogger, decision: (_id, e) => entries.push(e)}, jev: mkJev(input => {
      expect(analyze).toHaveBeenCalledTimes(1);
      expect((input.state as any).advisor_analysis.text).toBe(advice.text);
      expect(Object.values(input.questions).every(q => q.instructions.includes('Coach analysis:'))).toBe(true);
      return {};
    })});
    ctx.cfg.jevContextLevel = 3;
    ctx.advisor = {analyze};
    ctx.onUsage = onUsage;
    const result = await decideChoice(ctx);
    expect(result?.advisorUsage?.cost).toBe(0.004);
    expect(result?.advisorLatencyMs).toBe(12);
    expect(onUsage.mock.calls.map(c => c[1])).toEqual(['advisor', 'jev']);
    expect(entries[0].advisor_usage.cost).toBe(0.004);
    expect(entries[0].total_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it.each([1, 2] as const)('L%s 不调用 advisor，仍有基础分析', async level => {
    const analyze = vi.fn();
    let captured: any;
    const ctx = mkCtx({jev: mkJev(input => { captured = input.state; return {}; })});
    ctx.cfg.jevContextLevel = level;
    ctx.advisor = {analyze};
    await decideChoice(ctx);
    expect(captured.sides.ours.preview[0].speed).toBeDefined();
    expect(captured.sides.ours.team_notes !== undefined).toBe(level === 2);
    expect(captured.advisor_analysis).toBeUndefined();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('mock 模式下 L3 也不调用任何模型', async () => {
    const ctx = mkCtx({jevMock: true});
    ctx.cfg.jevContextLevel = 3;
    ctx.advisor = {analyze: vi.fn()};
    await decideChoice(ctx);
    expect(ctx.advisor.analyze).not.toHaveBeenCalled();
  });

  it.each(['null', 'throw', 'timeout'])('advisor %s 后按 L2 继续，jev 仍可成功', async mode => {
    vi.useFakeTimers();
    const decide = vi.fn<JevClient['decide']>(async () => ({answers: {action_slot_1: {type: 'choice', choice: 'move_1_foe_a'}}, usage: {}, latencyMs: 1, raw: {}}));
    const ctx = mkCtx({jev: {decide}});
    ctx.cfg = {...ctx.cfg, jevContextLevel: 3, jevAdvisorTimeoutMs: 10};
    ctx.advisor = {analyze: async () => {
      if (mode === 'throw') throw new Error('offline');
      if (mode === 'timeout') return new Promise(() => {});
      return null;
    }};
    const pending = decideChoice(ctx);
    await vi.advanceTimersByTimeAsync(11);
    expect((await pending)?.fallback).toBe(false);
    expect(decide).toHaveBeenCalledOnce();
    expect((decide.mock.calls[0][0].state as any).advisor_analysis).toBeUndefined();
  });

  it('advisor 无分析文本仍计费，但不向 jev 注入空建议', async () => {
    let captured: any;
    const ctx = mkCtx({jev: mkJev(input => { captured = input; return {}; })});
    const onUsage = vi.fn();
    ctx.cfg.jevContextLevel = 3;
    ctx.advisor = {analyze: async () => ({...advice, text: ''})};
    ctx.onUsage = onUsage;
    const result = await decideChoice(ctx);
    expect(result?.advisorUsage?.cost).toBe(0.004);
    expect(captured.state.advisor_analysis).toBeUndefined();
    expect(Object.values(captured.questions).every((q: any) => !q.instructions.includes('Coach analysis:'))).toBe(true);
    expect(onUsage.mock.calls.map(c => c[1])).toEqual(['advisor', 'jev']);
  });

  it('advisor 等待期间 tracker 变化不改变传给两个模型的快照', async () => {
    let captured: any;
    const ctx = mkCtx({jev: mkJev(input => { captured = input.state; return {}; })});
    ctx.cfg.jevContextLevel = 3;
    ctx.advisor = {analyze: async () => {
      ctx.tracker.state.fieldConditions.push('move: Trick Room');
      return advice;
    }};
    await decideChoice(ctx);
    expect(captured.field).not.toContain('move: Trick Room');
    expect(ctx.tracker.state.fieldConditions).toContain('move: Trick Room');
  });

  it('jev 失败仍保留已完成的 advisor 费用和日志', async () => {
    const ctx = mkCtx({jev: mkThrowingJev()});
    ctx.cfg.jevContextLevel = 3;
    ctx.advisor = {analyze: async () => advice};
    const result = await decideChoice(ctx);
    expect(result?.fallback).toBe(true);
    expect(result?.advisorUsage?.cost).toBe(0.004);
  });

  it('不服从取消信号的客户端也受决策总预算约束', async () => {
    vi.useFakeTimers();
    const ctx = mkCtx({jev: {decide: () => new Promise(() => {})}});
    ctx.cfg.jevDecisionBudgetMs = 30;
    const pending = decideChoice(ctx);
    await vi.advanceTimersByTimeAsync(31);
    expect((await pending)?.fallback).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('取消旧请求不记录决策、不执行本地兜底', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const decision = vi.fn();
    const ctx = mkCtx({jev: {decide: () => new Promise(() => {})}, logger: {...nullLogger, decision}});
    ctx.control = {signal: controller.signal};
    const pending = decideChoice(ctx);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await pending).toBeNull();
    expect(decision).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('decideChoice - turn', () => {
  it('应用 jev 答案生成指令', async () => {
    const ctx = mkCtx({
      jev: mkJev({
        action_slot_1: {type: 'choice', choice: 'move_1_foe_a', confidence: 0.84},
        action_slot_2: {type: 'choice', choice: 'move_1_foe_a', confidence: 0.7},
      }),
    });
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose move 1 +1, move 1 +1|7');
    expect(outcome?.fallback).toBe(false);
    expect(outcome?.adjusted).toEqual([]);
  });

  it('缺失答案的槽位用本地兜底补齐', async () => {
    const ctx = mkCtx({
      jev: mkJev({
        action_slot_2: {type: 'choice', choice: 'move_4', confidence: 0.6},
      }),
    });
    const outcome = await decideChoice(ctx);
    // 槽位 1 无答案 → 兜底 Iron Head +1；槽位 2 → Trick Room（无目标）
    expect(outcome?.command).toBe('/choose move 1 +1, move 4|7');
    expect(outcome?.adjusted).toContain('missing:action_slot_1');
    expect(outcome?.fallback).toBe(false);
  });

  it('非法 choice 用 probabilities 降级到合法项', async () => {
    const ctx = mkCtx({
      jev: mkJev({
        action_slot_1: {
          type: 'choice', choice: 'bogus',
          probabilities: {bogus: 0.5, move_2_foe_b: 0.4, move_1_foe_a: 0.1},
        },
        action_slot_2: {type: 'choice', choice: 'move_1_foe_a'},
      }),
    });
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose move 2 +2, move 1 +1|7');
    expect(outcome?.adjusted).toContain('adjusted:action_slot_1: move_2_foe_b');
  });

  it('单槽位 Mega 正常附加 mega 标记', async () => {
    const ctx = mkCtx({
      jev: mkJev({
        action_slot_1: {type: 'choice', choice: 'move_1_foe_a_mega', confidence: 0.9},
        action_slot_2: {type: 'choice', choice: 'move_1_foe_a', confidence: 0.6},
      }),
    });
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose move 1 +1 mega, move 1 +1|7');
    expect(outcome?.fallback).toBe(false);
  });

  it('两槽位同时 Mega：保留 confidence 更高者，另一槽位降级', async () => {
    const request = mkRequest();
    request.active![1].canMegaEvo = true;
    const ctx = mkCtx({
      request,
      jev: mkJev({
        action_slot_1: {type: 'choice', choice: 'move_1_foe_a_mega', confidence: 0.9},
        action_slot_2: {type: 'choice', choice: 'move_1_foe_a_mega', confidence: 0.5},
      }),
    });
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose move 1 +1 mega, move 1 +1|7');
    expect(outcome?.adjusted.some(s => s.includes('mega-conflict'))).toBe(true);
  });

  it('jev 抛错时整体走本地兜底', async () => {
    const ctx = mkCtx({jev: mkThrowingJev()});
    const outcome = await decideChoice(ctx);
    expect(outcome?.fallback).toBe(true);
    // 本地兜底：槽位 1 Iron Head +1；槽位 2 Heat Wave spread 伤害最高（无目标）
    expect(outcome?.command).toBe('/choose move 1 +1, move 2|7');
  });

  it('JEV_MOCK=1 直接走本地兜底', async () => {
    const ctx = mkCtx({jev: null, jevMock: true});
    const outcome = await decideChoice(ctx);
    expect(outcome?.fallback).toBe(true);
    expect(outcome?.command).toBe('/choose move 1 +1, move 2|7');
  });

  it('fainted 槽位不生成动作，让服务器 auto-pass（避免动作错位）', async () => {
    const request = mkRequest();
    request.side.pokemon[0].condition = '0 fnt';
    const ctx = mkCtx({request, jevMock: true});
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose move 2|7');
  });

  it('request.wait 时返回 null', async () => {
    const ctx = mkCtx({request: mkRequest({wait: true})});
    expect(await decideChoice(ctx)).toBeNull();
  });

  it('把决策写入 logger.decision', async () => {
    const entries: Record<string, unknown>[] = [];
    const logger: Logger = {
      ...nullLogger,
      decision: (_battleId, entry) => {
        entries.push(entry);
      },
    };
    const ctx = mkCtx({
      logger,
      jev: mkJev({
        action_slot_1: {type: 'choice', choice: 'move_1_foe_a'},
        action_slot_2: {type: 'choice', choice: 'move_1_foe_a'},
      }),
    });
    await decideChoice(ctx);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe('turn');
    expect(entries[0].rqid).toBe(7);
    expect(entries[0].answers).toBeDefined();
  });
});

describe('decideChoice - team preview', () => {
  it('生成 4 选带入顺序并补足 6 位', async () => {
    const request = mkRequest({teamPreview: true});
    request.active = undefined;
    const ctx = mkCtx({
      request,
      jev: mkJev({
        lead_1: {type: 'choice', choice: 'slot_5', confidence: 0.8},
        lead_2: {type: 'choice', choice: 'slot_2', confidence: 0.7},
        bring_3: {type: 'choice', choice: 'slot_3', confidence: 0.6},
        bring_4: {type: 'choice', choice: 'slot_1', confidence: 0.6},
      }),
    });
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose team 523146|7');
    expect(outcome?.fallback).toBe(false);
  });

  it('重复选择时用 probabilities / 首个未用槽位去重', async () => {
    const request = mkRequest({teamPreview: true});
    request.active = undefined;
    const ctx = mkCtx({
      request,
      jev: mkJev({
        lead_1: {type: 'choice', choice: 'slot_1', confidence: 0.8},
        lead_2: {type: 'choice', choice: 'slot_1', probabilities: {slot_1: 0.7, slot_4: 0.3}},
        bring_3: {type: 'choice', choice: 'slot_2', confidence: 0.6},
        bring_4: {type: 'choice', choice: 'slot_3', confidence: 0.5},
      }),
    });
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose team 142356|7');
  });

  it('没有任何答案时走本地兜底', async () => {
    const request = mkRequest({teamPreview: true});
    request.active = undefined;
    const ctx = mkCtx({request, jev: mkJev({})});
    const outcome = await decideChoice(ctx);
    expect(outcome?.fallback).toBe(true);
    expect(outcome?.command).toBe('/choose team 123456|7');
  });
});

describe('decideChoice - force switch', () => {
  const mkSwitchRequest = (): BattleRequest => {
    const request = mkRequest();
    request.active = undefined;
    request.forceSwitch = [true, false];
    return request;
  };

  it('应用 jev 换人答案，其余槽位 pass', async () => {
    const ctx = mkCtx({
      request: mkSwitchRequest(),
      jev: mkJev({
        switch_slot_1: {type: 'choice', choice: 'switch_4', confidence: 0.72},
      }),
    });
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose switch 4, pass|7');
    expect(outcome?.fallback).toBe(false);
  });

  it('没有答案时使用本地兜底（血厚且被克制少的替补）', async () => {
    const ctx = mkCtx({request: mkSwitchRequest(), jev: mkJev({})});
    const outcome = await decideChoice(ctx);
    expect(outcome?.fallback).toBe(true);
    expect(outcome?.command).toBe('/choose switch 4, pass|7');
  });

  it('双槽位选中同一替补时自动去重（服务器拒绝 can only switch in once）', async () => {
    const request = mkRequest();
    request.active = undefined;
    request.forceSwitch = [true, true];
    const ctx = mkCtx({
      request,
      jev: mkJev({
        switch_slot_1: {type: 'choice', choice: 'switch_3', confidence: 0.7},
        switch_slot_2: {type: 'choice', choice: 'switch_3', probabilities: {switch_3: 0.5, switch_4: 0.4}},
      }),
    });
    const outcome = await decideChoice(ctx);
    expect(outcome?.command).toBe('/choose switch 3, switch 4|7');
    expect(outcome?.adjusted).toContain('adjusted:switch_slot_2: switch_4');
    expect(outcome?.fallback).toBe(false);
  });
});

describe('对手注解与经验注入接线', () => {
  const priors = pikaToPriors(parsePikaList([{
    name: 'Victreebel', rank: '5', percent: '10', winPercent: '50', stats: {spe: 70},
    abilities: [{ability: 'Chlorophyll', percent: '60'}], items: [{item: 'Focus Sash', percent: '40'}],
    moves: [{move: 'Sludge Bomb', percent: '70'}], team: [], leads: [],
  }], '2026-05', 'f') as PikaMeta);

  it('L2 注入对手 notes；L1 不注入；priors/memory 缺省时仍给 confirmed', async () => {
    let captured: any;
    const ctx = mkCtx({jev: mkJev(input => {captured = input.state; return {};})});
    ctx.cfg.jevContextLevel = 2;
    ctx.priors = priors;
    await decideChoice(ctx);
    expect(captured.sides.opponent.active[0].notes.assumed.join(' ')).toContain('Chlorophyll');

    let l1: any;
    const ctxL1 = mkCtx({jev: mkJev(input => {l1 = input.state; return {};})});
    ctxL1.cfg.jevContextLevel = 1;
    ctxL1.priors = priors;
    await decideChoice(ctxL1);
    expect(l1.sides.opponent.active[0]).not.toHaveProperty('notes');

    let basic: any;
    const ctxBasic = mkCtx({jev: mkJev(input => {basic = input.state; return {};})});
    ctxBasic.cfg.jevContextLevel = 2;
    await decideChoice(ctxBasic);
    expect(basic.sides.opponent.active[0]).not.toHaveProperty('notes');
  });

  it('team-preview 时对手首发先验进入 questions', async () => {
    const request = mkRequest();
    request.teamPreview = true;
    request.active = undefined;
    let captured: any;
    const ctx = mkCtx({request, jev: mkJev(input => {captured = input.questions; return {};})});
    ctx.cfg.jevContextLevel = 2;
    ctx.priors = pikaToPriors(parsePikaList([{
      name: 'Sneasler', rank: '2', percent: '30', winPercent: '50', stats: {spe: 120},
      abilities: [], items: [], moves: [], team: [], leads: [{pokemon: 'Sneasler', percent: '14.3'}],
    }], '2026-05', 'f'));
    await decideChoice(ctx);
    expect(captured.lead_1.instructions).toContain('Sneasler 14.3%');
  });
});
