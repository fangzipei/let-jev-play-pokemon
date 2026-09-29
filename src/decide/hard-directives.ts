import type {DexData} from '../dex/index.js';
import {findOurPokemon} from '../state/analysis.js';
import {hasEntryWeatherSetter} from '../state/calc.js';
import {toId} from '../state/protocol.js';
import {
  activeEntries, conditionPercent, isFainted, speciesOf, teamSlotOf,
  type BattleRequest, type RequestPokemon,
} from '../state/request.js';
import {opponentActives, type OpponentActive} from '../state/serialize.js';
import {speedControlOf} from '../state/speed-control.js';
import type {BattleState, BattleTracker} from '../state/tracker.js';
import type {SlotQuestionPlan} from './turn.js';

/**
 * 用户显式战术指令层（硬指令）：比提示词更强的结构级约束，在本地校正层强制覆盖模型答案。
 * - 所有指令只从既有合法选项（plans.options）中挑选动作，不构造新动作，始终可被服务器接受；
 * - 每次触发都产出审计行（hard: 前缀），随 decisions.adjusted 写入决策日志；
 * - 跨局状态（H1 首发轮换）在 runMatch 入口通过 resetHardDirectives 重置。
 */

/** 慢速对手的 base Speed 上限：高于它的目标不建议套讲究围巾（提速副作用超过锁招收益）。 */
const SLOW_FOE_SPE_CAP = 70;

/** 需要被抢回的场地（归一化后）；精神场地是我方目标本身，不算被覆盖。 */
const CONTESTED_TERRAINS = new Set(['electricterrain', 'grassyterrain', 'mistyterrain']);

// ---------- 跨局状态（H1） ----------

let lastLeadHadSurgeSetter = false;

/** 清空跨局硬指令状态；由 runMatch 入口与测试调用。 */
export function resetHardDirectives(): void {
  lastLeadHadSurgeSetter = false;
}

/** dex 中该物种任一特性以 Surge 结尾（Psychic/Electric/Grassy/Misty Surge）→ 场地手。 */
function isSurgeSetter(dex: DexData, species: string): boolean {
  const entry = dex.species[toId(species)];
  return Object.values(entry?.abilities ?? {}).some(ability => toId(ability).endsWith('surge'));
}

export interface PreviewDirectiveResult {
  order: number[];
  /** 审计行（写入 decisions.adjusted） */
  notes: string[];
}

/**
 * H1 首发轮换：上一局首发含场地手时，本局把它移出前两位（与第三位互换）。
 * H6 天气覆盖：对手预览带入场天气手（含 Mega 形态）时，把班基拉斯补入前四位（第 4 位）。
 * 随后记录本局最终首发构成，供下一局判断。
 */
export function applyPreviewDirectives(input: {
  dex: DexData;
  request: BattleRequest;
  order: number[];
  /** 对手预览物种（policy 从 tracker 对手侧收集）；用于判断对手能否自带天气 */
  opponentPreviewSpecies?: string[];
}): PreviewDirectiveResult {
  const {dex, request} = input;
  const order = [...input.order];
  const notes: string[] = [];
  const speciesAt = (slot: number): string | null => {
    const pokemon = request.side.pokemon[slot - 1];
    return pokemon ? speciesOf(pokemon) : null;
  };
  if (lastLeadHadSurgeSetter && order.length >= 3) {
    for (const index of [0, 1]) {
      const species = speciesAt(order[index]);
      if (species && isSurgeSetter(dex, species)) {
        const moved = order[index];
        [order[index], order[2]] = [order[2], order[index]];
        notes.push(`hard:lead-rotate: slot ${moved} (${species}) moved out of the lead pair`);
        break;
      }
    }
  }
  // H6：对手预览里有入场天气手（含 Mega 形态）时，把班基拉斯补入前四位（第 4 位）进行天气覆盖
  if (input.opponentPreviewSpecies?.some(species => hasEntryWeatherSetter(dex, species))) {
    const ttIndex = request.side.pokemon.findIndex(pokemon =>
      toId(dex.species[toId(speciesOf(pokemon))]?.baseSpecies ?? speciesOf(pokemon)).replace(/mega[xy]?$/, '') === 'tyranitar');
    const tt = ttIndex >= 0 ? ttIndex + 1 : null;
    if (tt !== null && order.length >= 4 && !order.slice(0, 4).includes(tt)) {
      const at = order.indexOf(tt);
      if (at >= 0) [order[3], order[at]] = [order[at], order[3]];
      else order[3] = tt;
      notes.push(`hard:weather-bring: ${speciesOf(request.side.pokemon[ttIndex]!)} takes the fourth slot to contest the foe's weather`);
    }
  }
  lastLeadHadSurgeSetter = order.slice(0, 2).some(slot => {
    const species = speciesAt(slot);
    return species !== null && isSurgeSetter(dex, species);
  });
  return {order, notes};
}

// ---------- 回合指令（H2-H5） ----------

export interface TurnDirective {
  slot: 1 | 2;
  /** 命中的合法选项 key（存在于对应槽位的 plan.options 中） */
  key: string;
  /** 审计行（写入 decisions.adjusted） */
  note: string;
}

interface FoeTarget {
  foe: OpponentActive;
  /** opponentsActives 中的下标：0 → '+1'/'_foe_a'，1 → '+2'/'_foe_b' */
  index: number;
}

/** 最慢的在场对手，且 base Speed 不高于套围巾的阈值；速度未知或过快的目标都会被排除。 */
function slowestFoe(dex: DexData, foes: OpponentActive[]): FoeTarget | null {
  const ranked = foes
    .map((foe, index) => ({foe, index, spe: dex.species[toId(foe.species)]?.baseStats?.spe}))
    .filter((entry): entry is {foe: OpponentActive; index: number; spe: number} =>
      entry.spe !== undefined && entry.spe <= SLOW_FOE_SPE_CAP)
    .sort((a, b) => a.spe - b.spe || a.index - b.index);
  return ranked[0] ? {foe: ranked[0].foe, index: ranked[0].index} : null;
}

/** 最快的未睡眠在场对手（睡眠提示只对无异常状态目标有效）。 */
function fastestAwakeFoe(dex: DexData, foes: OpponentActive[]): FoeTarget | null {
  const ranked = foes
    .map((foe, index) => ({foe, index, spe: dex.species[toId(foe.species)]?.baseStats?.spe}))
    .filter(entry => entry.foe.status === null)
    .sort((a, b) => (b.spe ?? -1) - (a.spe ?? -1) || a.index - b.index);
  return ranked[0] ? {foe: ranked[0].foe, index: ranked[0].index} : null;
}

/** 场地被对手覆盖时，把替补中存活的场地手换回来抢回场地（选 HP 最低且未被其他指令占用的槽位）。 */
function terrainDirective(input: {
  dex: DexData;
  request: BattleRequest;
  state: BattleState;
  plans: SlotQuestionPlan[];
  actives: RequestPokemon[];
  busy: Set<number>;
}): TurnDirective | null {
  const {dex, request, state, plans, actives, busy} = input;
  const contested = state.fieldConditions.find(field => CONTESTED_TERRAINS.has(toId(field.replace(/^move:\s*/i, ''))));
  if (!contested) return null;
  const setter = request.side.pokemon.find(pokemon =>
    !pokemon.active && !isFainted(pokemon.condition) && isSurgeSetter(dex, speciesOf(pokemon)));
  if (!setter) return null;
  const key = `switch_${teamSlotOf(request, setter)}`;
  const candidates = plans
    .filter(plan => plan.questionName.startsWith('action_slot_') && !busy.has(plan.slot))
    .map(plan => {
      const option = plan.options.find(entry => entry.key === key && entry.action.kind === 'switch');
      const me = actives[plan.slot - 1];
      return option && me ? {plan, hp: conditionPercent(me.condition)} : null;
    })
    .filter((entry): entry is {plan: SlotQuestionPlan; hp: number} => entry !== null)
    .sort((a, b) => a.hp - b.hp || a.plan.slot - b.plan.slot);
  const pick = candidates[0];
  if (!pick) return null;
  return {
    slot: pick.plan.slot,
    key,
    note: `hard:terrain: ${speciesOf(setter)} re-enters to contest ${contested}`,
  };
}

/**
 * 收集本回合的硬指令（按优先级 H5 → H2 → H3 → H4，每个槽位最多一条）。
 * force-switch 阶段（无 request.active）没有可覆盖的招式选择，直接返回空。
 */
export function collectTurnDirectives(input: {
  dex: DexData;
  request: BattleRequest;
  tracker: BattleTracker;
  plans: SlotQuestionPlan[];
}): TurnDirective[] {
  const {dex, request, tracker, plans} = input;
  if (!request.active) return [];
  const state = tracker.state;
  const ourSide = state.sides[state.ourSideId ?? request.side.id];
  const actives = activeEntries(request);
  const foes = opponentActives(dex, state).filter(foe => foe.status !== 'fnt' && foe.hpPercent > 0);
  const directives: TurnDirective[] = [];
  const busy = new Set<number>();

  for (const plan of plans) {
    if (!plan.questionName.startsWith('action_slot_')) continue;
    const index = plan.slot - 1;
    const me = actives[index];
    const reqActive = request.active[index];
    if (!me || !reqActive) continue;
    // 只从既有选项中取 key：招式不可用（disabled/PP/锁招）时服务器不会给出该选项
    const optionKeyFor = (moveId: string, foeIndex?: number): string | null => {
      const moveIndex = reqActive.moves.findIndex(move => toId(move.id) === moveId);
      if (moveIndex < 0) return null;
      const suffix = foeIndex === undefined ? '' : foeIndex === 0 ? '_foe_a' : '_foe_b';
      const key = `move_${moveIndex + 1}${suffix}`;
      return plan.options.some(option => option.key === key) ? key : null;
    };
    // H5：暴飞龙在场 + 我方无顺风 + Tailwind 可用 → 立即开风（用户指令：先把顺风开出来）
    const baseId = toId(dex.species[toId(speciesOf(me))]?.baseSpecies ?? speciesOf(me)).replace(/mega[xy]?$/, '');
    if (baseId === 'salamence' && !speedControlOf(state, state.ourSideId ?? request.side.id).our_tailwind) {
      const key = optionKeyFor('tailwind');
      if (key) {
        directives.push({
          slot: plan.slot,
          key,
          note: `hard:tailwind: ${speciesOf(me)} opens Tailwind at once`,
        });
        busy.add(plan.slot);
        continue;
      }
    }
    // H2：持讲究围巾 + Trick 可用 + 对手有慢速目标 → 把围巾套给最慢者（锁招收益最大）
    if (toId(me.item ?? '') === 'choicescarf') {
      const target = slowestFoe(dex, foes);
      const key = target ? optionKeyFor('trick', target.index) : null;
      if (target && key) {
        directives.push({
          slot: plan.slot,
          key,
          note: `hard:trick: ${speciesOf(me)} swaps a Choice Scarf onto ${target.foe.species}`,
        });
        busy.add(plan.slot);
        continue;
      }
    }
    // H3：命中强化在身（Coil 类，未下场）+ Hypnosis 可用 + 有未睡眠目标 → 催眠最快者（威胁最大）
    const tracked = findOurPokemon(ourSide, me);
    if ((tracked?.boosts?.['accuracy'] ?? 0) >= 1) {
      const target = fastestAwakeFoe(dex, foes);
      const key = target ? optionKeyFor('hypnosis', target.index) : null;
      if (target && key) {
        directives.push({
          slot: plan.slot,
          key,
          note: `hard:hypnosis: ${speciesOf(me)} puts the fastest awake foe ${target.foe.species} to sleep`,
        });
        busy.add(plan.slot);
        continue;
      }
    }
  }
  // H4：场地被覆盖 + 场地手存活在替补 → 换入抢回（不被 H2/H3 占用的槽位）
  const terrain = terrainDirective({dex, request, state, plans, actives, busy});
  if (terrain) directives.push(terrain);
  return directives;
}
