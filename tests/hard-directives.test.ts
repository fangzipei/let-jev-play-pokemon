import {beforeEach, describe, expect, it} from 'vitest';
import type {DexData} from '../src/dex/index.js';
import {applyPreviewDirectives, collectTurnDirectives, resetHardDirectives} from '../src/decide/hard-directives.js';
import {buildTurnPlans} from '../src/decide/turn.js';
import type {BattleRequest} from '../src/state/request.js';
import {mkDex, mkTrackerWithLines} from './helpers.js';

/** 在 mkDex 上补充硬指令相关物种（场地手 Indeedee、慢速目标 Torkoal、Milotic） */
function mkDirectiveDex(): DexData {
  const dex = mkDex();
  dex.species.indeedee = {name: 'Indeedee', types: ['Psychic', 'Normal'], baseStats: {hp: 60, atk: 65, def: 55, spa: 105, spd: 95, spe: 85}, abilities: {0: 'Psychic Surge'}};
  dex.species.milotic = {name: 'Milotic', types: ['Water'], baseStats: {hp: 95, atk: 60, def: 79, spa: 100, spd: 125, spe: 81}, abilities: {0: 'Marvel Scale'}};
  dex.species.torkoal = {name: 'Torkoal', types: ['Fire'], baseStats: {hp: 70, atk: 85, def: 140, spa: 85, spd: 70, spe: 20}, abilities: {0: 'Drought'}};
  return dex;
}

/** 预览请求：给定顺序的 6 只参赛宝可梦（全部未上场） */
function mkPreviewRequest(names: string[]): BattleRequest {
  return {
    teamPreview: true,
    side: {
      name: 'JevBot1234',
      id: 'p1',
      pokemon: names.map(name => ({
        ident: `p1: ${name}`, details: `${name}, L50, M`, condition: '100/100', active: false,
      })),
    },
    rqid: 5,
  };
}

const PREVIEW_TEAM = ['Indeedee', 'Milotic', 'Salamence', 'Golisopod', 'Tyranitar', 'Chandelure'];

const MILOTIC_STATS = {atk: 60, def: 79, spa: 100, spd: 125, spe: 81};
const SALAMENCE_STATS = {atk: 135, def: 100, spa: 110, spd: 100, spe: 100};

/** 持讲究围巾的 Indeedee 在场（Trick 可选）+ Milotic 同伴 */
function mkTrickRequest(): BattleRequest {
  return {
    active: [
      {moves: [
        {move: 'Trick', id: 'trick', pp: 10, maxpp: 10, target: 'normal'},
        {move: 'Moonblast', id: 'moonblast', pp: 15, maxpp: 15, target: 'normal'},
        {move: 'Follow Me', id: 'followme', pp: 20, maxpp: 20, target: 'self'},
        {move: 'Helping Hand', id: 'helpinghand', pp: 20, maxpp: 20, target: 'adjacentAlly'},
      ]},
      {moves: [
        {move: 'Muddy Water', id: 'muddywater', pp: 10, maxpp: 10, target: 'allAdjacentFoes'},
        {move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self'},
      ]},
    ],
    side: {
      name: 'JevBot1234',
      id: 'p1',
      pokemon: [
        {ident: 'p1: Indeedee', details: 'Indeedee, L50, M', condition: '145/145', active: true, stats: {atk: 65, def: 55, spa: 105, spd: 95, spe: 85}, item: 'choicescarf', ability: 'psychicsurge', moves: ['trick', 'moonblast', 'followme', 'helpinghand']},
        {ident: 'p1: Milotic', details: 'Milotic, L50, F', condition: '175/175', active: true, stats: MILOTIC_STATS, ability: 'marvelscale', moves: ['muddywater', 'protect']},
        {ident: 'p1: Salamence', details: 'Salamence, L50, M', condition: '170/170', active: false, stats: SALAMENCE_STATS, moves: ['protect', 'hypervoice']},
        {ident: 'p1: Golisopod', details: 'Golisopod, L50, M', condition: '150/150', active: false, moves: ['ironhead']},
      ],
    },
    rqid: 9,
  };
}

const TRICK_FOES = [
  '|poke|p1|Indeedee, L50, M|',
  '|poke|p1|Milotic, L50, F|',
  '|poke|p1|Salamence, L50, M|',
  '|poke|p1|Golisopod, L50, M|',
  '|poke|p2|Amoonguss, L50, F|',
  '|poke|p2|Torkoal, L50, M|',
  '|teampreview|4',
  '|teamsize|p1|4',
  '|teamsize|p2|4',
  '|start',
  '|switch|p1a: Indeedee|Indeedee, L50, M|145/145',
  '|switch|p1b: Milotic|Milotic, L50, F|175/175',
  '|switch|p2a: Amoonguss|Amoonguss, L50, F|200/200',
  '|switch|p2b: Torkoal|Torkoal, L50, M|160/160',
  '|turn|2',
];

/** Coil 强化在身的 Milotic 在场，Hypnosis 可选 */
function mkHypnosisRequest(): BattleRequest {
  return {
    active: [
      {moves: [
        {move: 'Hypnosis', id: 'hypnosis', pp: 20, maxpp: 20, target: 'normal'},
        {move: 'Muddy Water', id: 'muddywater', pp: 10, maxpp: 10, target: 'allAdjacentFoes'},
        {move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self'},
        {move: 'Coil', id: 'coil', pp: 20, maxpp: 20, target: 'self'},
      ]},
      {moves: [
        {move: 'Hyper Voice', id: 'hypervoice', pp: 10, maxpp: 10, target: 'allAdjacentFoes'},
        {move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self'},
      ]},
    ],
    side: {
      name: 'JevBot1234',
      id: 'p1',
      pokemon: [
        {ident: 'p1: Milotic', details: 'Milotic, L50, F', condition: '175/175', active: true, stats: MILOTIC_STATS, ability: 'marvelscale', moves: ['hypnosis', 'muddywater', 'protect', 'coil']},
        {ident: 'p1: Salamence', details: 'Salamence, L50, M', condition: '170/170', active: true, stats: SALAMENCE_STATS, moves: ['hypervoice', 'protect']},
        {ident: 'p1: Indeedee', details: 'Indeedee, L50, M', condition: '145/145', active: false, item: 'choicescarf', moves: ['trick']},
        {ident: 'p1: Golisopod', details: 'Golisopod, L50, M', condition: '150/150', active: false, moves: ['ironhead']},
      ],
    },
    rqid: 11,
  };
}

const HYPNOSIS_FOES = [
  '|poke|p1|Milotic, L50, F|',
  '|poke|p1|Salamence, L50, M|',
  '|poke|p1|Indeedee, L50, M|',
  '|poke|p1|Golisopod, L50, M|',
  '|poke|p2|Kingambit, L50, F|',
  '|poke|p2|Sneasler, L50, F|',
  '|teampreview|4',
  '|teamsize|p1|4',
  '|teamsize|p2|4',
  '|start',
  '|switch|p1a: Milotic|Milotic, L50, F|175/175',
  '|switch|p1b: Salamence|Salamence, L50, M|170/170',
  '|switch|p2a: Kingambit|Kingambit, L50, F|200/200',
  '|switch|p2b: Sneasler|Sneasler, L50, F|160/160',
  '|turn|2',
  '|-boost|p1a: Milotic|accuracy|1',
  '|-boost|p1a: Milotic|atk|1',
  '|-boost|p1a: Milotic|def|1',
];

/** 对手场地覆盖时，存活替补里有场地手 Indeedee（HP 更低的 Milotic 在场） */
function mkTerrainRequest(): BattleRequest {
  return {
    active: [
      {moves: [{move: 'Muddy Water', id: 'muddywater', pp: 10, maxpp: 10, target: 'allAdjacentFoes'}]},
      {moves: [{move: 'Hyper Voice', id: 'hypervoice', pp: 10, maxpp: 10, target: 'allAdjacentFoes'}]},
    ],
    side: {
      name: 'JevBot1234',
      id: 'p1',
      pokemon: [
        {ident: 'p1: Milotic', details: 'Milotic, L50, F', condition: '120/175', active: true, stats: MILOTIC_STATS, ability: 'marvelscale', moves: ['muddywater']},
        {ident: 'p1: Salamence', details: 'Salamence, L50, M', condition: '170/170', active: true, stats: SALAMENCE_STATS, moves: ['hypervoice']},
        {ident: 'p1: Indeedee', details: 'Indeedee, L50, M', condition: '145/145', active: false, item: 'choicescarf', ability: 'psychicsurge', moves: ['trick']},
        {ident: 'p1: Golisopod', details: 'Golisopod, L50, M', condition: '150/150', active: false, moves: ['ironhead']},
      ],
    },
    rqid: 12,
  };
}

function mkTerrainFoes(fieldLine: string): string[] {
  return [
    '|poke|p1|Milotic, L50, F|',
    '|poke|p1|Salamence, L50, M|',
    '|poke|p1|Indeedee, L50, M|',
    '|poke|p1|Golisopod, L50, M|',
    '|poke|p2|Rillaboom, L50, M|',
    '|poke|p2|Torkoal, L50, M|',
    '|teampreview|4',
    '|teamsize|p1|4',
    '|teamsize|p2|4',
    '|start',
    '|switch|p1a: Milotic|Milotic, L50, F|120/175',
    '|switch|p1b: Salamence|Salamence, L50, M|170/170',
    '|switch|p2a: Rillaboom|Rillaboom, L50, M|200/200',
    '|switch|p2b: Torkoal|Torkoal, L50, M|160/160',
    '|turn|1',
    fieldLine,
  ];
}

/** 暴飞龙在场（Tailwind 可选）+ Milotic 同伴；对手无慢速 Trick/强化催眠干扰 */
function mkTailwindRequest(): BattleRequest {
  return {
    active: [
      {moves: [
        {move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self'},
        {move: 'Hyper Voice', id: 'hypervoice', pp: 10, maxpp: 10, target: 'allAdjacentFoes'},
        {move: 'Tailwind', id: 'tailwind', pp: 15, maxpp: 15, target: 'allySide'},
        {move: 'Draco Meteor', id: 'dracometeor', pp: 5, maxpp: 5, target: 'normal'},
      ]},
      {moves: [
        {move: 'Muddy Water', id: 'muddywater', pp: 10, maxpp: 10, target: 'allAdjacentFoes'},
      ]},
    ],
    side: {
      name: 'JevBot1234',
      id: 'p1',
      pokemon: [
        {ident: 'p1: Salamence', details: 'Salamence, L50, M', condition: '170/170', active: true, stats: SALAMENCE_STATS, ability: 'intimidate', moves: ['protect', 'hypervoice', 'tailwind', 'dracometeor']},
        {ident: 'p1: Milotic', details: 'Milotic, L50, F', condition: '175/175', active: true, stats: MILOTIC_STATS, ability: 'marvelscale', moves: ['muddywater']},
        {ident: 'p1: Indeedee', details: 'Indeedee, L50, M', condition: '145/145', active: false, moves: ['trick']},
        {ident: 'p1: Golisopod', details: 'Golisopod, L50, M', condition: '150/150', active: false, moves: ['ironhead']},
      ],
    },
    rqid: 13,
  };
}

const TAILWIND_FOES = [
  '|poke|p1|Salamence, L50, M|',
  '|poke|p1|Milotic, L50, F|',
  '|poke|p1|Indeedee, L50, M|',
  '|poke|p1|Golisopod, L50, M|',
  '|poke|p2|Kingambit, L50, F|',
  '|poke|p2|Sneasler, L50, F|',
  '|teampreview|4',
  '|teamsize|p1|4',
  '|teamsize|p2|4',
  '|start',
  '|switch|p1a: Salamence|Salamence, L50, M|170/170',
  '|switch|p1b: Milotic|Milotic, L50, F|175/175',
  '|switch|p2a: Kingambit|Kingambit, L50, F|200/200',
  '|switch|p2b: Sneasler|Sneasler, L50, F|160/160',
  '|turn|2',
];

beforeEach(() => resetHardDirectives());

describe('硬指令 H1：场地手不连续首发', () => {
  it('上一局首发了场地手时，本局把场地手移出前两位', () => {
    const dex = mkDirectiveDex();
    const request = mkPreviewRequest(PREVIEW_TEAM);
    const first = applyPreviewDirectives({dex, request, order: [1, 2, 3, 4]});
    expect(first.order).toEqual([1, 2, 3, 4]);
    expect(first.notes).toEqual([]);

    const second = applyPreviewDirectives({dex, request, order: [1, 2, 3, 4]});
    expect(second.order).toEqual([3, 2, 1, 4]);
    expect(second.notes.some(n => n.includes('hard:lead-rotate'))).toBe(true);
  });

  it('场地手在第二位时同样移出前两位', () => {
    const dex = mkDirectiveDex();
    const request = mkPreviewRequest(PREVIEW_TEAM);
    applyPreviewDirectives({dex, request, order: [1, 2, 3, 4]});
    const second = applyPreviewDirectives({dex, request, order: [2, 1, 3, 4]});
    expect(second.order).toEqual([2, 3, 1, 4]);
  });

  it('上一局没有首发场地手时不做调整', () => {
    const dex = mkDirectiveDex();
    const request = mkPreviewRequest(PREVIEW_TEAM);
    const first = applyPreviewDirectives({dex, request, order: [2, 3, 1, 4]});
    expect(first.order).toEqual([2, 3, 1, 4]);
    const second = applyPreviewDirectives({dex, request, order: [1, 2, 3, 4]});
    expect(second.order).toEqual([1, 2, 3, 4]);
  });

  it('resetHardDirectives 清空跨局状态', () => {
    const dex = mkDirectiveDex();
    const request = mkPreviewRequest(PREVIEW_TEAM);
    applyPreviewDirectives({dex, request, order: [1, 2, 3, 4]});
    resetHardDirectives();
    const next = applyPreviewDirectives({dex, request, order: [1, 2, 3, 4]});
    expect(next.order).toEqual([1, 2, 3, 4]);
  });
});

describe('硬指令 H2：给慢速对手套讲究围巾', () => {
  it('持围巾且 Trick 可用、对手有慢速目标时强制 Trick 指向最慢者', () => {
    const dex = mkDirectiveDex();
    const request = mkTrickRequest();
    const tracker = mkTrackerWithLines(TRICK_FOES);
    const plans = buildTurnPlans({dex, request, tracker});
    const directives = collectTurnDirectives({dex, request, tracker, plans});
    const trick = directives.find(d => d.slot === 1);
    expect(trick?.key).toBe('move_1_foe_b');
    expect(trick?.note).toContain('hard:trick');
    expect(trick?.note).toContain('Torkoal');
  });

  it('对手没有慢速目标时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTrickRequest();
    const tracker = mkTrackerWithLines(TRICK_FOES.map(line =>
      line.replace('Amoonguss, L50, F', 'Charizard, L50, M').replace('Torkoal, L50, M', 'Sneasler, L50, F')));
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('不持讲究围巾时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTrickRequest();
    request.side.pokemon[0].item = 'lifeorb';
    const tracker = mkTrackerWithLines(TRICK_FOES);
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('已锁招（Trick 不在可选招式中）时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTrickRequest();
    request.active![0].moves = [{move: 'Moonblast', id: 'moonblast', pp: 15, maxpp: 15, target: 'normal'}];
    const tracker = mkTrackerWithLines(TRICK_FOES);
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('Trick PP 耗尽时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTrickRequest();
    request.active![0].moves[0].pp = 0;
    const tracker = mkTrackerWithLines(TRICK_FOES);
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });
});

describe('硬指令 H3：强化后催眠', () => {
  it('命中强化在身且有未睡眠目标时强制催眠最快者', () => {
    const dex = mkDirectiveDex();
    const request = mkHypnosisRequest();
    const tracker = mkTrackerWithLines(HYPNOSIS_FOES);
    const plans = buildTurnPlans({dex, request, tracker});
    const directives = collectTurnDirectives({dex, request, tracker, plans});
    const hypnosis = directives.find(d => d.slot === 1);
    expect(hypnosis?.key).toBe('move_1_foe_b');
    expect(hypnosis?.note).toContain('hard:hypnosis');
    expect(hypnosis?.note).toContain('Sneasler');
  });

  it('没有命中强化时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkHypnosisRequest();
    const tracker = mkTrackerWithLines(HYPNOSIS_FOES.filter(line => !line.includes('accuracy')));
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('对手全部睡眠时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkHypnosisRequest();
    const tracker = mkTrackerWithLines([...HYPNOSIS_FOES, '|-status|p2a: Kingambit|slp', '|-status|p2b: Sneasler|slp']);
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('跳过已睡眠目标，打最快的未睡眠者', () => {
    const dex = mkDirectiveDex();
    const request = mkHypnosisRequest();
    const tracker = mkTrackerWithLines([...HYPNOSIS_FOES, '|-status|p2b: Sneasler|slp']);
    const plans = buildTurnPlans({dex, request, tracker});
    const hypnosis = collectTurnDirectives({dex, request, tracker, plans}).find(d => d.slot === 1);
    expect(hypnosis?.key).toBe('move_1_foe_a');
    expect(hypnosis?.note).toContain('Kingambit');
  });
});

describe('硬指令 H4：抢回场地', () => {
  it('对手场地覆盖且场地手在替补时强制换入（换下 HP 最低的槽位）', () => {
    const dex = mkDirectiveDex();
    const request = mkTerrainRequest();
    const tracker = mkTrackerWithLines(mkTerrainFoes('|-fieldstart|Grassy Terrain|[from] ability: Grassy Surge|[of] p2a: Rillaboom'));
    const plans = buildTurnPlans({dex, request, tracker});
    const directives = collectTurnDirectives({dex, request, tracker, plans});
    const terrain = directives.find(d => d.note.includes('hard:terrain'));
    expect(terrain?.slot).toBe(1);
    expect(terrain?.key).toBe('switch_3');
  });

  it('场地已是精神场地时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTerrainRequest();
    const tracker = mkTrackerWithLines(mkTerrainFoes('|-fieldstart|Psychic Terrain|[from] ability: Psychic Surge|[of] p1a: Indeedee'));
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('没有场地时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTerrainRequest();
    const tracker = mkTrackerWithLines(mkTerrainFoes('|turn|2'));
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('场地手已阵亡时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTerrainRequest();
    request.side.pokemon[2].condition = '0 fnt';
    const tracker = mkTrackerWithLines(mkTerrainFoes('|-fieldstart|Grassy Terrain|[from] ability: Grassy Surge|[of] p2a: Rillaboom'));
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });
});

describe('硬指令 H5：暴飞龙无顺风即开风', () => {
  it('暴飞龙在场、我方无顺风且 Tailwind 可用时强制开出顺风', () => {
    const dex = mkDirectiveDex();
    const request = mkTailwindRequest();
    const tracker = mkTrackerWithLines(TAILWIND_FOES);
    const plans = buildTurnPlans({dex, request, tracker});
    const directives = collectTurnDirectives({dex, request, tracker, plans});
    const tailwind = directives.find(d => d.slot === 1);
    expect(tailwind?.key).toBe('move_3');
    expect(tailwind?.note).toContain('hard:tailwind');
    expect(tailwind?.note).toContain('Salamence');
  });

  it('我方已有顺风时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTailwindRequest();
    const tracker = mkTrackerWithLines([...TAILWIND_FOES, '|-sidestart|p1: JevBot1234|move: Tailwind']);
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('Tailwind PP 耗尽时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTailwindRequest();
    request.active![0].moves[2].pp = 0;
    const tracker = mkTrackerWithLines(TAILWIND_FOES);
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });

  it('暴飞龙不在场时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkTailwindRequest();
    request.side.pokemon[0].details = 'Golisopod, L50, M';
    request.active![0].moves = [{move: 'Iron Head', id: 'ironhead', pp: 15, maxpp: 15, target: 'normal'}];
    const tracker = mkTrackerWithLines(TAILWIND_FOES);
    const plans = buildTurnPlans({dex, request, tracker});
    expect(collectTurnDirectives({dex, request, tracker, plans})).toEqual([]);
  });
});

describe('硬指令 H6：对手天气时把班基拉斯补入前四位', () => {
  it('对手预览有天气手时用第 4 位换入班基拉斯', () => {
    const dex = mkDirectiveDex();
    const request = mkPreviewRequest(PREVIEW_TEAM);
    const result = applyPreviewDirectives({dex, request, order: [1, 2, 3, 4], opponentPreviewSpecies: ['Torkoal']});
    expect(result.order).toEqual([1, 2, 3, 5]);
    expect(result.notes.some(n => n.startsWith('hard:weather-bring'))).toBe(true);
  });

  it('对手天气手经 Mega 形态命中时同样触发', () => {
    const dex = mkDirectiveDex();
    dex.species.charizardmegay = {
      name: 'Charizard-Mega-Y', types: ['Fire', 'Flying'],
      baseStats: {hp: 78, atk: 104, def: 78, spa: 159, spd: 115, spe: 100},
      abilities: {0: 'Drought'}, baseSpecies: 'Charizard', requiredItem: 'Charizardite Y',
    };
    const request = mkPreviewRequest(PREVIEW_TEAM);
    const result = applyPreviewDirectives({dex, request, order: [1, 2, 3, 4], opponentPreviewSpecies: ['Charizard']});
    expect(result.order).toEqual([1, 2, 3, 5]);
    expect(result.notes.some(n => n.startsWith('hard:weather-bring'))).toBe(true);
  });

  it('对手无天气手时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkPreviewRequest(PREVIEW_TEAM);
    const result = applyPreviewDirectives({dex, request, order: [1, 2, 3, 4], opponentPreviewSpecies: ['Metagross', 'Kingambit']});
    expect(result.order).toEqual([1, 2, 3, 4]);
    expect(result.notes).toEqual([]);
  });

  it('班基拉斯已在前四位时不调整', () => {
    const dex = mkDirectiveDex();
    const request = mkPreviewRequest(PREVIEW_TEAM);
    const result = applyPreviewDirectives({dex, request, order: [1, 5, 3, 4], opponentPreviewSpecies: ['Torkoal']});
    expect(result.order).toEqual([1, 5, 3, 4]);
  });

  it('我方没有班基拉斯时不触发', () => {
    const dex = mkDirectiveDex();
    const request = mkPreviewRequest(['Indeedee', 'Milotic', 'Salamence', 'Golisopod', 'Chandelure', 'Excadrill']);
    const result = applyPreviewDirectives({dex, request, order: [1, 2, 3, 4], opponentPreviewSpecies: ['Torkoal']});
    expect(result.order).toEqual([1, 2, 3, 4]);
  });
});
