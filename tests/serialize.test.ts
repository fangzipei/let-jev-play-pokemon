import {describe, expect, it} from 'vitest';
import {
  buildStatePayload, describeMoveOption, describePreviewCandidate, describeSwitchOption, opponentActives, isMegaCapable,
} from '../src/state/serialize.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';
import {buildAnalysisContext} from '../src/state/analysis.js';

const dex = mkDex();

describe('增强 payload 与渲染', () => {
  it('Mega 候选别名按基础形态和道具识别，缺形态不伪造', () => {
    const p = mkRequest().side.pokemon[3];
    p.details = 'Salamence-Mega, L50';
    expect(isMegaCapable(dex, p)).toBe(true);
    p.item = 'golisopite';
    expect(isMegaCapable(dex, p)).toBe(false);
    p.item = 'salamencite';
    expect(isMegaCapable({...dex, species: {}}, p)).toBe(false);
  });
  it('我方场上、替补、preview 均保留完整配置与当前招式请求', () => {
    const request = mkRequest();
    request.side.pokemon[0].baseAbility = 'Emergency Exit';
    const state = mkTracker().state;
    const analysis = buildAnalysisContext({dex, request, state, level: 2});
    const payload = buildStatePayload({dex, request, state, analysis}) as any;
    const ours = payload.sides.ours;
    expect(ours.active[0]).toMatchObject({slot: 1, ident: request.side.pokemon[0].ident, moves: request.side.pokemon[0].moves, stats: request.side.pokemon[0].stats, base_ability: 'Emergency Exit'});
    expect(ours.active[0].move_request).toEqual(request.active![0].moves);
    expect(ours.bench[0]).toMatchObject({moves: request.side.pokemon[2].moves, ability: 'sandstream', item: 'choicescarf', stats: request.side.pokemon[2].stats});
    expect(ours.preview).toHaveLength(4);
    expect(ours.preview[2]).toMatchObject({slot: 3, speed: 123});
    expect(ours.team_notes).toHaveLength(4);
    expect(payload.analysis_notes).toMatch(/not a calibrated actual HP%/);
  });
  it('已揭示敌方道具、特性、状态、替补不能消失，未知特性不从 dex 填入', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-item|p2a: Victreebel|Choice Scarf');
    tracker.handleLine('|-ability|p2a: Victreebel|Chlorophyll');
    tracker.handleLine('|-start|p2a: Victreebel|Substitute');
    tracker.handleLine('|-singleturn|p2a: Victreebel|Protect');
    tracker.handleLine('|switch|p2b: Kingambit|Kingambit, L50|100/100');
    const request = mkRequest();
    const analysis = buildAnalysisContext({dex, request, state: tracker.state, level: 1});
    const payload = buildStatePayload({dex, request, state: tracker.state, analysis}) as any;
    const opponent = payload.sides.opponent;
    expect(opponent.active[0]).toMatchObject({ident: 'p2: Victreebel', item_revealed: 'Choice Scarf', ability_revealed: 'Chlorophyll', volatiles: ['Substitute'], single_turn: ['Protect'], base_speed: 70, speed: null});
    expect(opponent.active[1].ability_revealed).toBeNull();
    expect(opponent.bench.map((p: any) => p.species)).toContain('Charizard');
    expect(opponent.preview).toHaveLength(6);
    expect(payload.sides.ours).not.toHaveProperty('team_notes');
    expect(JSON.stringify(payload)).not.toContain('outspeeds');
  });
  it('满血且没亮招的退场对手仍是已见替补，不混入未上场列表', () => {
    const tracker = mkTracker();
    tracker.handleLine('|switch|p2a: Kingambit|Kingambit, L50|100/100');
    const payload = buildStatePayload({dex, request: mkRequest(), state: tracker.state}) as any;
    expect(payload.sides.opponent.bench.map((p: any) => p.species)).toContain('Victreebel');
    expect(payload.sides.opponent.unseen_from_preview.map((p: any) => p.species)).not.toContain('Victreebel');
    expect(payload.sides.opponent.seen_count).toBe(3);
  });
  it('payload 和换人描述复用传入 incoming，不再次粗估', () => {
    const request = mkRequest();
    const state = mkTracker().state;
    state.sides.p2.pokemon[0].revealedMoves = ['Sludge Bomb'];
    const analysis = buildAnalysisContext({dex, request, state, level: 1});
    analysis.threats[2].incoming[0].roughPercent = 73;
    const payload = buildStatePayload({dex, request, state, analysis}) as any;
    expect(payload.sides.opponent.active[0].incoming_estimates.find((m: any) => m.slot === 3).rough_percent).toBe(73);
    const text = describeSwitchOption({dex, pokemon: request.side.pokemon[2], opponentActives: opponentActives(dex, state), analysis, teamSlot: 3});
    expect(text).toContain('incoming ≈73%');
    expect(text).toMatch(/revealed moves/);
    expect(text).toMatch(/not a calibrated actual HP%/);
  });
  it('preview 展示速度和双向潜在克制，L1 不添加角色', () => {
    const request = mkRequest();
    const state = mkTracker().state;
    const analysis = buildAnalysisContext({dex, request, state, level: 1});
    const text = describePreviewCandidate({dex, pokemon: request.side.pokemon[0], opponentPreviewSpecies: ['Charizard'], megaCapable: true, analysis, teamSlot: 1});
    expect(text).toContain('estimated speed 60');
    expect(text).toMatch(/potential STAB.*Charizard.*4x/);
    expect(text).toContain('not revealed moves');
    expect(text).not.toContain('role:');
  });
  it('未知属性/招式不描述成无弱点或状态招式', () => {
    const request = mkRequest();
    const state = mkTracker().state;
    const missing = {...dex, typechart: {}};
    const analysis = buildAnalysisContext({dex: missing, request, state, level: 1});
    const text = describePreviewCandidate({dex: missing, pokemon: request.side.pokemon[0], opponentPreviewSpecies: ['Charizard'], megaCapable: false, analysis, teamSlot: 1});
    expect(text).toMatch(/unknown/i);
    expect(text).not.toMatch(/no STAB weakness|no potential STAB weakness/);
    const move = describeMoveOption({dex, moveId: 'unknownmove', moveName: 'Unknown Move', pp: 1, maxpp: 1, attackerTypes: []});
    expect(move).toMatch(/unknown/i);
    expect(move).not.toContain('status move');
  });
  it('传 analysis 的动作描述附速度但从不据种族速度承诺先手', () => {
    const request = mkRequest();
    const state = mkTracker().state;
    const analysis = buildAnalysisContext({dex, request, state, level: 2});
    const text = describeMoveOption({dex, moveId: 'suckerpunch', moveName: 'Sucker Punch', pp: 5, maxpp: 5, attackerTypes: ['Bug', 'Steel'], target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100, ident: 'p2: Victreebel'}, analysis, attackerSlot: 1});
    expect(text).toContain('estimated speed 60');
    expect(text).toContain('base speed 70');
    expect(text).toContain('actual speed unknown');
    expect(text).toMatch(/priority.*before speed/);
    expect(text).not.toMatch(/you move first|outspeeds/);
    expect(text).toContain('not a calibrated actual HP%');
  });
  it('无 analysis 保持旧调用兼容，不悄悄启用等级或速度字段', () => {
    const payload = buildStatePayload({dex, request: mkRequest(), state: mkTracker().state}) as any;
    expect(payload.sides.ours.active[0]).not.toHaveProperty('speed');
    expect(payload.sides.ours).not.toHaveProperty('team_notes');
  });
});

describe('buildStatePayload', () => {
  it('包含双方关键信息', () => {
    const payload = buildStatePayload({state: mkTracker().state, request: mkRequest(), dex}) as any;
    expect(payload.turn).toBe(1);
    expect(payload.rules).toContain('pick 4');
    expect(payload.sides.ours.active[0].species).toBe('Golisopod');
    expect(payload.sides.ours.active[0].types).toEqual(['Bug', 'Steel']);
    expect(payload.sides.ours.bench.map((b: any) => b.species)).toEqual(['Tyranitar', 'Salamence']);
    expect(payload.sides.opponent.active.map((a: any) => a.species)).toEqual(['Victreebel', 'Charizard']);
    expect(payload.sides.opponent.active[1].hp_percent).toBe(92);
    expect(payload.sides.opponent.brought_count).toBe(4);
    expect(Array.isArray(payload.recent_log)).toBe(true);
  });
});

describe('opponentActives', () => {
  it('按参战位置排序并给出 Foe A/B 标签', () => {
    const actives = opponentActives(dex, mkTracker().state);
    expect(actives.map(a => a.label)).toEqual(['Foe A', 'Foe B']);
    expect(actives[0].species).toBe('Victreebel');
  });
});

describe('describeMoveOption', () => {
  it('单体招式描述含属性/PP/伤害估算与克制倍率', () => {
    const text = describeMoveOption({
      dex, moveId: 'ironhead', moveName: 'Iron Head', pp: 15, maxpp: 15,
      attackerTypes: ['Bug', 'Steel'], attackerStats: {atk: 180},
      target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100},
    });
    expect(text).toContain('Iron Head');
    expect(text).toContain('Steel');
    expect(text).toContain('PP 15/15');
    expect(text).toContain('Foe A');
    expect(text).toMatch(/≈\d+%/);
  });

  it('双体招式标注 spread', () => {
    const text = describeMoveOption({
      dex, moveId: 'heatwave', moveName: 'Heat Wave', pp: 10, maxpp: 10,
      attackerTypes: ['Ghost', 'Fire'], attackerStats: {spa: 190},
      target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100}, hitsBoth: true,
    });
    expect(text).toContain('both foes');
    expect(text).toContain('2x');
  });

  it('状态招式标注无直接伤害', () => {
    const text = describeMoveOption({
      dex, moveId: 'trickroom', moveName: 'Trick Room', pp: 5, maxpp: 5, attackerTypes: ['Ghost'],
    });
    expect(text).toContain('status move');
  });
});

describe('describeMoveOption 战术注解', () => {
  const foe = {label: 'Foe A', species: 'Whimsicott', hpPercent: 100, ident: 'p2: Whimsicott'};
  it('戏法空间选项给出 5 回合反序与 -7 最后结算的机制注解', () => {
    const text = describeMoveOption({
      dex, moveId: 'trickroom', moveName: 'Trick Room', pp: 5, maxpp: 5,
      attackerTypes: ['Ghost', 'Fire'], fieldConditions: [],
    });
    expect(text).toMatch(/5 turns/);
    expect(text).toMatch(/slower.*moves first/i);
    expect(text).toMatch(/priority bracket/);
    expect(text).toMatch(/resolves last/i);
  });
  it('戏法空间已在场时警告再次使用会取消现有空间', () => {
    const text = describeMoveOption({
      dex, moveId: 'trickroom', moveName: 'Trick Room', pp: 5, maxpp: 5,
      attackerTypes: ['Ghost', 'Fire'], fieldConditions: ['move: Trick Room'],
    });
    expect(text).toMatch(/already active/);
    expect(text).toMatch(/cancel/i);
  });
  it('扫墓按已阵亡队友数显示当前威力并按该威力估算伤害', () => {
    const base = {dex, moveId: 'lastrespects', moveName: 'Last Respects', pp: 10, maxpp: 10,
      attackerTypes: ['Water', 'Ghost'], attackerStats: {atk: 180}, target: foe};
    const zero = describeMoveOption({...base, faintedAllies: 0});
    const three = describeMoveOption({...base, faintedAllies: 3});
    expect(zero).toMatch(/≈50 BP/);
    expect(three).toMatch(/≈200 BP/);
    expect(three).toMatch(/50 per fainted ally/);
    const pct = (t: string) => Number(/≈(\d+)% damage/.exec(t)?.[1] ?? NaN);
    expect(pct(three)).toBeGreaterThan(pct(zero));
  });
  it('晴天下水系伤害招式标注减半', () => {
    const base = {dex, moveId: 'hydropump', moveName: 'Hydro Pump', pp: 5, maxpp: 5,
      attackerTypes: ['Water'], attackerStats: {spa: 150}, target: foe};
    const sunny = describeMoveOption({...base, weather: 'SunnyDay'});
    expect(sunny).toMatch(/sun/i);
    expect(sunny).toMatch(/halves Water/);
    const rain = describeMoveOption({...base, weather: 'RainDance'});
    expect(rain).not.toMatch(/halves Water/);
  });
  it('击掌奇袭按窗口状态区分可用提示与失败警告', () => {
    const base = {dex, moveId: 'fakeout', moveName: 'Fake Out', pp: 10, maxpp: 10,
      attackerTypes: ['Fire', 'Dark'], target: foe};
    const open = describeMoveOption({...base, firstActionSinceSwitchIn: true});
    expect(open).toMatch(/first action since entering the field/);
    expect(open).toMatch(/flinch/i);
    const closed = describeMoveOption({...base, firstActionSinceSwitchIn: false});
    expect(closed).toMatch(/will fail/);
  });
  it('讲究道具持有者在首个行动回合标注锁招后果', () => {
    const base = {dex, moveId: 'hydropump', moveName: 'Hydro Pump', pp: 5, maxpp: 5,
      attackerTypes: ['Water'], attackerStats: {spa: 150}, target: foe, attackerItem: 'Choice Scarf'};
    const first = describeMoveOption({...base, firstActionSinceSwitchIn: true});
    expect(first).toMatch(/Choice Scarf locks this Pokemon into/);
    const later = describeMoveOption({...base, firstActionSinceSwitchIn: false});
    expect(later).not.toMatch(/locks this Pokemon into/);
  });
  it('目标 Mega 形态特性免疫该招式属性时给出警示；已用 Mega 或已成 Mega 形态时不误报', () => {
    const data = mkDex();
    data.species.sceptile = {name: 'Sceptile', types: ['Grass'], baseStats: {hp: 70, atk: 85, def: 65, spa: 105, spd: 85, spe: 120}, abilities: {0: 'Overgrow'}};
    data.species.sceptilemega = {name: 'Sceptile-Mega', types: ['Grass', 'Dragon'], baseStats: {hp: 70, atk: 110, def: 75, spa: 145, spd: 85, spe: 145}, abilities: {0: 'Lightning Rod'}, baseSpecies: 'Sceptile', requiredItem: 'Sceptilite'};
    const base = {
      dex: data, moveId: 'thunderbolt', moveName: 'Thunderbolt', pp: 10, maxpp: 10,
      attackerTypes: ['Ghost', 'Fire'], attackerStats: {spa: 190},
      target: {label: 'Foe A', species: 'Sceptile', hpPercent: 100},
    };
    const text = describeMoveOption(base);
    expect(text).toMatch(/caution/i);
    expect(text).toContain('Sceptile-Mega');
    expect(text).toContain('Lightning Rod');
    expect(text).toMatch(/deal no damage/);
    expect(describeMoveOption({...base, opponentMegaUsed: true})).not.toMatch(/Lightning Rod/);
    expect(describeMoveOption({...base, moveId: 'ironhead', moveName: 'Iron Head'})).not.toMatch(/caution/i);
    expect(describeMoveOption({...base, target: {label: 'Foe A', species: 'Sceptile-Mega', hpPercent: 100}})).not.toMatch(/caution/i);
  });
});

describe('describeSwitchOption', () => {
  it('含属性、HP、道具与对手已揭示招式的来袭伤害', () => {
    const request = mkRequest();
    const text = describeSwitchOption({
      dex,
      pokemon: request.side.pokemon[2], // Tyranitar
      opponentActives: opponentActives(dex, mkTracker().state),
    });
    expect(text).toContain('Tyranitar');
    expect(text).toContain('Rock/Dark');
    expect(text).toContain('175/175');
  });
});

describe('describePreviewCandidate', () => {
  it('含速度、招式与对对手的克制统计', () => {
    const request = mkRequest();
    const text = describePreviewCandidate({
      dex,
      pokemon: request.side.pokemon[0], // Golisopod
      opponentPreviewSpecies: ['Victreebel', 'Charizard', 'Kingambit', 'Whimsicott', 'Sneasler', 'Metagross'],
      megaCapable: true,
    });
    expect(text).toContain('Golisopod');
    expect(text).toContain('Bug/Steel');
    expect(text).toContain('Mega');
    expect(text).toMatch(/best:/);
  });
});

import {buildOpponentNotes} from '../src/state/opponent-notes.js';
import {parsePikaList} from '../src/dex/pikalytics.js';
import type {SpeedControl} from '../src/state/speed-control.js';

const pikaFixture = parsePikaList([{
  name: 'Victreebel', rank: '5', percent: '10', winPercent: '50', stats: {spe: 70},
  abilities: [{ability: 'Chlorophyll', percent: '60'}], items: [{item: 'Focus Sash', percent: '40'}],
  moves: [{move: 'Sludge Bomb', percent: '70'}], team: [], leads: [{pokemon: 'Victreebel', percent: '9.5'}],
}], '2026-05', 'f');

describe('payload 对手注解注入', () => {
  it('L2 注入 notes 四栏并省略空栏；L1 不注入', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-item|p2a: Victreebel|Choice Scarf');
    tracker.handleLine('|move|p2a: Victreebel|Sludge Bomb|p1a: Golisopod');
    const request = mkRequest();
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1', pika: pikaFixture});
    const analysis = buildAnalysisContext({dex, request, state: tracker.state, level: 2});
    const payload = buildStatePayload({dex, request, state: tracker.state, analysis, opponentNotes: notes}) as any;
    const victreebel = payload.sides.opponent.active[0];
    expect(victreebel.notes.confirmed).toContain('item confirmed: Choice Scarf');
    expect(victreebel.notes.assumed.join(' ')).toContain('Chlorophyll');
    expect(victreebel.notes.recent_actions).toContain('turn 1: used Sludge Bomb');
    expect(victreebel.notes).not.toHaveProperty('memory');
    const l1 = buildStatePayload({dex, request, state: tracker.state,
      analysis: buildAnalysisContext({dex, request, state: tracker.state, level: 1}), opponentNotes: notes}) as any;
    expect(l1.sides.opponent.active[0]).not.toHaveProperty('notes');
  });
  it('opponentNotes 为 null 时 payload 与旧行为一致', () => {
    const request = mkRequest();
    const state = mkTracker().state;
    const analysis = buildAnalysisContext({dex, request, state, level: 2});
    const payload = buildStatePayload({dex, request, state, analysis, opponentNotes: null}) as any;
    expect(payload.sides.opponent.active[0]).not.toHaveProperty('notes');
  });
});

describe('buildPreviewQuestions 对手首发先验', () => {
  it('L2 且传入 opponentLeadPriors 时进入 INTRO', async () => {
    const {buildPreviewQuestions} = await import('../src/decide/team-preview.js');
    const request = mkRequest();
    request.teamPreview = true;
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 2});
    const set = buildPreviewQuestions({
      dex, request, opponentPreviewSpecies: ['Victreebel'], analysis,
      opponentLeadPriors: ['Victreebel 9.5%'],
    });
    expect(set.questions.lead_1.instructions).toContain('Victreebel 9.5%');
    const none = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Victreebel'], analysis});
    expect(none.questions.lead_1.instructions).not.toContain('lead tendencies');
  });
});

const emptySpeedControl: SpeedControl = {
  trick_room: null, our_tailwind: null, opponent_tailwind: null, weather: null, opponent_speed_abilities: [],
};

describe('控速剩余回合注入', () => {
  it('payload 无 analysis 也输出 speed_control 剩余回合', () => {
    const tracker = mkTracker();
    for (const line of ['|turn|3', '|-fieldstart|move: Trick Room|[of] p2a: Victreebel',
      '|-weather|Sandstorm|[of] p2b: Charizard', '|turn|4']) {
      tracker.handleLine(line);
    }
    const payload = buildStatePayload({dex, request: mkRequest(), state: tracker.state}) as any;
    expect(payload.speed_control.trick_room).toEqual({started_turn: 3, turns_left: 4});
    expect(payload.speed_control.weather).toEqual({name: 'Sandstorm', started_turn: 3, turns_left: 4, extended: null});
    expect(payload.speed_control.our_tailwind).toBeNull();
  });
  it('戏法空间已激活时注解带剩余回合与重开取消语义', () => {
    const text = describeMoveOption({
      dex, moveId: 'trickroom', moveName: 'Trick Room', pp: 5, maxpp: 5, attackerTypes: ['Ghost'],
      speedControl: {...emptySpeedControl, trick_room: {started_turn: 3, turns_left: 4}},
    });
    expect(text).toContain('Trick Room is already active with 4 more turns including this one');
    expect(text).toMatch(/cancel/i);
  });
  it('顺风注解区分我方已激活（重开失败）与未激活（机制说明）', () => {
    const base = {dex, moveId: 'tailwind', moveName: 'Tailwind', pp: 15, maxpp: 15, attackerTypes: ['Flying']};
    const active = describeMoveOption({...base, speedControl: {...emptySpeedControl, our_tailwind: {started_turn: 2, turns_left: 3}}});
    expect(active).toContain('Tailwind is already active on your side with 3 more turns including this one');
    expect(active).toMatch(/will fail/);
    expect(active).not.toMatch(/lasts 4 turns/);
    const idle = describeMoveOption({...base, speedControl: emptySpeedControl});
    expect(idle).toMatch(/lasts 4 turns/);
  });
  it('未传 speedControl 时注解保持旧行为', () => {
    const tr = describeMoveOption({
      dex, moveId: 'trickroom', moveName: 'Trick Room', pp: 5, maxpp: 5,
      attackerTypes: ['Ghost', 'Fire'], fieldConditions: ['move: Trick Room'],
    });
    expect(tr).toMatch(/already active/);
    expect(tr).not.toMatch(/more turns including this one/);
    const tailwind = describeMoveOption({dex, moveId: 'tailwind', moveName: 'Tailwind', pp: 15, maxpp: 15, attackerTypes: ['Flying']});
    expect(tailwind).not.toMatch(/lasts 4 turns/);
  });
});
