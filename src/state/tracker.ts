import {hpPercent, parseCondition, parseDetails, parseIdent, parseLine} from './protocol.js';

export interface PokemonState {
  ident: string;
  side: string;
  name: string;
  species: string;
  level?: number;
  gender?: string;
  hp: number;
  maxhp: number;
  hpPercent: number;
  status: string | null;
  fainted: boolean;
  activePos: number; // -1 = 替补
  boosts: Record<string, number>;
  ability?: string;
  item?: string;
  consumedItem?: boolean;
  mega: boolean;
  volatiles: string[];
  singleTurn: string[];
  revealedMoves: string[];
}

export interface SideState {
  id: string;
  name?: string;
  teamSize: number;
  pokemon: PokemonState[];
  sideConditions: string[];
  megaUsed: boolean;
}

export interface BattleState {
  id: string;
  turn: number;
  weather?: string;
  fieldConditions: string[];
  sides: Record<string, SideState>;
  ourSideId: string | null;
  winner?: string;
  ended: boolean;
  log: string[];
}

function newSide(id: string): SideState {
  return {id, teamSize: 6, pokemon: [], sideConditions: [], megaUsed: false};
}

function newPokemon(sideId: string, name: string, species: string): PokemonState {
  return {
    ident: `${sideId}: ${name}`, side: sideId, name, species,
    hp: 100, maxhp: 100, hpPercent: 100, status: null, fainted: false,
    activePos: -1, boosts: {}, mega: false, volatiles: [], singleTurn: [], revealedMoves: [],
  };
}

/** 把 |switch| 里的形态 id 归一化（如 rotomwash -> Rotom-Wash）不做处理，直接用协议原名 */
export class BattleTracker {
  readonly state: BattleState;

  constructor(battleId: string, private ourName: string) {
    this.state = {
      id: battleId, turn: 0, fieldConditions: [],
      sides: {p1: newSide('p1'), p2: newSide('p2')},
      ourSideId: null, ended: false, log: [],
    };
  }

  side(id: string): SideState {
    return (this.state.sides[id] ??= newSide(id));
  }

  findPokemon(sideId: string, name: string): PokemonState | undefined {
    return this.side(sideId).pokemon.find(p => p.name === name);
  }

  private ensurePokemon(sideId: string, name: string, species: string): PokemonState {
    let p = this.findPokemon(sideId, name);
    if (!p) {
      p = newPokemon(sideId, name, species);
      this.side(sideId).pokemon.push(p);
    }
    return p;
  }

  /** |switch| 时优先复用 preview 里同形态的占位条目（未起昵称） */
  private adoptPreviewEntry(sideId: string, name: string, species: string): PokemonState | undefined {
    return this.side(sideId).pokemon.find(
      q => q.species === species && q.activePos < 0 && q.name === q.species && !q.fainted,
    );
  }

  /** 同一槽位被新宝可梦接替时，把该槽位的旧条目置为替补并清掉回合内状态 */
  private clearSameSlot(sideId: string, pos: number, keep: PokemonState): void {
    for (const p of this.side(sideId).pokemon) {
      if (p !== keep && p.activePos === pos) {
        p.activePos = -1;
        p.volatiles = [];
        p.singleTurn = [];
      }
    }
  }

  handleLine(raw: string): void {
    this.state.log.push(raw);
    if (this.state.log.length > 5000) this.state.log.splice(0, 1000);
    const line = parseLine(raw);
    if (!line) return;
    const s = this.state;
    const [a0, a1, a2] = line.args;

    switch (line.type) {
      case 'player': {
        const side = this.side(a0);
        side.name = a1;
        const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (norm(a1) === norm(this.ourName)) s.ourSideId = a0;
        break;
      }
      case 'teamsize':
        this.side(a0).teamSize = Number(a1) || 6;
        break;
      case 'poke': {
        const d = parseDetails(a1);
        this.ensurePokemon(a0, d.species, d.species);
        break;
      }
      case 'switch':
      case 'drag':
      case 'replace': {
        const ident = parseIdent(a0);
        if (!ident) break;
        const det = parseDetails(a1);
        const cond = parseCondition(a2 ?? '100/100');
        let p = this.findPokemon(ident.side, ident.name);
        if (!p) {
          const adopted = this.adoptPreviewEntry(ident.side, ident.name, det.species);
          if (adopted) {
            adopted.name = ident.name;
            adopted.ident = `${ident.side}: ${ident.name}`;
            p = adopted;
          } else {
            p = this.ensurePokemon(ident.side, ident.name, det.species);
          }
        }
        const pos = ident.pos ? ident.pos.charCodeAt(0) - 97 : 0;
        this.clearSameSlot(ident.side, pos, p);
        p.species = det.species;
        p.level = det.level ?? p.level;
        p.gender = det.gender ?? p.gender;
        p.hp = cond.hp;
        p.maxhp = cond.maxhp;
        p.hpPercent = hpPercent(cond.hp, cond.maxhp);
        p.status = cond.status;
        p.fainted = cond.fainted;
        p.activePos = pos;
        p.boosts = {};
        p.volatiles = [];
        p.singleTurn = [];
        break;
      }
      case 'detailschange':
      case 'formechange': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p) p.species = parseDetails(a1).species;
        break;
      }
      case '-mega': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && ident) {
          p.mega = true;
          this.side(ident.side).megaUsed = true;
        }
        break;
      }
      case 'move': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1 && !p.revealedMoves.includes(a1)) p.revealedMoves.push(a1);
        break;
      }
      case '-damage':
      case '-heal':
      case '-sethp': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (!p) break;
        const cond = parseCondition(a1 ?? '');
        p.hp = cond.hp;
        p.maxhp = cond.maxhp;
        p.hpPercent = hpPercent(cond.hp, cond.maxhp);
        if (cond.status) p.status = cond.status;
        if (cond.fainted) {
          p.fainted = true;
          p.status = 'fnt';
        }
        break;
      }
      case 'faint': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p) {
          p.fainted = true;
          p.hp = 0;
          p.hpPercent = 0;
          p.status = 'fnt';
        }
        break;
      }
      case '-status': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p) p.status = a1;
        break;
      }
      case '-curestatus': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && p.status !== 'fnt') p.status = null;
        break;
      }
      case '-cureteam': {
        const side = this.side(a0.split(':')[0].trim());
        for (const p of side.pokemon) if (p.status && p.status !== 'fnt') p.status = null;
        break;
      }
      case '-boost':
      case '-unboost':
      case '-setboost': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (!p) break;
        const n = Number(a2 ?? 0);
        if (line.type === '-setboost') p.boosts[a1] = n;
        else p.boosts[a1] = (p.boosts[a1] ?? 0) + (line.type === '-boost' ? n : -n);
        break;
      }
      case '-clearboost': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p) p.boosts = {};
        break;
      }
      case '-clearnegativeboost': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p) for (const k of Object.keys(p.boosts)) if (p.boosts[k] < 0) p.boosts[k] = 0;
        break;
      }
      case '-invertboost': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p) for (const k of Object.keys(p.boosts)) p.boosts[k] = -p.boosts[k];
        break;
      }
      case '-clearallboost': {
        for (const side of Object.values(s.sides)) for (const p of side.pokemon) p.boosts = {};
        break;
      }
      case '-weather':
        s.weather = a0 || undefined;
        break;
      case '-fieldstart':
        if (a0 && !s.fieldConditions.includes(a0)) s.fieldConditions.push(a0);
        break;
      case '-fieldend':
        s.fieldConditions = s.fieldConditions.filter(f => f !== a0);
        break;
      case '-sidestart': {
        const sc = this.side(a0.split(':')[0].trim()).sideConditions;
        if (a1 && !sc.includes(a1)) sc.push(a1);
        break;
      }
      case '-sideend': {
        const side = this.side(a0.split(':')[0].trim());
        side.sideConditions = side.sideConditions.filter(c => c !== a1);
        break;
      }
      case '-swapsideconditions': {
        const tmp = s.sides.p1.sideConditions;
        s.sides.p1.sideConditions = s.sides.p2.sideConditions;
        s.sides.p2.sideConditions = tmp;
        break;
      }
      case '-item': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1) {
          p.item = a1;
          p.consumedItem = false;
        }
        break;
      }
      case '-enditem': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p) {
          p.item = undefined;
          p.consumedItem = true;
        }
        break;
      }
      case '-ability': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1 && !['none', 'hidden'].includes(a1)) p.ability = a1;
        break;
      }
      case '-activate':
      case '-start': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1) {
          const v = a1.replace(/^(move|item|ability): /, '');
          if (!p.volatiles.includes(v)) p.volatiles.push(v);
        }
        break;
      }
      case '-end': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1) {
          const v = a1.replace(/^(move|item|ability): /, '');
          p.volatiles = p.volatiles.filter(x => x !== v);
        }
        break;
      }
      case '-singleturn': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1) p.singleTurn.push(a1.replace(/^move: /, ''));
        break;
      }
      case 'turn': {
        s.turn = Number(a0) || s.turn + 1;
        for (const side of Object.values(s.sides)) for (const p of side.pokemon) p.singleTurn = [];
        break;
      }
      case '-terastallize': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1) p.volatiles.push(`terastallized:${a1}`);
        break;
      }
      case 'win':
        s.winner = a0;
        s.ended = true;
        break;
      case 'tie':
        s.ended = true;
        break;
      default:
        break;
    }
  }

  recentLines(n = 10): string[] {
    return this.state.log.slice(-n);
  }
}
