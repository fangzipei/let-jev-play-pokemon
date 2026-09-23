import {describe, expect, it} from 'vitest';
import {buildTurnPlans, megaNameOf} from '../src/decide/turn.js';
import {buildPreviewQuestions, PREVIEW_QUESTION_NAMES} from '../src/decide/team-preview.js';
import {buildSwitchPlans} from '../src/decide/force-switch.js';
import {buildAnalysisContext} from '../src/state/analysis.js';
import {BattleTracker} from '../src/state/tracker.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

const dex = mkDex();

describe('三类构造器复用分析', () => {
  it('Mega 形态名称必须匹配当前石头和基础形态，缺数据标 unknown', () => {
    const data = mkDex();
    data.species.charizardmegax = {...data.species.charizard, name: 'Charizard-Mega-X', baseSpecies: 'Charizard', requiredItem: 'Charizardite X'};
    data.species.charizardmegay = {...data.species.charizard, name: 'Charizard-Mega-Y', baseSpecies: 'Charizard', requiredItem: 'Charizardite Y'};
    expect(megaNameOf(data, 'Charizard', 'charizarditey')).toBe('Charizard-Mega-Y');
    expect(megaNameOf(data, 'Salamence-Mega', 'salamencite')).toBe('Salamence-Mega');
    expect(megaNameOf(data, 'Missingno', 'missingstone')).toMatch(/unknown/i);
    const request = mkRequest();
    request.side.pokemon[0].details = 'Charizard, L50';
    request.side.pokemon[0].item = 'charizarditey';
    const mega = buildTurnPlans({dex: data, request, tracker: mkTracker()})[0].options.find(o => o.key === 'move_1_foe_a_mega');
    expect(mega?.label).toContain('Charizard-Mega-Y');
  });
  it('preview 四题同批独立描述组合意图，不声称看到前题答案且保持 keys', () => {
    const request = mkRequest({teamPreview: true});
    const result = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard']});
    expect(Object.keys(result.questions)).toEqual([...PREVIEW_QUESTION_NAMES]);
    for (const question of Object.values(result.questions)) {
      expect(question.instructions).toMatch(/independent.*same batch/i);
      expect(question.instructions).toMatch(/coherent.*four/i);
      expect(question.instructions).not.toMatch(/already.chosen|already.picked|previous answer/i);
      expect(Object.keys((question as any).criteria)).toEqual(['slot_1', 'slot_2', 'slot_3', 'slot_4']);
    }
    expect(result.questions.lead_2.instructions).toMatch(/complementary partner/i);
  });
  it('同一 analysis 透传 preview 与普通回合，描述使用传入数据而非重新构造', () => {
    const request = mkRequest();
    const tracker = mkTracker();
    const analysis = buildAnalysisContext({dex, request, state: tracker.state, level: 2});
    analysis.ourSpeeds[0].speed = 321;
    analysis.teamNotes[0].notes = ['current request role marker'];
    const preview = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard'], analysis});
    expect(preview.descriptionByKey.slot_1).toContain('estimated speed 321');
    expect(preview.descriptionByKey.slot_1).toContain('role: current request role marker');
    expect(preview.questions.lead_1.instructions).toContain('Vary your leads');
    const plans = buildTurnPlans({dex, request, tracker, analysis});
    expect(plans[0].options.find(o => o.key === 'move_1_foe_a')?.label).toContain('estimated speed 321');
    const legacy = buildTurnPlans({dex, request, tracker});
    expect(plans.map(p => p.options.map(o => ({key: o.key, action: o.action})))).toEqual(legacy.map(p => p.options.map(o => ({key: o.key, action: o.action}))));
  });
  it('普通回合换人也复用 incoming，保留自愿换人的行动代价', () => {
    const request = mkRequest();
    const tracker = mkTracker();
    const analysis = buildAnalysisContext({dex, request, state: tracker.state, level: 1});
    analysis.threats[2].incoming[0].roughPercent = 63;
    const option = buildTurnPlans({dex, request, tracker, analysis})[0].options.find(o => o.key === 'switch_3');
    expect(option?.label).toContain('incoming ≈63%');
    expect(option?.label).toContain('costs your action this turn');
  });
  it('强制换人复用分析，不说消耗行动，也不假定一定因倒下或在回合间发生', () => {
    const request = mkRequest({forceSwitch: [true, false]});
    const tracker = mkTracker();
    const analysis = buildAnalysisContext({dex, request, state: tracker.state, level: 2});
    analysis.threats[2].incoming[0].roughPercent = 64;
    const plans = buildSwitchPlans({dex, request, tracker, analysis});
    expect(plans.map(p => p.questionName)).toEqual(['switch_slot_1']);
    expect(plans[0].options.find(o => o.key === 'switch_3')?.label).toContain('incoming ≈64%');
    expect(JSON.stringify(plans)).not.toMatch(/costs your action|uses.*action|fainted and|before the next turn/);
    expect(plans[0].options[0].label).toContain('forced replacement');
    const legacy = buildSwitchPlans({dex, request, tracker});
    expect(legacy[0].options[0].label).not.toContain('costs your action');
    expect(plans.map(p => p.options.map(o => o.action))).toEqual(legacy.map(p => p.options.map(o => o.action)));
  });
  it('L1 和默认 preview 不带角色或 L2 策略引导', () => {
    const request = mkRequest();
    const state = mkTracker().state;
    const analysis = buildAnalysisContext({dex, request, state, level: 1});
    const preview = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard'], analysis});
    expect(preview.descriptionByKey.slot_1).toContain('estimated speed');
    expect(preview.descriptionByKey.slot_1).not.toContain('role:');
    expect(preview.questions.lead_1.instructions).not.toContain('Vary your leads');
    const legacy = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard']});
    expect(legacy.descriptionByKey.slot_1).not.toContain('estimated speed');
  });
  it('L2 preview 引导 mega：两枚持有者提示只带一个，另一槽位换补位答案', () => {
    const request = mkRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 2});
    const instructions = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard'], analysis}).questions.lead_1.instructions;
    expect(instructions).toMatch(/2 Mega-capable/i);
    expect(instructions).toMatch(/exactly one/i);
    expect(instructions).toMatch(/wastes a slot/i);
  });
  it('L2 preview 引导 mega：单枚持有者提示带入；L1 不带该引导', () => {
    const single = mkRequest();
    single.side.pokemon[3].item = 'leftovers';
    const state = mkTracker().state;
    const l2 = buildAnalysisContext({dex, request: single, state, level: 2});
    const l2Instructions = buildPreviewQuestions({dex, request: single, opponentPreviewSpecies: ['Charizard'], analysis: l2}).questions.bring_4.instructions;
    expect(l2Instructions).toMatch(/one Mega-capable/i);
    expect(l2Instructions).toMatch(/include it/i);
    const request = mkRequest();
    const l1 = buildAnalysisContext({dex, request, state, level: 1});
    const l1Instructions = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Charizard'], analysis: l1}).questions.lead_1.instructions;
    expect(l1Instructions).not.toMatch(/Mega-capable/i);
  });
});

describe('buildTurnPlans', () => {
  it('每个参战槽位一个问题；spread 招式标注 hits both foes', () => {
    const plans = buildTurnPlans({dex, request: mkRequest(), tracker: mkTracker()});
    expect(plans.map(p => p.slot)).toEqual([1, 2]);
    expect(plans.map(p => p.questionName)).toEqual(['action_slot_1', 'action_slot_2']);
    // Heat Wave 的真实协议 target 是 allAdjacentFoes（复数，data/moves.ts）→ 单选项、不写目标
    const heatWave = plans[1].options.find(o => o.key === 'move_2');
    expect(heatWave?.action).toEqual({kind: 'move', slot: 2, moveIndex: 2});
    expect(heatWave?.label).toContain('hits both foes');
    // 单目标招式（Iron Head）为两个对手各生成一个选项
    const slot1Keys = plans[0].options.map(o => o.key);
    expect(slot1Keys).toContain('move_1_foe_a');
    expect(slot1Keys).toContain('move_1_foe_b');
  });

  it('fainted 槽位不提问（服务器 auto-pass，提问会生成错位动作）', () => {
    const request = mkRequest();
    request.side.pokemon[0].condition = '0 fnt';
    const plans = buildTurnPlans({dex, request, tracker: mkTracker()});
    expect(plans.map(p => p.slot)).toEqual([2]);
  });

  it('move 选项注入战术注解：戏法空间机制、击掌首回合窗口与扫墓动态威力', () => {
    const request = mkRequest();
    request.active![0].moves[0] = {move: 'Fake Out', id: 'fakeout', pp: 10, maxpp: 10, target: 'normal'};
    request.active![0].moves[1] = {move: 'Last Respects', id: 'lastrespects', pp: 10, maxpp: 10, target: 'normal'};
    request.side.pokemon[0].moves = ['fakeout', 'lastrespects', 'leechlife', 'suckerpunch'];
    request.side.pokemon[0].item = 'choicescarf';
    const tracker = mkTracker();
    tracker.handleLine('|faint|p1c: Tyranitar');
    const analysis = buildAnalysisContext({dex, request, state: tracker.state, level: 2});
    const plans = buildTurnPlans({dex, request, tracker, analysis});
    const fakeOut = plans[0].options.find(o => o.key === 'move_1_foe_a');
    expect(fakeOut?.label).toMatch(/first action since entering the field/);
    expect(fakeOut?.label).toMatch(/Choice Scarf locks this Pokemon into/);
    const lastRespects = plans[0].options.find(o => o.key === 'move_2_foe_a');
    expect(lastRespects?.label).toMatch(/≈100 BP/);
    const trickRoom = plans[1].options.find(o => o.key === 'move_3');
    expect(trickRoom?.label).toMatch(/5 turns/);
    expect(trickRoom?.label).toMatch(/priority bracket/);
  });

  it('mega 选项标注时机引导：形态升级即刻生效、唯一且阵亡前未声明即浪费', () => {
    const plans = buildTurnPlans({dex, request: mkRequest(), tracker: mkTracker()});
    const mega = plans[0].options.find(o => o.key === 'move_1_foe_a_mega');
    expect(mega?.label).toMatch(/MEGA EVOLVE Golisopod into Golisopod-Mega/);
    expect(mega?.label).toMatch(/ability Tough Claws/);
    expect(mega?.label).toMatch(/Speed 40/);
    expect(mega?.label).toMatch(/only Mega/);
    expect(mega?.label).toMatch(/before any moves/);
    expect(mega?.label).toMatch(/faints/);
  });

  it('目标 Mega 形态特性免疫招式属性时 criteria 给出警示；对手已用 Mega 后撤除', () => {
    const data = mkDex();
    data.species.latias = {name: 'Latias', types: ['Dragon', 'Psychic'], baseStats: {hp: 80, atk: 80, def: 90, spa: 110, spd: 130, spe: 110}, abilities: {0: 'Levitate'}};
    data.species.latiasmega = {name: 'Latias-Mega', types: ['Dragon', 'Psychic'], baseStats: {hp: 80, atk: 100, def: 120, spa: 140, spd: 150, spe: 110}, abilities: {0: 'Levitate'}, baseSpecies: 'Latias', requiredItem: 'Latiasite'};
    const tracker = new BattleTracker('battle-mega-warn', 'JevBot1234');
    for (const line of [
      '|player|p1|JevBot1234|1|1500', '|player|p2|opponent|2|1500',
      '|poke|p1|Golisopod, L50, M|', '|poke|p1|Chandelure, L50, F|',
      '|poke|p2|Latias, L50, F|', '|poke|p2|Charizard, L50, M|',
      '|teampreview|4', '|teamsize|p1|4', '|teamsize|p2|4', '|start',
      '|switch|p1a: Golisopod|Golisopod, L50, M|150/150',
      '|switch|p1b: Chandelure|Chandelure, L50, F|135/135',
      '|switch|p2a: Latias|Latias, L50, F|100/100',
      '|switch|p2b: Charizard|Charizard, L50, M|100/100',
      '|turn|1',
    ]) tracker.handleLine(line);
    const request = mkRequest();
    const option = () => buildTurnPlans({dex: data, request, tracker})[0].options.find(o => o.key === 'move_2_foe_a');
    expect(option()?.label).toMatch(/Levitate/);
    expect(option()?.label).toMatch(/deal no damage/);
    tracker.handleLine('|-mega|p2b: Charizard|Charizard-Mega-Y');
    expect(option()?.label).not.toMatch(/Levitate/);
  });
});

/** 有双方控速 + 空间的对局：t1 对手顺风、t3 我方顺风/空间，当前 t4 */
function trackerWithControls(): BattleTracker {
  const tracker = mkTracker();
  for (const line of ['|-sidestart|p2: opponent|move: Tailwind', '|turn|3', '|-sidestart|p1: JevBot1234|move: Tailwind',
    '|-fieldstart|move: Trick Room|[of] p2a: Victreebel', '|turn|4']) {
    tracker.handleLine(line);
  }
  return tracker;
}

describe('控速摘要注入 instructions', () => {
  it('普通回合 instructions 含双方剩余回合与作用说明', () => {
    const plans = buildTurnPlans({dex, request: mkRequest(), tracker: trackerWithControls()});
    const instructions = plans[0].question.instructions;
    expect(instructions).toContain('Speed control');
    expect(instructions).toContain('Trick Room is active with 4 more turns including this one');
    expect(instructions).toContain('Foe-side Tailwind is active with 1 more turn including this one');
    expect(instructions).toContain('Your-side Tailwind is active with 3 more turns including this one');
    expect(instructions).toContain('Choose the action for slot 1');
  });
  it('无任何控速时 instructions 不注入空话', () => {
    const plans = buildTurnPlans({dex, request: mkRequest(), tracker: mkTracker()});
    expect(plans[0].question.instructions).not.toContain('Speed control');
  });
  it('强制换人 instructions 同样注入控速摘要', () => {
    const request = mkRequest({forceSwitch: [true, false]});
    const plans = buildSwitchPlans({dex, request, tracker: trackerWithControls()});
    expect(plans[0].question.instructions).toContain('Speed control');
    expect(plans[0].question.instructions).toContain('Trick Room is active with 4 more turns including this one');
    expect(plans[0].question.instructions).toContain('This is slot 1');
  });
});
