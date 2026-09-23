import {describe, expect, it} from 'vitest';
import {buildAnalysisContext} from '../src/state/analysis.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

function setup() {
  return {dex: mkDex(), request: mkRequest(), state: mkTracker().state, level: 2 as const};
}

function sixTeam() {
  const input = setup();
  input.dex.species.rotomwash.baseSpecies = 'Rotom';
  input.request.side.pokemon.push(
    {ident: 'p1: Excadrill', details: 'Excadrill, L50', condition: '180/180', active: false,
      stats: {spe: 120}, moves: ['ironhead', 'highhorsepower', 'protect', 'rockslide'], item: 'focussash', ability: 'sandrush'},
    {ident: 'p1: Rotom-Wash', details: 'Rotom-Wash, L50', condition: '130/130', active: false,
      stats: {spe: 90}, moves: ['electroweb', 'thunderbolt', 'voltswitch', 'hydropump'], item: 'magnet', ability: 'levitate'},
  );
  return input;
}

describe('buildAnalysisContext 速度与稳定索引', () => {
  it('使用 request 实际数值为基准，围巾只乘一次，不修改输入', () => {
    const input = setup();
    const before = structuredClone(input);
    const analysis = buildAnalysisContext(input);
    expect(analysis.ourSpeeds[2]).toMatchObject({slot: 3, ident: 'p1: Tyranitar', requestSpeed: 82, speed: 123});
    expect(analysis.ourSpeeds[2].notes.join(' ')).toMatch(/Choice Scarf.*1.5/);
    expect(input).toEqual(before);
  });
  it('速度阶级先取整，围巾与顺风合并修正，麻痹最后取整', () => {
    const input = setup();
    const mon = input.request.side.pokemon[0];
    mon.stats!.spe = 101;
    mon.item = 'choicescarf';
    mon.condition = '150/150 par';
    input.state.sides.p1.pokemon[0].boosts.spe = 1;
    input.state.sides.p1.sideConditions = ['move: Tailwind'];
    const speed = buildAnalysisContext(input).ourSpeeds[0];
    expect(speed.speed).toBe(226);
    expect(speed.notes.join(' ')).toMatch(/boost.*Tailwind.*paralysis/i);
  });
  it('Sand Rush 仅当前沙暴生效，天气被压制时不擅自倍速', () => {
    const input = sixTeam();
    expect(buildAnalysisContext(input).ourSpeeds[4].speed).toBe(120);
    input.state.weather = 'Sandstorm';
    expect(buildAnalysisContext(input).ourSpeeds[4].speed).toBe(240);
    input.state.sides.p2.pokemon[0].ability = 'Cloud Nine';
    expect(buildAnalysisContext(input).ourSpeeds[4].speed).toBe(120);
    input.state.weather = 'none';
    expect(buildAnalysisContext(input).ourSpeeds[4].speed).toBe(120);
  });
  it.each([
    {active: true, baseAbility: 'Sand Rush', condition: '180/180', expectedSpeed: 120},
    {active: false, baseAbility: 'Sand Rush', condition: '180/180', expectedSpeed: 120},
    {active: true, baseAbility: 'Quick Feet', condition: '180/180 par', expectedSpeed: 60},
    {active: false, baseAbility: 'Quick Feet', condition: '180/180 par', expectedSpeed: 60},
  ])('已 Mega 且缺当前特性时不套用旧 $baseAbility（active=$active）', ({active, baseAbility, condition, expectedSpeed}) => {
    const input = sixTeam();
    const mon = input.request.side.pokemon[4];
    mon.active = active;
    mon.baseAbility = baseAbility;
    mon.condition = condition;
    delete mon.ability;
    const tracked = input.state.sides.p1.pokemon[4];
    tracked.mega = true;
    tracked.activePos = active ? 0 : -1;
    delete tracked.ability;
    input.state.weather = 'Sandstorm';
    const speed = buildAnalysisContext(input).ourSpeeds[4];
    expect(speed).toMatchObject({requestSpeed: 120, speed: expectedSpeed, uncertain: true});
    expect(speed.notes.join(' ')).toMatch(/uncertain|unmodeled/i);
    expect(speed.notes.join(' ')).not.toContain('Sand Rush');
    if (condition.includes('par')) expect(speed.notes.join(' ')).toContain('paralysis x0.5');
  });
  it.each([
    {mega: false, ability: undefined, expectedSpeed: 240, uncertain: true},
    {mega: true, ability: 'Sand Rush', expectedSpeed: 240, uncertain: false},
    {mega: true, ability: 'Sand Force', expectedSpeed: 120, uncertain: false},
  ])('保留未 Mega 的基础特性回退和明确当前特性（mega=$mega，ability=$ability）', ({mega, ability, expectedSpeed, uncertain}) => {
    const input = sixTeam();
    const mon = input.request.side.pokemon[4];
    mon.baseAbility = 'Sand Rush';
    mon.ability = ability;
    input.state.sides.p1.pokemon[4].mega = mega;
    input.state.weather = 'Sandstorm';
    expect(buildAnalysisContext(input).ourSpeeds[4]).toMatchObject({speed: expectedSpeed, uncertain});
  });
  it('不按物种串联同种个体或把替补旧能力阶级套在当前上场者', () => {
    const input = setup();
    input.request.side.pokemon[0].ident = 'p1: Twin';
    input.state.sides.p1.pokemon[0].boosts.spe = 6;
    input.state.sides.p1.pokemon.push({...structuredClone(input.state.sides.p1.pokemon[0]), ident: 'p1: Twin', name: 'Twin', boosts: {spe: -1}});
    expect(buildAnalysisContext(input).ourSpeeds[0].speed).toBe(40);
    input.request.side.pokemon[0].active = false;
    expect(buildAnalysisContext(input).ourSpeeds[0].speed).toBe(60);
  });
  it('不支持的修正明确标不确定，缺 request 速度不冒充种族速度', () => {
    const input = setup();
    input.request.side.pokemon[0].ability = 'Unburden';
    input.state.sides.p1.pokemon[0].volatiles = ['Unburden'];
    delete input.request.side.pokemon[1].stats;
    const analysis = buildAnalysisContext(input);
    expect(analysis.ourSpeeds[0].uncertain).toBe(true);
    expect(analysis.ourSpeeds[0].notes.join(' ')).toMatch(/unmodeled|uncertain/i);
    expect(analysis.ourSpeeds[1].speed).toBeNull();
  });
  it('对手只输出未修正种族速度，已揭示围巾不产生实际速度结论', () => {
    const input = setup();
    input.state.sides.p2.pokemon[0].item = 'Choice Scarf';
    const analysis = buildAnalysisContext(input);
    expect(analysis.oppSpeedEstimates[0]).toMatchObject({ident: 'p2: Victreebel', baseSpeed: 70, speed: null});
    expect(analysis.oppSpeedEstimates[0].notes.join(' ')).toMatch(/Choice Scarf/);
    expect(JSON.stringify(analysis)).not.toMatch(/you move first|outspeeds|you move second/);
    expect(analysis.previewFoes[0]).toMatchObject({itemRevealed: 'Choice Scarf', abilityRevealed: null});
  });
});

describe('buildAnalysisContext 双向克制和 incoming', () => {
  it('区分我方已知招式、对手属性潜在 STAB 与已揭示招式', () => {
    const input = setup();
    input.state.sides.p2.pokemon[1].revealedMoves = ['Heat Wave'];
    const analysis = buildAnalysisContext(input);
    const threat = analysis.threats[0];
    expect(threat).toMatchObject({slot: 1, ident: 'p1: Golisopod'});
    expect(threat.outgoing.some(m => m.foeSpecies === 'Whimsicott' && m.move === 'Iron Head' && m.multiplier === 2)).toBe(true);
    expect(threat.potentialStab.find(m => m.foeSpecies === 'Charizard')).toMatchObject({multiplier: 4});
    expect(threat.incoming.find(m => m.foeSpecies === 'Victreebel')?.roughPercent).toBeNull();
    expect(threat.incoming.find(m => m.foeSpecies === 'Charizard')).toMatchObject({revealedMoves: ['Heat Wave'], unknownMoves: []});
    expect(threat.incoming.find(m => m.foeSpecies === 'Charizard')!.roughPercent).toBeGreaterThan(0);
  });
  it('无克制与缺资料不同：完整的中性结果为 1，缺 dex 为 null', () => {
    const input = setup();
    input.state.sides.p2.pokemon = [input.state.sides.p2.pokemon[0]];
    expect(buildAnalysisContext(input).threats[0].potentialStab[0].multiplier).toBe(0.25);
    delete input.dex.species.victreebel;
    const analysis = buildAnalysisContext(input);
    expect(analysis.previewFoes[0].baseSpeed).toBeNull();
    expect(analysis.threats[0].potentialStab[0].multiplier).toBeNull();
    expect(analysis.threats[0].outgoing.every(m => m.multiplier === null)).toBe(true);
  });
  it('未知招式与仅揭示状态招式不能转成零威胁，免疫伤害可为零', () => {
    const input = setup();
    input.state.sides.p2.pokemon[0].revealedMoves = ['Unknown Attack', 'Protect'];
    let incoming = buildAnalysisContext(input).threats[0].incoming[0];
    expect(incoming.roughPercent).toBeNull();
    expect(incoming.unknownMoves).toEqual(['Unknown Attack']);
    input.state.sides.p2.pokemon[0].revealedMoves = ['Sludge Bomb'];
    incoming = buildAnalysisContext(input).threats[0].incoming[0];
    expect(incoming.roughPercent).toBe(0);
  });
  it('缺失属性表保持未知，不生成全无弱点的假结论', () => {
    const input = setup();
    input.dex.typechart = {};
    const analysis = buildAnalysisContext(input);
    expect(analysis.threats[0].potentialStab.every(m => m.multiplier === null)).toBe(true);
  });
});

describe('buildAnalysisContext 条件化角色', () => {
  it('L1 无角色注解，L2/L3 数据相同且仅为当前 request 队伍生成', () => {
    const input = setup();
    expect(buildAnalysisContext({...input, level: 1}).teamNotes).toEqual([]);
    const l2 = buildAnalysisContext({...input, level: 2});
    const l3 = buildAnalysisContext({...input, level: 3});
    expect(l3.teamNotes).toEqual(l2.teamNotes);
    expect(l2.teamNotes.map(n => n.slot)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(l2.teamNotes)).not.toMatch(/Excadrill|Rotom/);
  });
  it('六只的注解受实际招式、道具、特性控制，不许绝对先手或永久沙暴', () => {
    const input = sixTeam();
    const notes = buildAnalysisContext(input).teamNotes.map(n => n.notes.join(' '));
    expect(notes[0]).toMatch(/Sucker Punch.*only if/i);
    expect(notes[0]).toMatch(/Emergency Exit.*before Mega/i);
    expect(notes[1]).toMatch(/Trick Room.*priority bracket/i);
    expect(notes[2]).toMatch(/Sand Stream.*temporary/i);
    expect(notes[2]).toMatch(/Choice Scarf.*move lock/i);
    expect(notes[4]).toMatch(/Sand Rush.*sandstorm/i);
    expect(notes[4]).toMatch(/Focus Sash.*full HP/i);
    expect(notes[5]).toMatch(/Electroweb.*Trick Room.*counterproductive/i);
    expect(notes.join(' ')).not.toMatch(/permanent|fastest|guarantees survival|synergy with Trick Room/);
  });
  it.each(['teammate', 'field'] as const)('真实 Rotom-Wash 谱系保留四项角色注解（Trick Room 来源：%s）', source => {
    const input = sixTeam();
    expect(input.dex.species.rotomwash.baseSpecies).toBe('Rotom');
    if (source === 'field') {
      input.request.side.pokemon[1].moves = ['shadowball'];
      input.state.fieldConditions = ['move: Trick Room'];
    }
    const note = buildAnalysisContext(input).teamNotes[5];
    expect(note).toMatchObject({slot: 6, species: 'Rotom-Wash'});
    expect(note.notes).toEqual(expect.arrayContaining([
      expect.stringMatching(/Levitate.*Ground immunity/),
      expect.stringMatching(/Volt Switch.*pivot/),
      expect.stringMatching(/Electroweb can lower opposing speed/),
      expect.stringMatching(/Electroweb with Trick Room.*counterproductive/),
    ]));
  });
  it('数据驱动：非旧白名单物种按自身配置获得场地/消耗/受降/戏法注解', () => {
    const input = setup();
    input.dex.species.indeedee = {name: 'Indeedee', types: ['Psychic', 'Normal'], baseStats: {hp: 60, atk: 65, def: 55, spa: 105, spd: 95, spe: 85}, abilities: {0: 'Psychic Surge'}};
    input.dex.species.milotic = {name: 'Milotic', types: ['Water'], baseStats: {hp: 95, atk: 60, def: 79, spa: 100, spd: 125, spe: 81}, abilities: {0: 'Competitive'}};
    input.request.side.pokemon.push(
      {ident: 'p1: Indeedee', details: 'Indeedee, L50, M', condition: '167/167', active: false,
        stats: {spe: 115}, moves: ['expandingforce', 'protect', 'mysticalfire', 'trick'], item: 'choicescarf', ability: 'psychicsurge'},
      {ident: 'p1: Sneasler', details: 'Sneasler, L50, F', condition: '187/187', active: false,
        stats: {spe: 142}, moves: ['closecombat', 'direclaw', 'trick', 'coaching'], item: 'whiteherb', ability: 'unburden'},
      {ident: 'p1: Milotic', details: 'Milotic, L50, M', condition: '190/190', active: false,
        stats: {spe: 115}, moves: ['muddywater', 'coil', 'hypnosis', 'recover'], item: 'leftovers', ability: 'competitive'},
    );
    const notes = buildAnalysisContext(input).teamNotes;
    const indeedee = notes[4].notes.join(' ');
    expect(indeedee).toMatch(/Psychic Surge.*Psychic Terrain/i);
    expect(indeedee).toMatch(/Expanding Force.*spread/i);
    expect(indeedee).toMatch(/Choice Scarf.*move lock/i);
    expect(indeedee).toMatch(/Trick.*Choice Scarf.*locked into one move/i);
    const sneasler = notes[5].notes.join(' ');
    expect(sneasler).toMatch(/Unburden.*consumed/i);
    expect(sneasler).toMatch(/Trick swaps held items/i);
    const milotic = notes[6].notes.join(' ');
    expect(milotic).toMatch(/Competitive.*Special Attack/i);
    expect(notes.slice(4).map(n => n.notes.join(' ')).join(' ')).not.toMatch(/permanent|fastest/);
  });
  it('天气争夺：沙暴可被对手覆盖、重入场可抢回，并关联 Sand Rush 的速度得失', () => {
    const input = sixTeam();
    const notes = buildAnalysisContext(input).teamNotes[2].notes.join(' ');
    expect(notes).toMatch(/Sand Stream.*contested/i);
    expect(notes).toMatch(/re-sets sandstorm/i);
    expect(notes).toMatch(/overwrite a foe's weather/i);
    expect(notes).toMatch(/Sand Rush.*double speed/i);
  });
  it('场地争夺：精神场地可被对手替换、重入场可抢回，并关联 Expanding Force 收益', () => {
    const input = setup();
    input.dex.species.indeedee = {name: 'Indeedee', types: ['Psychic', 'Normal'], baseStats: {hp: 60, atk: 65, def: 55, spa: 105, spd: 95, spe: 85}, abilities: {0: 'Psychic Surge'}};
    input.request.side.pokemon.push(
      {ident: 'p1: Indeedee', details: 'Indeedee, L50, M', condition: '167/167', active: false,
        stats: {spe: 115}, moves: ['expandingforce', 'protect'], item: 'choicescarf', ability: 'psychicsurge'},
    );
    const notes = buildAnalysisContext(input).teamNotes[4].notes.join(' ');
    expect(notes).toMatch(/Psychic Surge.*contested/i);
    expect(notes).toMatch(/re-sets Psychic Terrain/i);
    expect(notes).toMatch(/overwrite a foe's terrain/i);
    expect(notes).toMatch(/Expanding Force spread bonus/i);
  });
  it('数据驱动：形态变体按自身当前招式与特性获得注解，不依赖物种标签', () => {
    const input = setup();
    input.dex.species.golisopodother = {...input.dex.species.golisopod, name: 'Golisopod-Other', baseSpecies: 'Golisopod'};
    input.request.side.pokemon[0].details = 'Golisopod-Other, L50';
    const notes = buildAnalysisContext(input).teamNotes[0].notes.join(' ');
    expect(notes).toMatch(/Sucker Punch.*only if/i);
    expect(notes).toMatch(/Emergency Exit.*before Mega/i);
  });
  it('配置变化后不遗留旧注解，半血气腰不承诺保命', () => {
    const input = sixTeam();
    input.request.side.pokemon[1].moves = ['shadowball'];
    input.request.side.pokemon[2].item = '';
    input.request.side.pokemon[2].ability = 'Unnerve';
    input.request.side.pokemon[4].condition = '90/180';
    input.request.side.pokemon[5].moves = ['hydropump'];
    const notes = buildAnalysisContext(input).teamNotes;
    expect(notes[1].notes.join(' ')).not.toContain('Trick Room');
    expect(notes[2].notes.join(' ')).not.toMatch(/Sand Stream|Choice Scarf/);
    expect(notes[4].notes.join(' ')).toMatch(/Focus Sash.*not at full HP/i);
    expect(notes[5].notes.join(' ')).not.toMatch(/Electroweb|Volt Switch/);
  });
  it('基础形态加正确 Mega 石匹配别名；错误石头不声称 Mega 特性', () => {
    const input = setup();
    const notes = buildAnalysisContext(input).teamNotes[3].notes.join(' ');
    expect(notes).toMatch(/Intimidate.*before Mega/);
    expect(notes).toMatch(/Salamencite.*Aerilate.*Hyper Voice/);
    input.request.side.pokemon[3].item = 'leftovers';
    expect(buildAnalysisContext(input).teamNotes[3].notes.join(' ')).not.toMatch(/Aerilate|Salamencite/);
    input.request.side.pokemon[3].details = 'Salamence-Mega, L50';
    input.request.side.pokemon[3].item = 'salamencite';
    expect(buildAnalysisContext(input).teamNotes[3].notes.join(' ')).toContain('Aerilate');
  });
  it('已 Mega 后按已知当前特性注解，不再次宣称将来进化或当前没有 Aerilate', () => {
    const input = setup();
    input.request.side.pokemon[3].details = 'Salamence-Mega, L50';
    input.request.side.pokemon[3].ability = 'Aerilate';
    input.state.sides.p1.pokemon[3].mega = true;
    input.state.sides.p1.megaUsed = true;
    const text = buildAnalysisContext(input).teamNotes[3].notes.join(' ');
    expect(text).toMatch(/already Mega Evolved/);
    expect(text).toMatch(/current Aerilate.*Hyper Voice/);
    expect(text).not.toMatch(/Mega option|not the current ability/);
  });
  it('已用掉 Mega 后其他候选不再获得未来 Mega 特性的战术加成', () => {
    const input = setup();
    input.state.sides.p1.megaUsed = true;
    const text = buildAnalysisContext(input).teamNotes[3].notes.join(' ');
    expect(text).toMatch(/Mega unavailable/);
    expect(text).not.toMatch(/Mega option|post-Mega Aerilate/);
  });
  it('已 Mega 而当前特性未给出时，不拿 baseAbility 当当前事实', () => {
    const input = setup();
    input.request.side.pokemon[0].baseAbility = 'Emergency Exit';
    delete input.request.side.pokemon[0].ability;
    input.state.sides.p1.pokemon[0].mega = true;
    input.state.sides.p1.pokemon[0].ability = 'Tough Claws';
    expect(buildAnalysisContext(input).teamNotes[0].notes.join(' ')).not.toContain('Emergency Exit');
  });
  it('未知物种不会借用旧队伍角色', () => {
    const input = setup();
    input.request.side.pokemon[0].details = 'Missingno, L50';
    expect(buildAnalysisContext(input).teamNotes[0].notes).toEqual([]);
  });
});

describe('buildAnalysisContext 新增条件注解（Reg M-C 热点）', () => {
  function withBench() {
    const input = setup();
    input.dex.species.incineroar = {name: 'Incineroar', types: ['Fire', 'Dark'], baseStats: {hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60}, abilities: {0: 'Intimidate'}} as any;
    input.dex.species.amoonguss = {name: 'Amoonguss', types: ['Grass', 'Poison'], baseStats: {hp: 114, atk: 85, def: 70, spa: 85, spd: 80, spe: 30}, abilities: {0: 'Regenerator'}} as any;
    input.request.side.pokemon.push(
      {ident: 'p1: Incineroar', details: 'Incineroar, L50, M', condition: '180/180', active: false,
        stats: {spe: 80}, moves: ['fakeout', 'knockoff', 'partingshot', 'flareblitz'], item: 'sitrusberry', ability: 'intimidate'},
      {ident: 'p1: Amoonguss', details: 'Amoonguss, L50, F', condition: '196/196', active: false,
        stats: {spe: 50}, moves: ['ragepowder', 'wideguard', 'coaching', 'sludgebomb'], item: 'grassyseed', ability: 'regenerator'},
    );
    return input;
  }
  it('Incineroar：先制阻挡、折返换场、道具移除', () => {
    const notes = buildAnalysisContext(withBench()).teamNotes;
    const text = notes[4].notes.join(' ');
    expect(text).toMatch(/Fake Out.*first turn/i);
    expect(text).toMatch(/Quick Guard/i);
    expect(text).toMatch(/Parting Shot.*switch/i);
    expect(text).toMatch(/Knock Off.*item/i);
  });
  it('Amoonguss：转移、守护、帮手与自身单体指向', () => {
    const notes = buildAnalysisContext(withBench()).teamNotes;
    const text = notes[5].notes.join(' ');
    expect(text).toMatch(/Follow Me|Rage Powder/i);
    expect(text).toMatch(/Wide Guard.*spread/i);
    expect(text).toMatch(/Coaching/i);
  });
  it('顺风/灭歌/哈欠/极光幕/天气球/种子 各有条件触发', () => {
    const input = setup();
    input.request.side.pokemon.push(
      {ident: 'p1: Corviknight', details: 'Corviknight, L50', condition: '187/187', active: false,
        stats: {spe: 90}, moves: ['tailwind', 'yawn', 'auroraveil', 'uturn'], item: 'leftovers', ability: 'pressure'},
      {ident: 'p1: Sableye', details: 'Sableye, L50', condition: '135/135', active: false,
        stats: {spe: 70}, moves: ['perishsong', 'weatherball', 'flipturn', 'quickguard'], item: 'grassyseed', ability: 'unburden'},
    );
    input.state.weather = 'RainDance';
    const notes = buildAnalysisContext(input).teamNotes;
    const corv = notes[4].notes.join(' ');
    expect(corv).toMatch(/Tailwind.*speed/i);
    expect(corv).toMatch(/Yawn.*sleep|Yawn.*switch/i);
    expect(corv).toMatch(/Aurora Veil.*halves/i);
    expect(corv).toMatch(/U-turn|Flip Turn|pivot/i);
    const sableye = notes[5].notes.join(' ');
    expect(sableye).toMatch(/Perish Song.*countdown/i);
    expect(sableye).toMatch(/Weather Ball|weather/i);
    expect(sableye).toMatch(/seed.*Unburden|Unburden.*seed/i);
    const joined = notes.slice(4).map(n => n.notes.join(' ')).join(' ');
    expect(joined).not.toMatch(/permanent|fastest|guarantees survival|synergy with Trick Room/);
  });
  it('没有条件就没有注解（不编造）', () => {
    const input = setup(); // 默认队伍含 suckerpunch（priority>0）与 heatwave（spread），会触发 Quick/Wide Guard，但不含下列
    const notes = buildAnalysisContext(input).teamNotes.map(n => n.notes.join(' ')).join(' ');
    expect(notes).not.toMatch(/Fake Out|Perish Song|Aurora Veil|Tailwind/);
  });
});
