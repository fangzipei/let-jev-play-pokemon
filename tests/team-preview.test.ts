import {describe, expect, it} from 'vitest';
import {buildPreviewQuestions, previewSlotScores, resolvePreviewOrder, slotRoleVector} from '../src/decide/team-preview.js';
import type {Answer} from '../src/jev/types.js';
import {buildAnalysisContext} from '../src/state/analysis.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

const dex = mkDex();

describe('previewSlotScores', () => {
  it('逐槽取四题 probabilities 的最大值', () => {
    const answers: Record<string, Answer> = {
      lead_1: {type: 'choice', choice: 'slot_1', probabilities: {slot_1: 0.7, slot_2: 0.2}},
      lead_2: {type: 'choice', choice: 'slot_2', probabilities: {slot_2: 0.6, slot_1: 0.3}},
      bring_3: {type: 'choice', choice: 'slot_6', probabilities: {slot_6: 0.5, slot_4: 0.3, slot_3: 0.2}},
      bring_4: {type: 'choice', choice: 'slot_4', probabilities: {slot_4: 0.5, slot_5: 0.3, slot_6: 0.2}},
    };
    expect(previewSlotScores(answers)).toEqual({1: 0.7, 2: 0.6, 3: 0.2, 4: 0.5, 5: 0.3, 6: 0.5});
  });

  it('缺 probabilities 或非 choice 答案时跳过对应题目', () => {
    expect(previewSlotScores({
      lead_1: {type: 'choice', choice: 'slot_1'},
      lead_2: {type: 'noul', noul: 1},
      bring_3: {type: 'choice', choice: 'slot_3', probabilities: {slot_3: 0.4}},
    })).toEqual({3: 0.4});
  });

  it('非 slot 键被忽略', () => {
    expect(previewSlotScores({
      lead_1: {type: 'choice', choice: 'slot_1', probabilities: {slot_1: 0.5, other: 0.9, slot_x: 0.8}},
    })).toEqual({1: 0.5});
  });

  it('无可用答案时返回空对象', () => {
    expect(previewSlotScores({})).toEqual({});
  });
});

describe('preview 防重复与反事实引导', () => {
  const previewRequest = () => mkRequest({teamPreview: true});

  it('批次简报说明重复答案会被替换，并要求改用下一顺位', () => {
    const {briefing} = buildPreviewQuestions({dex, request: previewRequest(), opponentPreviewSpecies: ['Charizard']});
    expect(briefing).toContain('Never answer with a Pokemon already used in this batch');
    expect(briefing).toContain('a repeated answer wastes the question because it will be replaced');
  });

  it('lead_2/bring_3/bring_4 各自声明与其它答案的差异要求', () => {
    const {questions} = buildPreviewQuestions({dex, request: previewRequest(), opponentPreviewSpecies: ['Charizard']});
    expect(questions.lead_2.instructions).toContain('a DIFFERENT Pokemon than your first lead');
    expect(questions.bring_3.instructions).toContain('a Pokemon you have not answered with in the other questions');
    expect(questions.bring_4.instructions).toContain('It must differ from your other three answers');
  });

  it('L2 简报加入反事实覆盖自查，L1 不输出', () => {
    const request = previewRequest();
    const state = mkTracker().state;
    const l2 = buildAnalysisContext({dex, request, state, level: 2});
    const l2Briefing = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard'], analysis: l2}).briefing;
    expect(l2Briefing).toContain('run one counterfactual');
    expect(l2Briefing).toContain('swap it back in');
    const l1 = buildAnalysisContext({dex, request, state, level: 1});
    const l1Briefing = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard'], analysis: l1}).briefing;
    expect(l1Briefing).not.toContain('counterfactual');
  });

  it('双 Mega 时 megaAdvice 补充入场效果引导句（Intimidate / Tailwind / 消耗战）', () => {
    const request = previewRequest();
    const state = mkTracker().state;
    const l2 = buildAnalysisContext({dex, request, state, level: 2});
    const briefing = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard'], analysis: l2}).briefing;
    expect(briefing).toContain('entry effect blunts the foe');
    expect(briefing).toContain('Intimidate');
    expect(briefing).toContain('Tailwind');
    expect(briefing).toContain('attrition matchups');
  });
});

describe('slotRoleVector', () => {
  const request = mkRequest({teamPreview: true});
  const roles = slotRoleVector(dex, request);

  it('按能力与招式打标签：terrain/weather/intimidate/support/speed_control/physical/special', () => {
    // Golisopod: emergencyexit 不计，四招里三招 80+ Physical，Sucker Punch 70<75 → 只 physical
    expect(roles[1]).toEqual(new Set(['physical']));
    // Chandelure: flashfire 不计，shadowball/heatwave 80+/95 Special，trickroom 属 speed_control
    expect(roles[2]).toEqual(new Set(['special', 'speed_control']));
    // Tyranitar: sandstream → weather；rockslide/icepunch/firepunch 75+ Physical
    expect(roles[3]).toEqual(new Set(['weather', 'physical']));
    // Salamence: intimidate；hypervoice/dracometeor/flamethrower Special ≥75
    expect(roles[4]).toEqual(new Set(['intimidate', 'special']));
  });

  it('支持招（Follow Me/Fake Out/Wide Guard 等）触发 support 标签', () => {
    const request2 = mkRequest({teamPreview: true});
    request2.side.pokemon[1] = {...request2.side.pokemon[1], moves: ['followme', 'fakeout', 'wideguard', 'protect']};
    const r = slotRoleVector(dex, request2);
    expect(r[2]!.has('support')).toBe(true);
  });
});

describe('resolvePreviewOrder 角色互补修正', () => {
  const request = mkRequest({teamPreview: true});
  const slotRoles = slotRoleVector(dex, request);

  it('lead_2 重复时优先补入无角色重叠的槽位（即使 raw 概率更低）', () => {
    // lead_1 = slot_2 (Chandelure: special+speed_control)；lead_2 raw 仍回 slot_2 → 修正
    // 候选：slot_4 Salamence (intimidate+special) prob 0.20，与 Chandelure 在 special 上重叠 -0.15 → 0.05
    //       slot_3 Tyranitar (weather+physical) prob 0.15，无重叠 → 0.15
    //       slot_1 Golisopod (physical) prob 0.10，无重叠 → 0.10
    // 修正应选 slot_3，而不是 raw argmax slot_4
    const answers: Record<string, Answer> = {
      lead_1: {type: 'choice', choice: 'slot_2', probabilities: {slot_2: 0.6}},
      lead_2: {type: 'choice', choice: 'slot_2', probabilities: {slot_4: 0.20, slot_3: 0.15, slot_1: 0.10}},
      bring_3: {type: 'choice', choice: 'slot_5', probabilities: {slot_5: 0.5}},
      bring_4: {type: 'choice', choice: 'slot_6', probabilities: {slot_6: 0.5}},
    };
    const {order, adjusted} = resolvePreviewOrder(answers, undefined, slotRoles);
    expect(order[1]).toBe(3);
    expect(adjusted).toContain('lead_2: slot_3');
  });

  it('不传 slotRoles 时退化为纯 probabilities argmax（向后兼容）', () => {
    const answers: Record<string, Answer> = {
      lead_1: {type: 'choice', choice: 'slot_2', probabilities: {slot_2: 0.6}},
      lead_2: {type: 'choice', choice: 'slot_2', probabilities: {slot_4: 0.20, slot_3: 0.15, slot_1: 0.10}},
      bring_3: {type: 'choice', choice: 'slot_5', probabilities: {slot_5: 0.5}},
      bring_4: {type: 'choice', choice: 'slot_6', probabilities: {slot_6: 0.5}},
    };
    const {order, adjusted} = resolvePreviewOrder(answers);
    expect(order[1]).toBe(4);
    expect(adjusted).toContain('lead_2: slot_4');
  });

  it('原始答案不重复时不触发修正，不受角色 penalty 影响', () => {
    const answers: Record<string, Answer> = {
      lead_1: {type: 'choice', choice: 'slot_2', probabilities: {slot_2: 0.6}},
      lead_2: {type: 'choice', choice: 'slot_3', probabilities: {slot_3: 0.5}},
      bring_3: {type: 'choice', choice: 'slot_4', probabilities: {slot_4: 0.5}},
      bring_4: {type: 'choice', choice: 'slot_1', probabilities: {slot_1: 0.5}},
    };
    const {order, adjusted} = resolvePreviewOrder(answers, undefined, slotRoles);
    expect(order).toEqual([2, 3, 4, 1]);
    expect(adjusted).toEqual([]);
  });
});
