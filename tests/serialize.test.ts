import {describe, expect, it} from 'vitest';
import {
  buildStatePayload, describeMoveOption, describePreviewCandidate, describeSwitchOption, opponentActives, isMegaCapable, mainAttackOf,
} from '../src/state/serialize.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';
import {buildAnalysisContext} from '../src/state/analysis.js';
import {buildBattleContext} from '../src/state/battle-context.js';

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
  it.each([1, 2, 3] as const)('L%s 携带相同来源的累计摘要和按回合整理的双方历史', level => {
    const tracker = mkTracker();
    const request = mkRequest();
    tracker.handleLine('|move|p1a: Golisopod|Protect|p1a: Golisopod');
    tracker.handleLine('|move|p2a: Victreebel|Sleep Powder|p1b: Chandelure');
    tracker.handleLine('|turn|2');
    const analysis = buildAnalysisContext({dex, request, state: tracker.state, level});
    const payload = buildStatePayload({dex, request, state: tracker.state, analysis}) as any;
    expect(payload.battle_context).toEqual(buildBattleContext({state: tracker.state, request}));
    expect(payload.battle_context.recent_turns[0].events).toHaveLength(2);
    expect(payload.battle_context.summary.ours.brought_count.confirmed).toBe(4);
    expect(payload.battle_context.summary.opponent.brought_count.confirmed).toBeNull();
    expect(payload.sides.opponent.brought_count).toBeNull();
  });
  it('兼容 recent_log 仅复用清洗后的事件，聊天及原始 request 不旁路进入 payload', () => {
    const tracker = mkTracker();
    tracker.handleLine('|move|p2b: Charizard|Heat Wave|p1a: Golisopod');
    tracker.handleLine('|c|opponent|INJECT');
    tracker.state.log.push('|request|{"INJECT":true}', '|html|INJECT');
    const payload = buildStatePayload({dex, request: mkRequest(), state: tracker.state}) as any;
    expect(payload.recent_log).toEqual(payload.battle_context?.recent_turns.flatMap((row: any) => row.events).slice(-10));
    expect(JSON.stringify(payload)).not.toContain('INJECT');
    expect(payload.recent_log).toContain('|move|p2b: Charizard|Heat Wave|p1a: Golisopod');
  });
  it('满血首发换下后，即使旧日志被裁剪，主快照与摘要的已见名单也一致', () => {
    const tracker = mkTracker();
    tracker.handleLine('|switch|p2a: Kingambit|Kingambit, L50|100/100');
    tracker.state.log = ['|turn|7'];
    tracker.state.turn = 7;
    const payload = buildStatePayload({dex, request: mkRequest(), state: tracker.state}) as any;
    expect(payload.sides.opponent.bench.map((p: any) => p.species)).toContain('Victreebel');
    expect(payload.sides.opponent.seen_count).toBe(payload.battle_context.summary.opponent.seen_count);
    expect(payload.sides.opponent.unseen_from_preview.map((p: any) => p.species)).not.toContain('Victreebel');
  });
  it('主快照与局内摘要对换下对手的能力等级均不保留过期值', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-boost|p2a: Victreebel|spa|2');
    tracker.handleLine('|switch|p2a: Kingambit|Kingambit, L50|100/100');
    const payload = buildStatePayload({dex, request: mkRequest(), state: tracker.state}) as any;
    expect(payload.sides.opponent.bench.find((p: any) => p.species === 'Victreebel').boosts).toEqual({});
    expect(payload.battle_context.summary.opponent.pokemon.find((p: any) => p.species === 'Victreebel').boosts).toEqual({});
  });
  it('包含双方关键信息', () => {
    const payload = buildStatePayload({state: mkTracker().state, request: mkRequest(), dex}) as any;
    expect(payload.turn).toBe(1);
    expect(payload.rules).toContain('pick 4');
    expect(payload.sides.ours.active[0].species).toBe('Golisopod');
    expect(payload.sides.ours.active[0].types).toEqual(['Bug', 'Steel']);
    expect(payload.sides.ours.bench.map((b: any) => b.species)).toEqual(['Tyranitar', 'Salamence']);
    expect(payload.sides.opponent.active.map((a: any) => a.species)).toEqual(['Victreebel', 'Charizard']);
    expect(payload.sides.opponent.active[1].hp_percent).toBe(92);
    expect(payload.sides.opponent.brought_count).toBeNull();
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
      hitsBoth: true,
      targets: [
        {label: 'Foe A', species: 'Victreebel', hpPercent: 100},
        {label: 'Foe B', species: 'Charizard', hpPercent: 92},
      ],
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
  it('晴天下气象球头部与估算按火属性 100 BP 显示并明确说明', () => {
    const text = describeMoveOption({
      dex, moveId: 'weatherball', moveName: 'Weather Ball', pp: 10, maxpp: 10,
      attackerTypes: ['Fire'], attackerStats: {spa: 100},
      target: {label: 'Foe A', species: 'Golisopod', hpPercent: 100},
      weather: 'SunnyDay',
    });
    expect(text).toContain('Weather Ball [Fire/Special/100BP/PP 10/10]');
    expect(text).toMatch(/Weather Ball is a Fire-type move with 100 BP/);
    expect(text).toMatch(/\(4x\)/);
  });
  it('无天气时气象球保持普通属性 50 BP 并说明天气映射', () => {
    const text = describeMoveOption({
      dex, moveId: 'weatherball', moveName: 'Weather Ball', pp: 10, maxpp: 10,
      attackerTypes: ['Fire'], attackerStats: {spa: 100},
      target: {label: 'Foe A', species: 'Golisopod', hpPercent: 100},
    });
    expect(text).toContain('Weather Ball [Normal/Special/50BP/PP 10/10]');
    expect(text).toMatch(/Fire in sun, Water in rain, Rock in sandstorm, Ice in snow/);
  });
  it('群攻招式对每个对手分别给出伤害估算并计入 spread', () => {
    const base = {dex, moveId: 'heatwave', moveName: 'Heat Wave', pp: 10, maxpp: 10,
      attackerTypes: ['Ghost', 'Fire'], attackerStats: {spa: 100}};
    const both = describeMoveOption({...base, hitsBoth: true, targets: [
      {label: 'Foe A', species: 'Victreebel', hpPercent: 100},
      {label: 'Foe B', species: 'Charizard', hpPercent: 92},
    ]});
    expect(both).toContain('hits both foes (0.75x spread)');
    const pct = (t: string, label: string) => Number(/≈(\d+)% damage/.exec(t.split(`vs ${label}`)[1] ?? '')?.[1] ?? NaN);
    expect(both).toMatch(/vs Foe A \(Victreebel, 100% HP\): ≈\d+% damage \(2x\)/);
    expect(both).toMatch(/vs Foe B \(Charizard, 92% HP\): ≈\d+% damage \(0\.5x\)/);
    expect(pct(both, 'Foe A')).toBeGreaterThan(pct(both, 'Foe B'));
    const single = describeMoveOption({...base, target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100}});
    expect(pct(single, 'Foe A')).toBeGreaterThan(pct(both, 'Foe A'));
  });
  it('适应力特性在选项伤害估算中按 2.0x 本系加成计入', () => {
    const base = {dex, moveId: 'ironhead', moveName: 'Iron Head', pp: 15, maxpp: 15,
      attackerTypes: ['Bug', 'Steel'], attackerStats: {atk: 180},
      target: {label: 'Foe A', species: 'Metagross', hpPercent: 100}};
    const dmg = (t: string) => Number(/≈(\d+)% damage/.exec(t)?.[1] ?? NaN);
    const normal = dmg(describeMoveOption(base));
    const adapt = dmg(describeMoveOption({...base, attackerAbility: 'adaptability'}));
    expect(adapt).toBeGreaterThan(normal);
  });
  it('只剩一个目标时群攻招式的伤害按单发计且不再声称 0.75x spread', () => {
    const base = {dex, moveId: 'heatwave', moveName: 'Heat Wave', pp: 10, maxpp: 10,
      attackerTypes: ['Ghost', 'Fire'], attackerStats: {spa: 100}};
    const target = {label: 'Foe A', species: 'Victreebel', hpPercent: 55};
    const lastFoe = describeMoveOption({...base, hitsBoth: true, targets: [target]});
    const single = describeMoveOption({...base, target});
    const pct = (t: string) => Number(/≈(\d+)% damage/.exec(t)?.[1] ?? NaN);
    expect(lastFoe).not.toContain('hits both foes (0.75x spread)');
    expect(lastFoe).toMatch(/remaining foe at full power/);
    expect(pct(lastFoe)).toBe(pct(single));
  });
  it('targets 传空数组时回退到 target 而不是丢弃目标', () => {
    const text = describeMoveOption({
      dex, moveId: 'ironhead', moveName: 'Iron Head', pp: 15, maxpp: 15,
      attackerTypes: ['Bug', 'Steel'], attackerStats: {atk: 180}, targets: [],
      target: {label: 'Foe A', species: 'Metagross', hpPercent: 100},
    });
    expect(text).toMatch(/vs Foe A \(Metagross, 100% HP\)/);
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
  it('换出收益：Yawn 解除、低血保存、负面阶级清零，无收益时不添加', () => {
    const request = mkRequest();
    const base = {dex, pokemon: request.side.pokemon[2], opponentActives: []};
    const yawn = describeSwitchOption({...base, outgoing: {species: 'Golisopod', yawning: true}});
    expect(yawn).toContain('switching this slot out removes Yawn from Golisopod before it falls asleep');
    const low = describeSwitchOption({...base, outgoing: {species: 'Golisopod', hpPercent: 20}});
    expect(low).toContain('Golisopod is at 20% HP: switching preserves it');
    const drops = describeSwitchOption({...base, outgoing: {species: 'Golisopod', boosts: {atk: -1, spe: 1}}});
    expect(drops).toContain("switching out clears Golisopod's lowered stats (atk -1)");
    expect(drops).not.toContain('spe');
    const none = describeSwitchOption({...base, outgoing: {species: 'Golisopod', hpPercent: 80, boosts: {atk: 1}}});
    expect(none).not.toContain('switching');
  });
  it('手动换人必须提醒换入者本回合不能行动且会吃打向该槽位的攻击；强制换人不加此提醒', () => {
    const request = mkRequest();
    const manual = describeSwitchOption({dex, pokemon: request.side.pokemon[2], opponentActives: []});
    expect(manual).toContain('the switch-in cannot act this turn and will take any attacks aimed at this slot');
    const forced = describeSwitchOption({dex, pokemon: request.side.pokemon[2], opponentActives: [], forced: true});
    expect(forced).not.toContain('cannot act this turn');
    expect(forced).toContain('forced replacement');
  });
});

describe('主攻属性被降：换人强化行与招式估算偏差提醒', () => {
  it('mainAttackOf 按伤害招式类别定主攻，平手按 stats，无伤害招或缺数据返回 null', () => {
    const request = mkRequest();
    expect(mainAttackOf(dex, request.side.pokemon[0])).toBe('atk'); // Golisopod：四个物理伤害招
    expect(mainAttackOf(dex, request.side.pokemon[1])).toBe('spa'); // Chandelure：两个特攻招 + 两个变化招
    const even = {...request.side.pokemon[1], moves: ['shadowball', 'ironhead']};
    expect(mainAttackOf(dex, even)).toBe('spa'); // 平手按 spa 190 > atk 60
    const evenPhysical = {...request.side.pokemon[0], moves: ['ironhead', 'heatwave']};
    expect(mainAttackOf(dex, evenPhysical)).toBe('atk'); // 平手按 atk 180 > spa 70
    expect(mainAttackOf(dex, {...request.side.pokemon[1], moves: ['trickroom', 'protect']})).toBeNull();
    expect(mainAttackOf(dex, {...request.side.pokemon[1], moves: ['shadowball', 'ironhead'], stats: undefined})).toBeNull();
    expect(mainAttackOf(dex, {...request.side.pokemon[1], moves: ['unknownmove', 'ironhead']})).toBe('atk'); // 未知招式不计
  });
  it('换人选项：主攻被降时给强化行，含属性、阶级、输出百分比与优先换人引导', () => {
    const request = mkRequest();
    const base = {dex, pokemon: request.side.pokemon[2], opponentActives: []};
    const spa = describeSwitchOption({...base, outgoing: {species: 'Chandelure', mainAttack: {stat: 'spa', stage: -2}}});
    expect(spa).toContain('main special attacker');
    expect(spa).toContain('Special Attack is at -2');
    expect(spa).toContain('about 50%');
    expect(spa).toMatch(/consider switching out first/i);
    const atk = describeSwitchOption({...base, outgoing: {species: 'Golisopod', mainAttack: {stat: 'atk', stage: -1}}});
    expect(atk).toContain('main physical attacker');
    expect(atk).toContain('Attack is at -1');
    expect(atk).toContain('about 67%');
  });
  it('换人选项：-1 起触发、未降与非主攻负阶级保持旧行为', () => {
    const request = mkRequest();
    const base = {dex, pokemon: request.side.pokemon[2], opponentActives: []};
    const zero = describeSwitchOption({...base, outgoing: {species: 'Chandelure', mainAttack: {stat: 'spa', stage: 0}}});
    expect(zero).not.toContain('main special attacker');
    const mixed = describeSwitchOption({...base, outgoing: {species: 'Chandelure', mainAttack: {stat: 'spa', stage: -2}, boosts: {spa: -2, spe: -1}}});
    expect(mixed).toContain('main special attacker');
    expect(mixed).toContain("lowered stats (spe -1)");
    expect(mixed).not.toContain('spa -2');
    const other = describeSwitchOption({...base, outgoing: {species: 'Chandelure', mainAttack: {stat: 'spa', stage: 0}, boosts: {atk: -1}}});
    expect(other).toContain("lowered stats (atk -1)");
    expect(other).not.toContain('main special attacker');
  });
  it('招式选项：主攻被降且类别匹配的伤害招追加估算偏差提醒；状态招与不匹配类别不加', () => {
    const foe = {label: 'Foe A', species: 'Victreebel', hpPercent: 100};
    const base = {dex, moveId: 'shadowball', moveName: 'Shadow Ball', pp: 15, maxpp: 15, attackerTypes: ['Ghost', 'Fire'], attackerStats: {spa: 190}, target: foe};
    const hit = describeMoveOption({...base, attackerMainAttack: {stat: 'spa', stage: -2}});
    expect(hit).toContain('Special Attack is at -2');
    expect(hit).toMatch(/does not include stat stages/);
    expect(hit).toMatch(/actual damage is lower/);
    expect(describeMoveOption({...base, moveId: 'trickroom', moveName: 'Trick Room', attackerMainAttack: {stat: 'spa', stage: -2}})).not.toMatch(/does not include stat stages/);
    expect(describeMoveOption({...base, moveId: 'ironhead', moveName: 'Iron Head', attackerTypes: ['Bug', 'Steel'], attackerMainAttack: {stat: 'spa', stage: -2}})).not.toMatch(/does not include stat stages/);
    expect(describeMoveOption({...base, attackerMainAttack: {stat: 'spa', stage: 0}})).not.toMatch(/does not include stat stages/);
    const atk = describeMoveOption({...base, moveId: 'ironhead', moveName: 'Iron Head', attackerTypes: ['Bug', 'Steel'], attackerMainAttack: {stat: 'atk', stage: -1}});
    expect(atk).toContain('Attack is at -1');
    expect(atk).toContain('about 67%');
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
  it('best 行在超效计数后附最高伤害估算而非 type-only', () => {
    const request = mkRequest();
    const text = describePreviewCandidate({
      dex, pokemon: request.side.pokemon[0],
      opponentPreviewSpecies: ['Victreebel', 'Charizard', 'Kingambit', 'Whimsicott', 'Sneasler', 'Metagross'],
      megaCapable: true,
    });
    expect(text).toMatch(/best: .*hits 3\/6 foes super effectively; top ≈\d+% vs \w+ \(rough estimate\)/);
    expect(text).not.toContain('type-only');
  });
  it('传入 likelyMegaFoes 时列出对预期 Mega 形态的超效招式', () => {
    const request = mkRequest();
    const text = describePreviewCandidate({
      dex,
      pokemon: request.side.pokemon[1], // Chandelure：Heat Wave（火）
      opponentPreviewSpecies: ['Golisopod'],
      megaCapable: false,
      likelyMegaFoes: [{species: 'Golisopod', name: 'Golisopod-Mega', types: ['Bug', 'Steel'], percent: 98.6}],
    });
    expect(text).toMatch(/likely-form coverage: Heat Wave \(Fire\) hits likely Golisopod-Mega \[Bug\/Steel\] 4x ≈\d+% \(98\.6% Mega-stone prior, rough estimate\)/);
    const none = describePreviewCandidate({dex, pokemon: request.side.pokemon[1], opponentPreviewSpecies: ['Golisopod'], megaCapable: false});
    expect(none).not.toContain('likely-form coverage');
  });
  it('Drought 持有者的气象球按晴天火属性计入 likely-form coverage 并与火招并列', () => {
    const data = mkDex();
    data.species.torkoal = {name: 'Torkoal', types: ['Fire'], baseStats: {hp: 70, atk: 85, def: 140, spa: 85, spd: 70, spe: 20}, abilities: {0: 'Drought'}};
    data.moves.eruption = {name: 'Eruption', type: 'Fire', basePower: 150, category: 'Special', target: 'allAdjacentFoes', priority: 0};
    const torkoal = {
      ident: 'p1: Torkoal', details: 'Torkoal, L50, M', condition: '140/140', active: false,
      stats: {spa: 105}, moves: ['eruption', 'weatherball', 'protect'], item: 'charcoal', ability: 'drought',
    };
    const likelyMegaFoes = [{species: 'Golisopod', name: 'Golisopod-Mega', types: ['Bug', 'Steel'], percent: 98.6}];
    const text = describePreviewCandidate({dex: data, pokemon: torkoal, opponentPreviewSpecies: ['Golisopod'], megaCapable: false, likelyMegaFoes});
    expect(text).toMatch(/likely-form coverage: Eruption \(Fire\) and Weather Ball \(Fire in Sun\) hit likely Golisopod-Mega \[Bug\/Steel\] 4x ≈\d+% \(98\.6% Mega-stone prior, rough estimate\)/);
    const noDrought = describePreviewCandidate({dex: data, pokemon: {...torkoal, ability: 'whitesmoke'}, opponentPreviewSpecies: ['Golisopod'], megaCapable: false, likelyMegaFoes});
    expect(noDrought).toContain('likely-form coverage: Eruption (Fire) hits likely Golisopod-Mega [Bug/Steel] 4x');
    expect(noDrought).not.toContain('Fire in Sun');
  });
});

describe('describePreviewCandidate as a lead 评估行', () => {
  const previewFoes = ['Victreebel', 'Charizard', 'Kingambit', 'Whimsicott', 'Sneasler', 'Metagross'];
  const mkAnalysis = (level: 1 | 2 = 2) => {
    const request = mkRequest();
    request.teamPreview = true;
    return {request, analysis: buildAnalysisContext({dex, request, state: mkTracker().state, level})};
  };

  it('L2 输出速度排名/超速事实、预期首发攻防与交手战绩', () => {
    const {request, analysis} = mkAnalysis();
    const text = describePreviewCandidate({
      dex, pokemon: request.side.pokemon[0], opponentPreviewSpecies: previewFoes, megaCapable: true,
      analysis, teamSlot: 1,
      leadIntel: {foeLeads: [
        {species: 'Metagross', types: ['Steel', 'Psychic'], memory: {seen: 12, wins: 7, losses: 5, leads: 4}},
        {species: 'Charizard', types: ['Fire', 'Flying'], memory: null},
      ]},
    });
    expect(text).toContain('as a lead: speed 60 (rank 4 of your 4) — outruns 1/6 foe base speeds (fastest foe base 120; base stats only, natures/EVs/items unknown)');
    expect(text).toContain('vs probable foe leads: hits Metagross 2x (Drill Run); threatened by Charizard 4x (potential Fire STAB)');
    expect(text).toContain('memory: Metagross 12 battles (7W-5L)');
  });

  it('攻防展示上限不裁剪经验句：第三个有关系的预期首发仍保留经验', () => {
    const {request, analysis} = mkAnalysis();
    const text = describePreviewCandidate({
      dex, pokemon: request.side.pokemon[0], opponentPreviewSpecies: previewFoes, megaCapable: true,
      analysis, teamSlot: 1,
      leadIntel: {foeLeads: [
        {species: 'Metagross', types: ['Steel', 'Psychic'], memory: {seen: 12, wins: 7, losses: 5, leads: 4}},
        {species: 'Sneasler', types: ['Fighting', 'Poison'], memory: {seen: 9, wins: 4, losses: 5, leads: 3}},
        {species: 'Kingambit', types: ['Dark', 'Steel'], memory: {seen: 5, wins: 2, losses: 3, leads: 1}},
      ]},
    });
    expect(text).toContain('vs probable foe leads: hits Metagross 2x (Drill Run); hits Sneasler 2x (Drill Run)');
    expect(text).not.toContain('hits Kingambit');
    expect(text).toContain('memory: Metagross 12 battles (7W-5L), Sneasler 9 battles (4W-5L), Kingambit 5 battles (2W-3L)');
  });

  it('与预期首发无攻防关系时不输出对位与经验句（避免机械重复）', () => {
    const {request, analysis} = mkAnalysis();
    const text = describePreviewCandidate({
      dex, pokemon: request.side.pokemon[1], opponentPreviewSpecies: previewFoes, megaCapable: false,
      analysis, teamSlot: 2,
      leadIntel: {foeLeads: [{species: 'Charizard', types: ['Fire', 'Flying'], memory: {seen: 9, wins: 5, losses: 4, leads: 2}}]},
    });
    expect(text).toContain('as a lead: speed 100');
    expect(text).not.toContain('vs probable foe leads');
    expect(text).not.toContain('memory:');
  });

  it('速度或对手基础速度未知时按 unknown 退化', () => {
    const {request, analysis} = mkAnalysis();
    analysis.ourSpeeds[0].speed = null;
    const unknownSelf = describePreviewCandidate({
      dex, pokemon: request.side.pokemon[0], opponentPreviewSpecies: previewFoes, megaCapable: true,
      analysis, teamSlot: 1, leadIntel: {foeLeads: []},
    });
    expect(unknownSelf).toContain('as a lead: speed unknown');
    expect(unknownSelf).not.toContain('outruns');
    const {request: request2, analysis: analysis2} = mkAnalysis();
    analysis2.previewFoes = [];
    const unknownFoes = describePreviewCandidate({
      dex, pokemon: request2.side.pokemon[0], opponentPreviewSpecies: previewFoes, megaCapable: true,
      analysis: analysis2, teamSlot: 1, leadIntel: {foeLeads: []},
    });
    expect(unknownFoes).toContain('as a lead: speed 60 (rank 4 of your 4) — foe base speeds unknown');
  });

  it('L1 或缺省 leadIntel 时不输出该行', () => {
    const {request, analysis} = mkAnalysis(1);
    const l1 = describePreviewCandidate({
      dex, pokemon: request.side.pokemon[0], opponentPreviewSpecies: previewFoes, megaCapable: true,
      analysis, teamSlot: 1, leadIntel: {foeLeads: [{species: 'Metagross', types: ['Steel', 'Psychic'], memory: null}]},
    });
    expect(l1).not.toContain('as a lead:');
    const noIntel = describePreviewCandidate({
      dex, pokemon: request.side.pokemon[0], opponentPreviewSpecies: previewFoes, megaCapable: true,
      analysis, teamSlot: 1,
    });
    expect(noIntel).not.toContain('as a lead:');
  });
});

import {buildOpponentNotes} from '../src/state/opponent-notes.js';
import {emptyMemory} from '../src/learn/store.js';
import {parsePikaList, pikaToPriors} from '../src/dex/pikalytics.js';
import type {SpeedControl} from '../src/state/speed-control.js';

const pikaFixture = pikaToPriors(parsePikaList([{
  name: 'Victreebel', rank: '5', percent: '10', winPercent: '50', stats: {spe: 70},
  abilities: [{ability: 'Chlorophyll', percent: '60'}], items: [{item: 'Focus Sash', percent: '40'}],
  moves: [{move: 'Sludge Bomb', percent: '70'}], team: [], leads: [{pokemon: 'Victreebel', percent: '9.5'}],
}], '2026-05', 'f'));

describe('payload 对手注解注入', () => {
  it('L2 注入 notes 四栏并省略空栏；L1 不注入', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-item|p2a: Victreebel|Choice Scarf');
    tracker.handleLine('|move|p2a: Victreebel|Sludge Bomb|p1a: Golisopod');
    const request = mkRequest();
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1', priors: pikaFixture});
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

describe('buildPreviewQuestions 预期对手首发与交手战绩', () => {
  const leadPriors = () => pikaToPriors(parsePikaList([{
    name: 'Sneasler', rank: '2', percent: '30', winPercent: '50', stats: {spe: 120},
    abilities: [], items: [], moves: [], team: [], leads: [{pokemon: 'Sneasler', percent: '14.3'}],
  }], '2026-05', 'f'));
  const leadMemory = () => {
    const memory = emptyMemory();
    memory.species.sneasler = {name: 'Sneasler', seen: 9, wins: 4, losses: 5, leads: 3, items: {}, abilities: {}, moves: {}, notes: []};
    memory.cores['metagross+sneasler'] = {seen: 8, wins: 5, losses: 3, notes: []};
    return memory;
  };
  const previewRequest = () => {
    const request = mkRequest();
    request.teamPreview = true;
    return request;
  };
  const opponentSpecies = ['Victreebel', 'Charizard', 'Kingambit', 'Whimsicott', 'Sneasler', 'Metagross'];

  it('L2 合并先验与经验库：预期首发两来源标注、战绩与常见组合、指导句，并接线逐槽 as a lead', async () => {
    const {buildPreviewQuestions} = await import('../src/decide/team-preview.js');
    const request = previewRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 2});
    const set = buildPreviewQuestions({
      dex, request, opponentPreviewSpecies: opponentSpecies, analysis, priors: leadPriors(), memory: leadMemory(),
    });
    const instructions = set.questions.lead_1.instructions;
    expect(instructions).toContain('Most probable foe leads: Sneasler (prior lead rate 14.3%; led in 3 of 9 battles you played)');
    expect(instructions).toContain('Your recorded results: vs Sneasler 4W-5L; most common core Metagross+Sneasler 8 battles (5W-3L)');
    expect(instructions).toMatch(/do not reuse the same leads every game/);
    const slot1 = (set.questions.lead_1.criteria as Record<string, string>).slot_1;
    expect(slot1).toMatch(/as a lead: speed 60/);
    expect(slot1).toContain('hits Sneasler 2x (Drill Run)');
    expect(slot1).toContain('memory: Sneasler 9 battles (4W-5L)');
  });

  it('指导句只引用实际存在的分段：仅有常见组合时不提 leads，仅先验时不提 records', async () => {
    const {buildPreviewQuestions} = await import('../src/decide/team-preview.js');
    const request = previewRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 2});
    const memory = emptyMemory();
    memory.cores['charizard+victreebel'] = {seen: 4, wins: 2, losses: 2, notes: []};
    const coreOnly = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Victreebel', 'Charizard'], analysis, memory});
    const coreText = coreOnly.questions.lead_1.instructions;
    expect(coreText).toContain('most common core Charizard+Victreebel 4 battles (2W-2L)');
    expect(coreText).not.toContain('these leads');
    expect(coreText).toContain('(speed, your records)');
    const priorOnly = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Sneasler'], analysis, priors: leadPriors()});
    const priorText = priorOnly.questions.lead_1.instructions;
    expect(priorText).toContain('(speed, type matchups against these leads)');
    expect(priorText).not.toContain('your records');
  });

  it('退化：缺经验库只用先验、缺先验只用经验库、两者皆缺无经验段（逐槽速度行仍输出）', async () => {
    const {buildPreviewQuestions} = await import('../src/decide/team-preview.js');
    const request = previewRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 2});
    const base = {dex, request, opponentPreviewSpecies: ['Sneasler'], analysis};
    const priorOnly = buildPreviewQuestions({...base, priors: leadPriors()});
    expect(priorOnly.questions.lead_1.instructions).toContain('Sneasler (prior lead rate 14.3%)');
    expect(priorOnly.questions.lead_1.instructions).not.toContain('battles you played');
    expect(priorOnly.questions.lead_1.instructions).not.toContain('recorded results');
    const memoryOnly = buildPreviewQuestions({...base, memory: leadMemory()});
    expect(memoryOnly.questions.lead_1.instructions).toContain('Sneasler (led in 3 of 9 battles you played)');
    expect(memoryOnly.questions.lead_1.instructions).toContain('vs Sneasler 4W-5L');
    const neither = buildPreviewQuestions(base);
    expect(neither.questions.lead_1.instructions).not.toContain('Most probable foe leads');
    expect(neither.questions.lead_1.instructions).not.toContain('recorded results');
    expect((neither.questions.lead_1.criteria as Record<string, string>).slot_1).toContain('as a lead: speed 60');
  });

  it('L1 不输出经验段与逐槽 as a lead 行', async () => {
    const {buildPreviewQuestions} = await import('../src/decide/team-preview.js');
    const request = previewRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 1});
    const set = buildPreviewQuestions({
      dex, request, opponentPreviewSpecies: ['Sneasler'], analysis, priors: leadPriors(), memory: leadMemory(),
    });
    expect(set.questions.lead_1.instructions).not.toContain('Most probable foe leads');
    expect((set.questions.lead_1.criteria as Record<string, string>).slot_1).not.toContain('as a lead:');
  });
});

import type {PriorMeta} from '../src/dex/priors.js';

describe('buildPreviewQuestions 预期 Mega 形态对位', () => {
  const golisopodPriors: PriorMeta = {
    label: 'x',
    bySpecies: {golisopod: {items: [
      {name: 'グソクムシャナイト', percent: 98.6, gloss: 'Allows Golisopod to Mega Evolve into Mega Golisopod.', mega: true},
    ], abilities: [], moves: [], leads: []}},
  };
  it('有先验时 slot 描述与引导句包含对 Mega 形态的超效招式；无先验不输出', async () => {
    const {buildPreviewQuestions} = await import('../src/decide/team-preview.js');
    const request = mkRequest();
    request.teamPreview = true;
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 2});
    const set = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Golisopod'], analysis, priors: golisopodPriors});
    const criteria = set.questions.lead_1.criteria as Record<string, string>;
    expect(criteria.slot_2).toContain('likely-form coverage');
    expect(criteria.slot_2).toContain('Heat Wave (Fire) hits likely Golisopod-Mega [Bug/Steel] 4x');
    expect(set.questions.lead_1.instructions).toMatch(/vary your lead pair/);
    const none = buildPreviewQuestions({dex, request, opponentPreviewSpecies: ['Golisopod'], analysis});
    expect((none.questions.lead_1.criteria as Record<string, string>).slot_2).not.toContain('likely-form coverage');
    expect(none.questions.lead_1.instructions).not.toContain('likely-form coverage');
  });
});

describe('buildPreviewQuestions 对手群攻警示', () => {
  const previewRequest = () => {
    const request = mkRequest();
    request.teamPreview = true;
    return request;
  };

  it('L2 且传入 opponentSpreadThreats 时输出群攻警示、我方群攻清单与对攻引导', async () => {
    const {buildPreviewQuestions} = await import('../src/decide/team-preview.js');
    const request = previewRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 2});
    const set = buildPreviewQuestions({
      dex, request, opponentPreviewSpecies: ['Farigiraf'], analysis,
      opponentSpreadThreats: ['Farigiraf Expanding Force 62.3% (spread only while Psychic Terrain is active)'],
    });
    const text = set.questions.lead_1.instructions;
    expect(text).toContain('Farigiraf Expanding Force 62.3%');
    expect(text).toMatch(/spread moves hit both foes at once and ignore redirection/i);
    expect(text).toMatch(/Follow Me cannot redirect them/i);
    expect(text).toMatch(/avoid a lead pair that is both weak to the same spread move/i);
    expect(text).toMatch(/answer with your own spread moves/i);
    expect(text).toMatch(/instead of trading single-target hits/i);
    expect(text).toContain('Chandelure Heat Wave');
    expect(text).toContain('Tyranitar Rock Slide');
    expect(text).toContain('Salamence Hyper Voice');
  });

  it('我方广域战力标注展开条件；无群攻先验或 L1 不输出', async () => {
    const {buildPreviewQuestions} = await import('../src/decide/team-preview.js');
    const data = mkDex();
    data.moves.expandingforce = {name: 'Expanding Force', type: 'Psychic', basePower: 80, category: 'Special', target: 'normal', priority: 0};
    const request = previewRequest();
    request.side.pokemon[1].moves = [...(request.side.pokemon[1].moves ?? []), 'expandingforce'];
    const state = mkTracker().state;
    const analysis = buildAnalysisContext({dex: data, request, state, level: 2});
    const set = buildPreviewQuestions({
      dex: data, request, opponentPreviewSpecies: ['Farigiraf'], analysis,
      opponentSpreadThreats: ['Farigiraf Expanding Force 62.3%'],
    });
    expect(set.questions.lead_1.instructions).toContain('Chandelure Expanding Force (spread only while Psychic Terrain is active and the user is grounded)');
    const none = buildPreviewQuestions({dex: data, request, opponentPreviewSpecies: ['Farigiraf'], analysis});
    expect(none.questions.lead_1.instructions).not.toContain('Opponent spread threats');
    const legacy = buildPreviewQuestions({
      dex: data, request, opponentPreviewSpecies: ['Farigiraf'],
      opponentSpreadThreats: ['Farigiraf Expanding Force 62.3%'],
    });
    expect(legacy.questions.lead_1.instructions).not.toContain('Opponent spread threats');
    const l1Set = buildPreviewQuestions({
      dex: data, request, opponentPreviewSpecies: ['Farigiraf'],
      analysis: buildAnalysisContext({dex: data, request, state, level: 1}),
      opponentSpreadThreats: ['Farigiraf Expanding Force 62.3%'],
    });
    expect(l1Set.questions.lead_1.instructions).not.toContain('Opponent spread threats');
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
  it('对手顺风激活时戏法空间注解提示可反转其速度优势', () => {
    const base = {dex, moveId: 'trickroom', moveName: 'Trick Room', pp: 5, maxpp: 5, attackerTypes: ['Ghost']};
    const withFoeTw = describeMoveOption({...base, speedControl: {...emptySpeedControl, opponent_tailwind: {started_turn: 2, turns_left: 3}}});
    expect(withFoeTw).toContain("the foe's Tailwind is active");
    expect(withFoeTw).toMatch(/inverts the acting order/);
    expect(withFoeTw).toMatch(/doubled Speed would work against them/);
    const noTw = describeMoveOption({...base, speedControl: emptySpeedControl});
    expect(noTw).not.toContain("the foe's Tailwind is active");
    const activeTr = describeMoveOption({...base, speedControl: {...emptySpeedControl, trick_room: {started_turn: 3, turns_left: 4}, opponent_tailwind: {started_turn: 2, turns_left: 3}}});
    expect(activeTr).not.toContain("the foe's Tailwind is active");
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

describe('戏法空间收益事实注解', () => {
  const trickRoomChoice = (extra: Partial<Parameters<typeof describeMoveOption>[0]>) => describeMoveOption({
    dex, moveId: 'trickroom', moveName: 'Trick Room', pp: 5, maxpp: 5, attackerTypes: ['Ghost', 'Fire'], ...extra,
  });
  const baseAnalysis = () => buildAnalysisContext({dex, request: mkRequest(), state: mkTracker().state, level: 2});

  it('我方慢速成员低于对手在场者中性档位时，给出空间下先手事实与在场标记', () => {
    const text = trickRoomChoice({
      attackerSlot: 2, analysis: baseAnalysis(),
      ourLiveSpeeds: [
        {species: 'Golisopod', speed: 60, active: true},
        {species: 'Tyranitar', speed: 82, active: false},
        {species: 'Chandelure', speed: 100, active: true},
        {species: 'Salamence', speed: 152, active: false},
      ],
    });
    expect(text).toContain('under Trick Room your slower Pokemon act first');
    expect(text).toContain('Golisopod (estimated speed 60, on the field)');
    expect(text).toContain('Tyranitar (estimated speed 82, on the bench)');
    expect(text).toContain('Chandelure (estimated speed 100, on the field)');
    expect(text).not.toContain('Salamence (estimated');
    expect(text).toContain("both foes' neutral full-investment tiers (Victreebel 122, Charizard 152)");
    expect(text).toMatch(/would move before the foes/);
  });

  it('残局只剩一个对手时改用单数基准与 remaining foe', () => {
    const tracker = mkTracker();
    tracker.handleLine('|faint|p2b: Charizard');
    const analysis = buildAnalysisContext({dex, request: mkRequest(), state: tracker.state, level: 2});
    const text = trickRoomChoice({attackerSlot: 2, analysis, ourLiveSpeeds: [{species: 'Golisopod', speed: 60, active: true}]});
    expect(text).toContain("foe Victreebel's neutral full-investment tier (122)");
    expect(text).toMatch(/would move before the remaining foe/);
  });

  it('无慢于对手档位的成员或数据不足时不输出收益行（机制注解保留）', () => {
    const analysis = baseAnalysis();
    const fast = trickRoomChoice({attackerSlot: 2, analysis, ourLiveSpeeds: [{species: 'Salamence', speed: 200, active: false}]});
    expect(fast).not.toContain('your slower Pokemon act first');
    expect(fast).toMatch(/5 turns/);
    const noSlot = trickRoomChoice({analysis, ourLiveSpeeds: [{species: 'Golisopod', speed: 60, active: true}]});
    expect(noSlot).not.toContain('your slower Pokemon act first');
    const noSpeeds = trickRoomChoice({attackerSlot: 2, analysis});
    expect(noSpeeds).not.toContain('your slower Pokemon act first');
  });

  it('空间已激活时不输出收益行，只保留重开取消警示', () => {
    const text = trickRoomChoice({
      attackerSlot: 2, analysis: baseAnalysis(),
      ourLiveSpeeds: [{species: 'Golisopod', speed: 60, active: true}],
      speedControl: {...emptySpeedControl, trick_room: {started_turn: 3, turns_left: 4}},
    });
    expect(text).toMatch(/already active/);
    expect(text).not.toContain('your slower Pokemon act first');
  });
});

describe('喷火类招式：血量缩放威力与出手顺序注解', () => {
  const damageOf = (label: string) => Number(/≈(\d+)% damage/.exec(label)![1]);
  it('按当前血量给出真实威力，且伤害估算随血量下降', () => {
    const base = {
      dex, moveId: 'eruption', moveName: 'Eruption', pp: 5, maxpp: 5,
      attackerTypes: ['Ghost', 'Fire'], attackerStats: {spa: 145},
      target: {label: 'Foe A', species: 'Charizard', hpPercent: 92},
    };
    const full = describeMoveOption({...base, attackerHpPercent: 100});
    const mid = describeMoveOption({...base, attackerHpPercent: 73});
    const low = describeMoveOption({...base, attackerHpPercent: 50});
    expect(mid).toContain("Eruption's power scales with your HP when it resolves: ≈109 BP at your current 73% HP, about 15 BP per 10% HP lost");
    expect(damageOf(low)).toBeLessThan(damageOf(mid));
    expect(damageOf(mid)).toBeLessThan(damageOf(full));
  });
  it('对手标准档位更快且后手会削血时，重算出招时血量与威力', () => {
    const request = mkRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 1});
    analysis.ourSpeeds[0].speed = 36;
    analysis.oppSpeedEstimates[0].baseSpeed = 120;
    analysis.threats[0].incoming[0].roughPercent = 38;
    const label = describeMoveOption({
      dex, moveId: 'eruption', moveName: 'Eruption', pp: 5, maxpp: 5,
      attackerTypes: ['Bug', 'Steel'], attackerStats: {spa: 70},
      target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100, ident: 'p2: Victreebel'},
      analysis, attackerSlot: 1, attackerHpPercent: 73,
    });
    expect(label).toContain('Victreebel (neutral full-investment 172) outruns your estimated speed 36');
    expect(label).toContain('if it hits you first for ≈38% (revealed moves only), this resolves at ≈35% HP and ≈52 BP');
  });
  it('后手伤害足以击倒时不承诺出招；未揭示来袭时只给无数字的弱化提示', () => {
    const request = mkRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 1});
    analysis.ourSpeeds[0].speed = 36;
    analysis.oppSpeedEstimates[0].baseSpeed = 120;
    const labelWith = (rough: number | null) => {
      analysis.threats[0].incoming[0].roughPercent = rough;
      return describeMoveOption({
        dex, moveId: 'eruption', moveName: 'Eruption', pp: 5, maxpp: 5,
        attackerTypes: ['Bug', 'Steel'], attackerStats: {spa: 70},
        target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100, ident: 'p2: Victreebel'},
        analysis, attackerSlot: 1, attackerHpPercent: 73,
      });
    };
    const lethal = labelWith(80);
    expect(lethal).toContain('a first hit for ≈80% (revealed moves only) would KO you before this resolves');
    expect(lethal).not.toContain('this resolves at');
    const unknown = labelWith(null);
    expect(unknown).toContain('outruns your estimated speed 36: if it damages you first, this move resolves weaker');
    expect(unknown).not.toContain('revealed moves only');
  });
  it('Trick Room 激活时按反转后的出手顺序提示，不再用 outruns', () => {
    const request = mkRequest();
    const analysis = buildAnalysisContext({dex, request, state: mkTracker().state, level: 1});
    analysis.oppSpeedEstimates[0].baseSpeed = 120;
    const base = {
      dex, moveId: 'eruption', moveName: 'Eruption', pp: 5, maxpp: 5,
      attackerTypes: ['Bug', 'Steel'], attackerStats: {spa: 70},
      target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100, ident: 'p2: Victreebel'},
      analysis, attackerSlot: 1, attackerHpPercent: 73,
      speedControl: {...emptySpeedControl, trick_room: {started_turn: 3, turns_left: 4}},
    };
    analysis.ourSpeeds[0].speed = 36;
    const slower = describeMoveOption(base);
    expect(slower).toContain('under the active Trick Room your estimated speed 36 acts before Victreebel (neutral full-investment 172)');
    expect(slower).not.toContain('outruns');
    analysis.ourSpeeds[0].speed = 200;
    const faster = describeMoveOption(base);
    expect(faster).toContain('under the active Trick Room the slower side moves first: Victreebel (neutral full-investment 172) would likely act before your estimated speed 200');
    expect(faster).not.toContain('outruns');
  });
  it('非缩放招式或缺省血量参数时不输出缩放与速度注解', () => {
    const heat = describeMoveOption({
      dex, moveId: 'heatwave', moveName: 'Heat Wave', pp: 10, maxpp: 10,
      attackerTypes: ['Ghost', 'Fire'], attackerStats: {spa: 145},
      target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100},
      attackerHpPercent: 73,
    });
    expect(heat).not.toContain('scales with your HP');
    const legacy = describeMoveOption({
      dex, moveId: 'eruption', moveName: 'Eruption', pp: 5, maxpp: 5,
      attackerTypes: ['Bug', 'Steel'], attackerStats: {spa: 70},
      target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100, ident: 'p2: Victreebel'},
      analysis: buildAnalysisContext({dex, request: mkRequest(), state: mkTracker().state, level: 1}),
      attackerSlot: 1,
    });
    expect(legacy).not.toContain('scales with your HP');
    expect(legacy).not.toContain('outruns');
  });
});
