import {hpPercent, parseCondition, parseDetails, parseIdent, parseLine, toId} from './protocol.js';

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
  /** 整局显式揭示的道具/特性与已终止道具，不随当前值变化或日志裁剪清空。 */
  revealedItems?: string[];
  revealedAbilities?: string[];
  endedItems?: string[];
  /** 本次上场时的回合号（|start| 前的首发为 0）；用于判定"首个行动回合"（Fake Out 窗口、讲究锁招） */
  switchInTurn?: number;
  /** 最近一次使用招式的原始名（|move| 事件，如 'Protect'）与回合号；用于连续保护等"上一动作"判定 */
  lastMoveId?: string;
  lastMoveTurn?: number;
}

export interface SideState {
  id: string;
  name?: string;
  teamSize: number;
  /** 服务端真实 teamsize 值；不含默认值，也不保证等于实际带入人数。 */
  reportedTeamSize?: number;
  pokemon: PokemonState[];
  sideConditions: string[];
  /** sideConditions 各项的激活回合（key = toId 归一化名），用于计算控速剩余回合 */
  sideConditionTurns: Record<string, number>;
  megaUsed: boolean;
}

export interface BattleState {
  id: string;
  turn: number;
  weather?: string;
  /** 当前天气的激活回合（|weather|[upkeep] 不重置） */
  weatherStartTurn?: number;
  /** 天气时长是否被对应岩石道具延长为 8 回合；undefined = 设置者道具未知 */
  weatherRock?: boolean;
  fieldConditions: string[];
  /** fieldConditions 各项的激活回合（key = toId 归一化名） */
  fieldConditionTurns: Record<string, number>;
  sides: Record<string, SideState>;
  ourSideId: string | null;
  winner?: string;
  ended: boolean;
  log: string[];
  /** 日志曾发生头部裁剪；长期事实仍由 tracker 保留。 */
  logTruncated?: boolean;
}

function newSide(id: string): SideState {
  return {id, teamSize: 6, pokemon: [], sideConditions: [], sideConditionTurns: {}, megaUsed: false};
}

function newPokemon(sideId: string, name: string, species: string): PokemonState {
  return {
    ident: `${sideId}: ${name}`, side: sideId, name, species,
    hp: 100, maxhp: 100, hpPercent: 100, status: null, fainted: false,
    activePos: -1, boosts: {}, mega: false, volatiles: [], singleTurn: [], revealedMoves: [],
  };
}

/** 岩石道具 → 可延长的天气（PS conditions.ts durationCallback 的 hasItem 检查） */
const WEATHER_ROCK_EXTENDS: Record<string, string[]> = {
  damprock: ['raindance'], heatrock: ['sunnyday'], smoothrock: ['sandstorm'], icyrock: ['snowscape', 'hail', 'snow'],
};

/** 条件名归一化：剥掉 'move: ' 前缀再 toId（与 analysis.hasCondition 同规则），如 'move: Tailwind' → 'tailwind' */
function conditionKey(name: string): string {
  return toId(name.replace(/^move:\s*/i, ''));
}

/** 把 |switch| 里的形态 id 归一化（如 rotomwash -> Rotom-Wash）不做处理，直接用协议原名 */
export class BattleTracker {
  readonly state: BattleState;

  constructor(battleId: string, private ourName: string) {
    this.state = {
      id: battleId, turn: 0, fieldConditions: [], fieldConditionTurns: {},
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

  /** 从 -weather 的 [of] setter 解析岩石延长：true/false 为道具已确认，undefined 为未知 */
  private weatherRockOf(args: string[], weather: string): boolean | undefined {
    const of = args.find(a => a.startsWith('[of]'));
    const ident = of ? parseIdent(of.replace(/^\[of\]\s*/, '')) : null;
    const p = ident ? this.findPokemon(ident.side, ident.name) : undefined;
    const item = toId(p?.item ?? '');
    if (!item) return undefined;
    return WEATHER_ROCK_EXTENDS[item]?.includes(toId(weather)) ?? false;
  }

  handleLine(raw: string): void {
    this.state.log.push(raw);
    if (this.state.log.length > 5000) {
      this.state.log.splice(0, 1000);
      this.state.logTruncated = true;
    }
    const line = parseLine(raw);
    if (!line) return;
    const s = this.state;
    const [a0, a1, a2] = line.args;

    // 只记录协议明示的结算/天气来源，不借助前后动作猜测归属，也不改写当前道具或特性。
    if (['-damage', '-heal', '-weather'].includes(line.type)) {
      const effect = line.args.find(a => a.startsWith('[from] '))?.match(/^\[from\] (item|ability): (.+)$/);
      const owner = line.args.find(a => a.startsWith('[of] '));
      const ident = parseIdent(owner ? owner.slice(5) : a0);
      const p = ident && this.findPokemon(ident.side, ident.name);
      if (p && effect) {
        const key = effect[1] === 'item' ? 'revealedItems' : 'revealedAbilities';
        const revealed = (p[key] ??= []);
        if (!revealed.includes(effect[2])) revealed.push(effect[2]);
      }
    }

    switch (line.type) {
      case 'player': {
        const side = this.side(a0);
        side.name = a1;
        const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (norm(a1) === norm(this.ourName)) s.ourSideId = a0;
        break;
      }
      case 'teamsize': {
        const reported = Number(a1);
        if (Number.isSafeInteger(reported) && reported > 0) this.side(a0).reportedTeamSize = reported;
        this.side(a0).teamSize = Number(a1) || 6;
        break;
      }
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
        p.switchInTurn = s.turn;
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
          if (a2 && !(p.revealedItems ??= []).includes(a2)) p.revealedItems.push(a2);
          this.side(ident.side).megaUsed = true;
        }
        break;
      }
      case 'move': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (!p) break;
        if (a1 && !p.revealedMoves.includes(a1)) p.revealedMoves.push(a1);
        p.lastMoveId = a1;
        p.lastMoveTurn = this.state.turn;
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
      case '-weather': {
        if (a1 === '[upkeep]') break; // 心跳行不改变天气状态也不重置起始回合
        const weather = a0 && a0 !== 'none' ? a0 : undefined;
        s.weather = weather;
        // 天气特性在 |turn|1 之前设置（s.turn=0），按第 1 回合起算；回合中设置则为当前回合
        s.weatherStartTurn = weather ? (s.turn || 1) : undefined;
        s.weatherRock = weather ? this.weatherRockOf(line.args, weather) : undefined;
        break;
      }
      case '-fieldstart':
        if (a0) {
          if (!s.fieldConditions.includes(a0)) s.fieldConditions.push(a0);
          s.fieldConditionTurns[conditionKey(a0)] = s.turn;
        }
        break;
      case '-fieldend':
        s.fieldConditions = s.fieldConditions.filter(f => f !== a0);
        if (a0) delete s.fieldConditionTurns[conditionKey(a0)];
        break;
      case '-sidestart': {
        const side = this.side(a0.split(':')[0].trim());
        if (a1 && !side.sideConditions.includes(a1)) side.sideConditions.push(a1);
        if (a1) side.sideConditionTurns[conditionKey(a1)] = s.turn;
        break;
      }
      case '-sideend': {
        const side = this.side(a0.split(':')[0].trim());
        side.sideConditions = side.sideConditions.filter(c => c !== a1);
        if (a1) delete side.sideConditionTurns[conditionKey(a1)];
        break;
      }
      case '-swapsideconditions': {
        const tmp = s.sides.p1.sideConditions;
        s.sides.p1.sideConditions = s.sides.p2.sideConditions;
        s.sides.p2.sideConditions = tmp;
        const tmpTurns = s.sides.p1.sideConditionTurns;
        s.sides.p1.sideConditionTurns = s.sides.p2.sideConditionTurns;
        s.sides.p2.sideConditionTurns = tmpTurns;
        break;
      }
      case '-item': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1) {
          if (!(p.revealedItems ??= []).includes(a1)) p.revealedItems.push(a1);
          p.item = a1;
          p.consumedItem = false;
        }
        break;
      }
      case '-enditem': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p) {
          if (a1) {
            if (!(p.revealedItems ??= []).includes(a1)) p.revealedItems.push(a1);
            if (!(p.endedItems ??= []).includes(a1)) p.endedItems.push(a1);
          }
          p.item = undefined;
          p.consumedItem = true;
        }
        break;
      }
      case '-ability': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1 && !['none', 'hidden'].includes(a1)) {
          if (!(p.revealedAbilities ??= []).includes(a1)) p.revealedAbilities.push(a1);
          p.ability = a1;
        }
        break;
      }
      case '-start': {
        const ident = parseIdent(a0);
        const p = ident && this.findPokemon(ident.side, ident.name);
        if (p && a1) {
          const v = a1.replace(/^(move|item|ability): /, '');
          if (!p.volatiles.includes(v)) p.volatiles.push(v);
        }
        break;
      }
      // -activate 是瞬发事件的回放（Protect 挡招、道具/特性触发），不代表持续状态：
      // 持久状态由 -start 记录、-end 移除；单回合效果由 -singleturn 记录、回合切换清空。
      case '-activate':
        break;
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
