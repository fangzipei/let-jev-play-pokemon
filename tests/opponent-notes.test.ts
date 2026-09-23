import {describe, expect, it} from 'vitest';
import {parsePikaList} from '../src/dex/pikalytics.js';
import {buildOpponentNotes, leadPriorLines} from '../src/state/opponent-notes.js';
import {BattleTracker} from '../src/state/tracker.js';
import {mkDex, mkTracker} from './helpers.js';

// 与 pikalytics.test.ts 的 LIST_FIXTURE 保持一致，此处本地定义：
// 跨测试文件 import 会让被导入文件的 describe/it 在本文件重复注册（计数翻倍）。
export const LIST_FIXTURE = [
  {
    name: 'Sneasler', rank: '2', percent: '36.64', winPercent: '49.784',
    types: ['fighting', 'poison'], stats: {hp: 80, atk: 130, def: 60, spa: 40, spd: 80, spe: 120},
    abilities: [{ability: 'Poison Touch', percent: '47.449'}, {ability: 'Unburden', percent: '31.2'}],
    items: [{item: 'Grassy Seed', item_us: 'Grassy_Seed', percent: '31.711'}, {item: 'White Herb', percent: '19.2'}],
    moves: [{move: 'Close Combat', percent: '49.932', type: 'fighting'}, {move: 'Fake Out', percent: '30.2', type: 'normal'}],
    team: [{pokemon: 'Rillaboom', types: ['grass'], rank: '4', percent: '42.694'}],
    leads: [{pokemon: 'Sneasler', games: 230, percent: '14.259', winPercent: '44.8'}],
  },
  {
    name: 'Metagross-Mega', rank: '9', percent: '5.1', winPercent: '50',
    stats: {spe: 110}, abilities: [{ability: 'Tough Claws', percent: '99'}],
    items: [], moves: [], team: [], leads: [],
  },
];

function trackerWithTurn2() {
  const tracker = mkTracker();
  for (const line of [
    '|turn|2',
    '|move|p2a: Victreebel|Sludge Bomb|p1a: Golisopod',
    '|-damage|p1a: Golisopod|92/150',
    '|move|p2b: Charizard|Heat Wave|p1a: Golisopod|p1b: Chandelure',
    '|-damage|p1a: Golisopod|62/150',
    '|-damage|p1b: Chandelure|110/135',
    '|-status|p1a: Golisopod|psn',
    '|turn|3',
    '|switch|p2a: Kingambit|Kingambit, L50|100/100',
    '|-item|p2a: Victreebel|Focus Sash',
    '|-enditem|p2a: Victreebel|Focus Sash',
  ]) tracker.handleLine(line);
  return tracker;
}

describe('buildOpponentNotes confirmed（局内记忆）', () => {
  it('聚合已揭示道具/特性/招式/Mega，未揭示不编造', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-item|p2a: Victreebel|Choice Scarf');
    tracker.handleLine('|-ability|p2a: Victreebel|Chlorophyll');
    tracker.handleLine('|move|p2a: Victreebel|Sludge Bomb|p1a: Golisopod');
    tracker.handleLine('|-mega|p2b: Charizard|Charizard-Mega-Y');
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(notes['p2: Victreebel'].confirmed).toEqual([
      'item confirmed: Choice Scarf',
      'ability confirmed: Chlorophyll',
      'moves seen: Sludge Bomb',
    ]);
    expect(notes['p2: Charizard'].confirmed).toEqual(['Mega evolved']);
    expect(notes['p2: Metagross'].confirmed).toEqual([]);
  });
  it('一次性道具消耗记录名字并标注已用', () => {
    const tracker = trackerWithTurn2();
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(notes['p2: Victreebel'].confirmed.join(' | '))
      .toContain('item consumed: Focus Sash (one-time item already used)');
  });
});

describe('buildOpponentNotes recent_actions（读操作）', () => {
  it('最近回合的对手出招、结果与换人，按个体挂载', () => {
    const tracker = trackerWithTurn2();
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(notes['p2: Victreebel'].recent_actions).toEqual(['turn 2: used Sludge Bomb → our Golisopod 61% HP']);
    expect(notes['p2: Charizard'].recent_actions).toEqual(['turn 2: used Heat Wave → our Golisopod 41% HP, our Chandelure 81% HP']);
    expect(notes['p2: Kingambit'].recent_actions).toEqual(['turn 3: switched in']);
    expect(notes['p2: Victreebel'].recent_actions.join(' ')).not.toContain('Focus Sash');
  });
  it('状态变化与全局上限 5 条、单只上限 2 条', () => {
    const tracker = mkTracker();
    for (const line of [
      '|turn|2',
      '|move|p2a: Victreebel|Sludge Bomb|p1a: Golisopod',
      '|-damage|p1a: Golisopod|92/150',
      '|-status|p1a: Golisopod|psn',
      '|turn|3',
      '|move|p2a: Victreebel|Sludge Bomb|p1a: Golisopod',
      '|-damage|p1a: Golisopod|62/150',
      '|turn|4',
      '|move|p2a: Victreebel|Sludge Bomb|p1a: Golisopod',
      '|-damage|p1a: Golisopod|32/150',
    ]) tracker.handleLine(line);
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(notes['p2: Victreebel'].recent_actions).toEqual([
      'turn 3: used Sludge Bomb → our Golisopod 41% HP',
      'turn 4: used Sludge Bomb → our Golisopod 21% HP',
    ]);
  });
  it('spread 招式按 [spread] 槽位展开：两个受击目标都记录伤害', () => {
    const tracker = mkTracker();
    for (const line of [
      '|turn|5',
      '|move|p2a: Victreebel|Rock Slide|p1b: Chandelure|[spread] p1a,p1b',
      '|-damage|p1a: Golisopod|84/150',
      '|-damage|p1b: Chandelure|44/135',
    ]) tracker.handleLine(line);
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(notes['p2: Victreebel'].recent_actions)
      .toEqual(['turn 5: used Rock Slide → our Chandelure 33% HP, our Golisopod 56% HP']);
  });
  it('同名跨侧不互相覆盖：spread 命中我方与对手 ally 分别归位', () => {
    const tracker = new BattleTracker('battle-mirror', 'JevBot1234');
    for (const line of [
      '|player|p1|JevBot1234|1|1500',
      '|player|p2|rival|2|1500',
      '|poke|p1|Incineroar, L50, M|', '|poke|p1|Rillaboom, L50, M|',
      '|poke|p2|Charizard, L50, M|', '|poke|p2|Incineroar, L50, M|',
      '|start',
      '|switch|p1a: Incineroar|Incineroar, L50, M|100/100',
      '|switch|p1b: Rillaboom|Rillaboom, L50, M|100/100',
      '|switch|p2a: Charizard|Charizard, L50, M|100/100',
      '|switch|p2b: Incineroar|Incineroar, L50, M|100/100',
      '|turn|7',
      '|move|p2a: Charizard|Earthquake|p1a: Incineroar|[spread] p1a,p1b,p2b',
      '|-damage|p1a: Incineroar|45/100',
      '|-damage|p1b: Rillaboom|60/100',
      '|-damage|p2b: Incineroar|70/100',
    ]) tracker.handleLine(line);
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(notes['p2: Charizard'].recent_actions).toEqual([
      'turn 7: used Earthquake → our Incineroar 45% HP, our Rillaboom 60% HP, its ally Incineroar 70% HP',
    ]);
  });
  it('自目标招式（Tailwind/Protect）虽无伤害结果也产生动作事件', () => {
    const tracker = mkTracker();
    for (const line of [
      '|turn|2',
      '|move|p2b: Charizard|Tailwind|p2b: Charizard',
      '|move|p2a: Victreebel|Protect|p2a: Victreebel',
    ]) tracker.handleLine(line);
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(notes['p2: Charizard'].recent_actions).toEqual(['turn 2: used Tailwind']);
    expect(notes['p2: Victreebel'].recent_actions).toEqual(['turn 2: used Protect']);
  });
  it('preview 阶段（turn 0）无 confirmed/recent 内容', () => {
    const tracker = mkTracker();
    tracker.state.turn = 0;
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(notes['p2: Victreebel']?.confirmed ?? []).toEqual([]);
  });
});

const pika = parsePikaList(LIST_FIXTURE, '2026-05', 'gen9championsvgc2026regmc');

describe('buildOpponentNotes assumed（先验假设）', () => {
  it('未见道具/特性与常见招式给出 top 值并标注来源', () => {
    const tracker = mkTracker(); // turn 1，非 preview
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1', pika});
    const sneasler = notes['p2: Sneasler'].assumed.join(' | ');
    expect(sneasler).toContain('item unseen — likely Grassy Seed 31.7% / White Herb 19.2%');
    expect(sneasler).toContain('ability unseen — likely Poison Touch 47.4% / Unburden 31.2%');
    expect(sneasler).toContain('commonly runs: Close Combat 49.9% / Fake Out 30.2%');
    expect(sneasler).toContain('(prior: Pikalytics 2026-05)');
    expect(notes['p2: Metagross'].assumed.join(' | ')).toContain('Tough Claws');
  });
  it('已揭示道具/特性/招式不再给假设；preview 阶段给首发放行', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-item|p2a: Sneasler|Grassy Seed');
    tracker.handleLine('|-ability|p2a: Sneasler|Unburden');
    tracker.handleLine('|move|p2a: Sneasler|Close Combat|p1a: Golisopod');
    let notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1', pika});
    const text = notes['p2: Sneasler'].assumed.join(' | ');
    expect(text).not.toContain('item unseen');
    expect(text).not.toContain('ability unseen');
    expect(text).not.toContain('Close Combat');
    tracker.state.turn = 0;
    notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1', pika});
    expect(notes['p2: Sneasler'].assumed.join(' | ')).toContain('commonly leads');
  });
  it('Mega 后缀双向兜底匹配；无先验条目为空；pika 为 null 全空', () => {
    const megaOnly = parsePikaList([{
      name: 'Metagross-Mega', rank: '9', percent: '5.1', winPercent: '50', stats: {spe: 110},
      abilities: [{ability: 'Tough Claws', percent: '99'}], items: [{item: 'Metagrossite', percent: '98'}], moves: [], team: [], leads: [],
    }], '2026-05', 'f');
    const tracker = mkTracker();
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1', pika: megaOnly});
    expect(notes['p2: Metagross'].assumed.join(' | ')).toContain('Metagrossite');
    expect(notes['p2: Sneasler'].assumed).toEqual([]);
    const none = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'});
    expect(none['p2: Metagross'].assumed).toEqual([]);
  });

  const megaDex = () => {
    const dex = mkDex();
    dex.species.metagrossmega = {
      name: 'Metagross-Mega', types: ['Steel', 'Psychic'],
      baseStats: {hp: 80, atk: 145, def: 150, spa: 105, spd: 110, spe: 110},
      abilities: {0: 'Tough Claws'}, baseSpecies: 'Metagross', requiredItem: 'Metagrossite',
    };
    return dex;
  };

  const megaPika = (withLeads = false) => parsePikaList([{
    name: 'Metagross-Mega', rank: '9', percent: '5.1', winPercent: '50',
    stats: {hp: 80, atk: 145, def: 150, spa: 105, spd: 110, spe: 110},
    abilities: [{ability: 'Tough Claws', percent: '99'}],
    items: [{item: 'Metagrossite', percent: '98'}, {item: 'Leftovers', percent: '2'}],
    moves: [{move: 'Iron Head', percent: '55', type: 'steel'}],
    team: [],
    leads: withLeads ? [{pokemon: 'Metagross', games: 10, percent: '22.5', winPercent: '50'}] : [],
  }], '2026-05', 'f');

  it('先验道具含 Mega 石时给出 Mega 威胁：形态、特性与速度变化', () => {
    const notes = buildOpponentNotes({state: mkTracker().state, ourSideId: 'p1', pika: megaPika(), dex: megaDex()});
    const text = notes['p2: Metagross'].assumed.join(' | ');
    expect(text).toMatch(/mega threat/i);
    expect(text).toContain('Metagross-Mega');
    expect(text).toContain('Tough Claws');
    expect(text).toMatch(/Speed 110 \(from 70\)/);
    expect(text).toContain('Metagrossite 98.0%');
    expect(text).toContain('(prior: Pikalytics 2026-05)');
  });

  it('道具已揭示或已消耗、对手已用 Mega、缺 dex 时不输出 Mega 威胁', () => {
    const noDex = buildOpponentNotes({state: mkTracker().state, ourSideId: 'p1', pika: megaPika()});
    expect(noDex['p2: Metagross'].assumed.join(' | ')).not.toMatch(/mega threat/i);
    const revealed = mkTracker();
    revealed.handleLine('|-item|p2c: Metagross|Leftovers');
    const revealedText = buildOpponentNotes({state: revealed.state, ourSideId: 'p1', pika: megaPika(), dex: megaDex()})['p2: Metagross'].assumed.join(' | ');
    expect(revealedText).not.toMatch(/mega threat/i);
    const consumed = mkTracker();
    consumed.handleLine('|-item|p2c: Metagross|Metagrossite');
    consumed.handleLine('|-enditem|p2c: Metagross|Metagrossite');
    const consumedText = buildOpponentNotes({state: consumed.state, ourSideId: 'p1', pika: megaPika(), dex: megaDex()})['p2: Metagross'].assumed.join(' | ');
    expect(consumedText).not.toMatch(/mega threat/i);
    const used = mkTracker();
    used.handleLine('|-mega|p2b: Charizard|Charizard-Mega-Y');
    const usedText = buildOpponentNotes({state: used.state, ourSideId: 'p1', pika: megaPika(), dex: megaDex()})['p2: Metagross'].assumed.join(' | ');
    expect(usedText).not.toMatch(/mega threat/i);
  });

  it('preview 时 Mega 威胁与 leads 等先验同时保留，不被上限挤掉', () => {
    const tracker = mkTracker();
    tracker.state.turn = 0;
    const text = buildOpponentNotes({state: tracker.state, ourSideId: 'p1', pika: megaPika(true), dex: megaDex()})['p2: Metagross'].assumed.join(' | ');
    expect(text).toMatch(/mega threat/i);
    expect(text).toContain('commonly leads');
  });
});

describe('leadPriorLines', () => {
  it('按 leads 占比降序取 top，未命中不输出', () => {
    expect(leadPriorLines(pika, ['Sneasler', 'Metagross-Mega', 'Unknownmon'], 3)).toEqual(['Sneasler 14.3%']);
    expect(leadPriorLines(null, ['Sneasler'])).toEqual([]);
  });
});

const controlPika = parsePikaList([{
  name: 'Whimsicott', rank: '7', percent: '8', winPercent: '50', stats: {spe: 116},
  abilities: [{ability: 'Prankster', percent: '88.1'}],
  items: [{item: 'Focus Sash', percent: '50.2'}],
  moves: [{move: 'Tailwind', percent: '72.3'}, {move: 'Moonblast', percent: '60.1'}, {move: 'Encore', percent: '40.4'}],
  team: [], leads: [],
}], '2026-05', 'f');

const weatherPika = parsePikaList([{
  name: 'Victreebel', rank: '5', percent: '10', winPercent: '50', stats: {spe: 70},
  abilities: [{ability: 'Chlorophyll', percent: '8.0'}, {ability: 'Solar Power', percent: '10.2'}],
  items: [], moves: [], team: [], leads: [],
}], '2026-05', 'f');

describe('buildOpponentNotes 控速预警', () => {
  it('已揭示但未激活的控速招式给出语义解读', () => {
    const tracker = mkTracker();
    tracker.handleLine('|move|p2a: Victreebel|Tailwind|p2b: Charizard');
    const confirmed = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'})['p2: Victreebel'].confirmed.join(' | ');
    expect(confirmed).toContain('moves seen: Tailwind');
    expect(confirmed).toMatch(/speed-control threat/);
    expect(confirmed).toMatch(/not active now/);
    expect(confirmed).toMatch(/doubles its side's Speed for 4 turns/);
  });
  it('已揭示且激活中的控速不重复解读（剩余回合由 speed_control 呈现）', () => {
    const tracker = mkTracker();
    for (const line of ['|move|p2a: Victreebel|Tailwind|p2b: Charizard', '|-sidestart|p2: opponent|move: Tailwind']) {
      tracker.handleLine(line);
    }
    const confirmed = buildOpponentNotes({state: tracker.state, ourSideId: 'p1'})['p2: Victreebel'].confirmed.join(' | ');
    expect(confirmed).toContain('moves seen: Tailwind');
    expect(confirmed).not.toMatch(/speed-control threat/);
  });
  it('先验招式含控速时预警，commonly runs 不重复列出', () => {
    const text = buildOpponentNotes({state: mkTracker().state, ourSideId: 'p1', pika: controlPika})
      ['p2: Whimsicott'].assumed.join(' | ');
    expect(text).toMatch(/speed-control threat/);
    expect(text).toMatch(/likely Tailwind 72.3%/);
    expect(text).toMatch(/4 turns/);
    expect(text).toMatch(/\(prior: Pikalytics 2026-05\)/);
    expect(text).not.toMatch(/commonly runs:[^|]*Tailwind/);
    expect(text).toContain('commonly runs: Moonblast 60.1% / Encore 40.4%');
  });
  it('未揭示的天气速度特性在当前天气下预警；已揭示或不匹配时不预警', () => {
    const sunny = mkTracker();
    sunny.handleLine('|-weather|SunnyDay');
    const text = buildOpponentNotes({state: sunny.state, ourSideId: 'p1', pika: weatherPika})
      ['p2: Victreebel'].assumed.join(' | ');
    expect(text).toMatch(/speed-control threat/);
    expect(text).toMatch(/likely Chlorophyll 8.0%/);
    expect(text).toMatch(/SunnyDay/);
    expect(text).toMatch(/double/);
    const revealed = mkTracker();
    revealed.handleLine('|-ability|p2a: Victreebel|Chlorophyll');
    revealed.handleLine('|-weather|SunnyDay');
    expect(buildOpponentNotes({state: revealed.state, ourSideId: 'p1', pika: weatherPika})
      ['p2: Victreebel'].assumed.join(' | ')).not.toMatch(/likely Chlorophyll/);
    expect(buildOpponentNotes({state: mkTracker().state, ourSideId: 'p1', pika: weatherPika})
      ['p2: Victreebel'].assumed.join(' | ')).not.toMatch(/speed-control threat/);
  });
});

import {emptyMemory, mergeObservation} from '../src/learn/store.js';
import type {BattleObservation} from '../src/learn/extract.js';

const OBS: BattleObservation = {
  battleId: 'b1', won: false,
  ourSpecies: ['Golisopod'],
  opponentSpecies: ['Sneasler', 'Rillaboom', 'Metagross'],
  opponentMegaSpecies: [],
  revealed: [{species: 'Sneasler', item: 'Grassy Seed', ability: 'Unburden', moves: [], itemConsumed: false, led: true}],
};

describe('buildOpponentNotes memory（跨局经验）', () => {
  it('物种条与配队条挂到对应对手，上限 3 条', () => {
    const memory = emptyMemory();
    mergeObservation(memory, OBS);
    const tracker = mkTracker();
    const notes = buildOpponentNotes({state: tracker.state, ourSideId: 'p1', memory});
    const sneasler = notes['p2: Sneasler'].memory.join(' | ');
    expect(sneasler).toContain('Sneasler (1 battles seen)');
    expect(sneasler).toContain('Grassy Seed');
    expect(sneasler).toContain('core (1 battles seen)');
    expect(notes['p2: Sneasler'].memory.length).toBeLessThanOrEqual(3);
    expect(notes['p2: Victreebel'].memory).toEqual([]);
  });
  it('memory 为 null 或空库时不输出', () => {
    const tracker = mkTracker();
    expect(buildOpponentNotes({state: tracker.state, ourSideId: 'p1'})['p2: Sneasler'].memory).toEqual([]);
    expect(buildOpponentNotes({state: tracker.state, ourSideId: 'p1', memory: emptyMemory()})['p2: Sneasler'].memory).toEqual([]);
  });
});
