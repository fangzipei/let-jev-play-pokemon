import type {DexData} from '../src/dex/index.js';
import {normalizeTypechart} from '../src/state/calc.js';
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
          {move: 'Heat Wave', id: 'heatwave', pp: 10, maxpp: 10, target: 'allAdjacentFoes'},
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

/** 测试用小型 dex（覆盖本队伍与常见对手） */
export function mkDex(): DexData {
  const species: Record<string, any> = {
    golisopod: {name: 'Golisopod', types: ['Bug', 'Steel'], baseStats: {hp: 75, atk: 125, def: 140, spa: 60, spd: 90, spe: 40}, abilities: {0: 'Emergency Exit'}},
    golisopodmega: {name: 'Golisopod-Mega', types: ['Bug', 'Steel'], baseStats: {hp: 75, atk: 150, def: 175, spa: 70, spd: 120, spe: 40}, abilities: {0: 'Tough Claws'}, baseSpecies: 'Golisopod', requiredItem: 'Golisopite'},
    chandelure: {name: 'Chandelure', types: ['Ghost', 'Fire'], baseStats: {hp: 60, atk: 55, def: 90, spa: 145, spd: 90, spe: 80}, abilities: {0: 'Flash Fire'}},
    tyranitar: {name: 'Tyranitar', types: ['Rock', 'Dark'], baseStats: {hp: 100, atk: 134, def: 110, spa: 95, spd: 100, spe: 61}, abilities: {0: 'Sand Stream'}},
    excadrill: {name: 'Excadrill', types: ['Ground', 'Steel'], baseStats: {hp: 110, atk: 135, def: 60, spa: 50, spd: 65, spe: 88}, abilities: {0: 'Sand Rush'}},
    salamence: {name: 'Salamence', types: ['Dragon', 'Flying'], baseStats: {hp: 95, atk: 135, def: 80, spa: 110, spd: 80, spe: 100}, abilities: {0: 'Intimidate'}},
    salamencemega: {name: 'Salamence-Mega', types: ['Dragon', 'Flying'], baseStats: {hp: 95, atk: 145, def: 130, spa: 120, spd: 90, spe: 120}, abilities: {0: 'Aerilate'}, baseSpecies: 'Salamence', requiredItem: 'Salamencite'},
    rotomwash: {name: 'Rotom-Wash', types: ['Electric', 'Water'], baseStats: {hp: 50, atk: 65, def: 107, spa: 105, spd: 107, spe: 86}, abilities: {0: 'Levitate'}},
    gyarados: {name: 'Gyarados', types: ['Water', 'Flying'], baseStats: {hp: 95, atk: 125, def: 79, spa: 60, spd: 100, spe: 81}, abilities: {0: 'Intimidate'}},
    victreebel: {name: 'Victreebel', types: ['Grass', 'Poison'], baseStats: {hp: 80, atk: 105, def: 65, spa: 100, spd: 70, spe: 70}, abilities: {0: 'Chlorophyll'}},
    charizard: {name: 'Charizard', types: ['Fire', 'Flying'], baseStats: {hp: 78, atk: 84, def: 78, spa: 109, spd: 85, spe: 100}, abilities: {0: 'Blaze'}},
    kingambit: {name: 'Kingambit', types: ['Dark', 'Steel'], baseStats: {hp: 100, atk: 135, def: 120, spa: 60, spd: 85, spe: 50}, abilities: {0: 'Supreme Overlord'}},
    whimsicott: {name: 'Whimsicott', types: ['Grass', 'Fairy'], baseStats: {hp: 60, atk: 67, def: 85, spa: 77, spd: 75, spe: 116}, abilities: {0: 'Prankster'}},
    sneasler: {name: 'Sneasler', types: ['Fighting', 'Poison'], baseStats: {hp: 80, atk: 130, def: 60, spa: 40, spd: 80, spe: 120}, abilities: {0: 'Unburden'}},
    metagross: {name: 'Metagross', types: ['Steel', 'Psychic'], baseStats: {hp: 80, atk: 135, def: 130, spa: 95, spd: 90, spe: 70}, abilities: {0: 'Clear Body'}},
    corviknight: {name: 'Corviknight', types: ['Flying', 'Steel'], baseStats: {hp: 98, atk: 87, def: 105, spa: 53, spd: 85, spe: 67}, abilities: {0: 'Pressure'}},
    sableye: {name: 'Sableye', types: ['Dark', 'Ghost'], baseStats: {hp: 50, atk: 75, def: 75, spa: 65, spd: 65, spe: 50}, abilities: {0: 'Keen Eye'}},
    incineroar: {name: 'Incineroar', types: ['Fire', 'Dark'], baseStats: {hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60}, abilities: {0: 'Intimidate'}},
    amoonguss: {name: 'Amoonguss', types: ['Grass', 'Poison'], baseStats: {hp: 114, atk: 85, def: 70, spa: 85, spd: 80, spe: 30}, abilities: {0: 'Regenerator'}},
    rillaboom: {name: 'Rillaboom', types: ['Grass'], baseStats: {hp: 100, atk: 125, def: 90, spa: 60, spd: 70, spe: 85}, abilities: {0: 'Grassy Surge'}},
  };
  const mkMove = (name: string, type: string, basePower: number, category: string, target = 'normal', priority = 0) =>
    ({name, type, basePower, category, target, priority});
  const moves: Record<string, any> = {
    ironhead: mkMove('Iron Head', 'Steel', 80, 'Physical'),
    drillrun: mkMove('Drill Run', 'Ground', 80, 'Physical'),
    leechlife: mkMove('Leech Life', 'Bug', 80, 'Physical'),
    suckerpunch: mkMove('Sucker Punch', 'Dark', 70, 'Physical', 'normal', 1),
    shadowball: mkMove('Shadow Ball', 'Ghost', 80, 'Special'),
    heatwave: mkMove('Heat Wave', 'Fire', 95, 'Special', 'allAdjacentFoes'),
    trickroom: mkMove('Trick Room', 'Psychic', 0, 'Status', 'all'),
    protect: mkMove('Protect', 'Normal', 0, 'Status', 'self'),
    rockslide: mkMove('Rock Slide', 'Rock', 75, 'Physical', 'allAdjacentFoes'),
    knockoff: mkMove('Knock Off', 'Dark', 65, 'Physical'),
    icepunch: mkMove('Ice Punch', 'Ice', 75, 'Physical'),
    firepunch: mkMove('Fire Punch', 'Fire', 75, 'Physical'),
    highhorsepower: mkMove('High Horsepower', 'Ground', 95, 'Physical'),
    hypervoice: mkMove('Hyper Voice', 'Normal', 90, 'Special', 'allAdjacentFoes'),
    dracometeor: mkMove('Draco Meteor', 'Dragon', 130, 'Special'),
    flamethrower: mkMove('Flamethrower', 'Fire', 90, 'Special'),
    electroweb: mkMove('Electroweb', 'Electric', 55, 'Special', 'allAdjacentFoes'),
    thunderbolt: mkMove('Thunderbolt', 'Electric', 90, 'Special'),
    voltswitch: mkMove('Volt Switch', 'Electric', 70, 'Special'),
    hydropump: mkMove('Hydro Pump', 'Water', 110, 'Special'),
    sludgebomb: mkMove('Sludge Bomb', 'Poison', 90, 'Special'),
    bravebird: mkMove('Brave Bird', 'Flying', 120, 'Physical'),
    direclaw: mkMove('Dire Claw', 'Poison', 80, 'Physical'),
    foulplay: mkMove('Foul Play', 'Dark', 95, 'Physical'),
    irondefense: mkMove('Iron Defense', 'Steel', 0, 'Status', 'self'),
    kowtowcleave: mkMove('Kowtow Cleave', 'Dark', 85, 'Physical'),
    encore: mkMove('Encore', 'Normal', 0, 'Status'),
    tailwind: mkMove('Tailwind', 'Flying', 0, 'Status', 'allySide'),
    fakeout: mkMove('Fake Out', 'Normal', 40, 'Physical', 'normal', 3),
    quickguard: mkMove('Quick Guard', 'Fighting', 0, 'Status', 'allySide', 3),
    followme: mkMove('Follow Me', 'Normal', 0, 'Status', 'self', 2),
    ragepowder: mkMove('Rage Powder', 'Bug', 0, 'Status', 'self', 2),
    wideguard: mkMove('Wide Guard', 'Rock', 0, 'Status', 'allySide', 3),
    helpinghand: mkMove('Helping Hand', 'Normal', 0, 'Status', 'adjacentAlly', 5),
    coaching: mkMove('Coaching', 'Fighting', 0, 'Status', 'adjacentAlly'),
    partingshot: mkMove('Parting Shot', 'Dark', 0, 'Status', 'normal'),
    uturn: mkMove('U-turn', 'Bug', 70, 'Physical'),
    flipturn: mkMove('Flip Turn', 'Water', 60, 'Physical'),
    perishsong: mkMove('Perish Song', 'Normal', 0, 'Status', 'all'),
    yawn: mkMove('Yawn', 'Normal', 0, 'Status', 'normal'),
    auroraveil: mkMove('Aurora Veil', 'Ice', 0, 'Status', 'allySide'),
    weatherball: mkMove('Weather Ball', 'Normal', 50, 'Special'),
    flareblitz: mkMove('Flare Blitz', 'Fire', 120, 'Physical'),
    moonblast: mkMove('Moonblast', 'Fairy', 95, 'Special'),
    lastrespects: mkMove('Last Respects', 'Ghost', 50, 'Physical'),
  };
  const chart = normalizeTypechart({
    normal: {ghost: 0, rock: 0.5, steel: 0.5},
    fire: {grass: 2, ice: 2, bug: 2, steel: 2, water: 0.5, fire: 0.5, dragon: 0.5, rock: 0.5},
    water: {fire: 2, ground: 2, rock: 2, water: 0.5, grass: 0.5, dragon: 0.5},
    electric: {water: 2, flying: 2, ground: 0, electric: 0.5, grass: 0.5, dragon: 0.5},
    grass: {water: 2, ground: 2, rock: 2, fire: 0.5, grass: 0.5, flying: 0.5, bug: 0.5, dragon: 0.5, steel: 0.5, poison: 0.5},
    ice: {grass: 2, ground: 2, flying: 2, dragon: 2, fire: 0.5, water: 0.5, ice: 0.5, steel: 0.5},
    fighting: {normal: 2, rock: 2, steel: 2, ice: 2, dark: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, fairy: 0.5, ghost: 0},
    poison: {grass: 2, fairy: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0},
    ground: {fire: 2, electric: 2, poison: 2, rock: 2, steel: 2, grass: 0.5, bug: 0.5, flying: 0},
    flying: {grass: 2, fighting: 2, bug: 2, electric: 0.5, rock: 0.5, steel: 0.5},
    psychic: {fighting: 2, poison: 2, psychic: 0.5, steel: 0.5, dark: 0},
    bug: {grass: 2, psychic: 2, dark: 2, fire: 0.5, fighting: 0.5, flying: 0.5, ghost: 0.5, steel: 0.5, poison: 0.5, fairy: 0.5},
    rock: {fire: 2, ice: 2, flying: 2, bug: 2, fighting: 0.5, ground: 0.5, steel: 0.5},
    ghost: {psychic: 2, ghost: 2, dark: 0.5, normal: 0},
    dragon: {dragon: 2, steel: 0.5, fairy: 0},
    dark: {psychic: 2, ghost: 2, fighting: 0.5, dark: 0.5, fairy: 0.5},
    steel: {ice: 2, rock: 2, fairy: 2, fire: 0.5, water: 0.5, electric: 0.5, steel: 0.5},
    fairy: {dragon: 2, dark: 2, fighting: 2, fire: 0.5, poison: 0.5, steel: 0.5},
  });
  return {species, moves, typechart: chart, source: 'empty'};
}
