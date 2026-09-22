import type {BattleRequest} from '../src/state/request.js';
import {BattleTracker} from '../src/state/tracker.js';

/** 一份贴近真实的对战 request：我方 4 只带入，2 只场上 */
export function mkRequest(partial: Partial<BattleRequest> = {}): BattleRequest {
  const base: BattleRequest = {
    active: [
      {
        moves: [
          {move: 'Iron Head', id: 'ironhead', pp: 15, maxpp: 15, target: 'normal'},
          {move: 'Drill Run', id: 'drillrun', pp: 10, maxpp: 10, target: 'normal'},
          {move: 'Leech Life', id: 'leechlife', pp: 10, maxpp: 10, target: 'normal'},
          {move: 'Sucker Punch', id: 'suckerpunch', pp: 5, maxpp: 5, target: 'normal'},
        ],
        canMegaEvo: true,
      },
      {
        moves: [
          {move: 'Shadow Ball', id: 'shadowball', pp: 15, maxpp: 15, target: 'normal'},
          {move: 'Heat Wave', id: 'heatwave', pp: 10, maxpp: 10, target: 'allAdjacentFoe'},
          {move: 'Trick Room', id: 'trickroom', pp: 5, maxpp: 5, target: 'all'},
          {move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self'},
        ],
      },
    ],
    side: {
      name: 'JevBot1234',
      id: 'p1',
      pokemon: [
        {
          ident: 'p1: Golisopod', details: 'Golisopod, L50, M', condition: '150/150', active: true,
          stats: {atk: 180, def: 160, spa: 70, spd: 110, spe: 60},
          moves: ['ironhead', 'drillrun', 'leechlife', 'suckerpunch'],
          item: 'golisopite', ability: 'emergencyexit',
        },
        {
          ident: 'p1: Chandelure', details: 'Chandelure, L50, F', condition: '135/135', active: true,
          stats: {atk: 60, def: 90, spa: 190, spd: 110, spe: 100},
          moves: ['shadowball', 'heatwave', 'trickroom', 'protect'],
          item: 'lifeorb', ability: 'flashfire',
        },
        {
          ident: 'p1: Tyranitar', details: 'Tyranitar, L50, M', condition: '175/175', active: false,
          stats: {atk: 185, def: 130, spa: 110, spd: 130, spe: 82},
          moves: ['rockslide', 'knockoff', 'icepunch', 'firepunch'],
          item: 'choicescarf', ability: 'sandstream',
        },
        {
          ident: 'p1: Salamence', details: 'Salamence, L50, M', condition: '170/170', active: false,
          stats: {atk: 135, def: 100, spa: 165, spd: 100, spe: 152},
          moves: ['protect', 'hypervoice', 'dracometeor', 'flamethrower'],
          item: 'salamencite', ability: 'intimidate',
        },
      ],
    },
    rqid: 7,
  };
  return {...base, ...partial};
}

/** 与 mkRequest 对应的对手 + 我方 tracker 状态 */
export function mkTracker(ourName = 'JevBot1234'): BattleTracker {
  const tracker = new BattleTracker('battle-gen9championsvgc2026regmc-1', ourName);
  for (const line of [
    '|player|p1|JevBot1234|1|1500',
    '|player|p2|opponent|2|1500',
    '|gametype|doubles',
    '|poke|p1|Golisopod, L50, M|',
    '|poke|p1|Chandelure, L50, F|',
    '|poke|p1|Tyranitar, L50, M|',
    '|poke|p1|Salamence, L50, M|',
    '|poke|p1|Excadrill, L50, F|',
    '|poke|p1|Rotom-Wash, L50|',
    '|poke|p2|Victreebel, L50, M|',
    '|poke|p2|Charizard, L50, M|',
    '|poke|p2|Kingambit, L50, F|',
    '|poke|p2|Whimsicott, L50, F|',
    '|poke|p2|Sneasler, L50, F|',
    '|poke|p2|Metagross, L50|',
    '|teampreview|4',
    '|teamsize|p1|4',
    '|teamsize|p2|4',
    '|start',
    '|switch|p1a: Golisopod|Golisopod, L50, M|150/150',
    '|switch|p1b: Chandelure|Chandelure, L50, F|135/135',
    '|switch|p2a: Victreebel|Victreebel, L50, M|100/100',
    '|switch|p2b: Charizard|Charizard, L50, M|92/100',
    '|turn|1',
  ]) tracker.handleLine(line);
  return tracker;
}
