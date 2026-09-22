import {describe, expect, it} from 'vitest';
import {decideChoice, type DecisionContext} from '../src/decide/policy.js';
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
});
