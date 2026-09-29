import type {DexData} from '../dex/index.js';
import type {ChooseAction} from '../ps/choose.js';
import {findOurPokemon} from '../state/analysis.js';
import {hasEntryWeatherSetter} from '../state/calc.js';
import {toId} from '../state/protocol.js';
import {
  activeEntries, conditionPercent, isFainted, speciesOf, teamSlotOf,
  type BattleRequest, type RequestPokemon,
} from '../state/request.js';
import {fakeOutThreats, megaStoneSwapRisk, opponentActives, type OpponentActive} from '../state/serialize.js';
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

/** 慢速候选：base Speed 已知且不高于套围巾阈值；速度未知或过快的目标都会被排除。 */
function isSlowFoe(dex: DexData, foe: OpponentActive): boolean {
  const spe = dex.species[toId(foe.species)]?.baseStats?.spe;
  return spe !== undefined && spe <= SLOW_FOE_SPE_CAP;
}

/** 最慢的在场对手；exclude 命中（如 Mega 石风险目标）的对手被跳过，下标保持传入数组的原位置用于目标后缀映射。 */
function slowestFoe(dex: DexData, foes: OpponentActive[], exclude?: (foe: OpponentActive) => boolean): FoeTarget | null {
  const ranked = foes
    .map((foe, index) => ({foe, index, spe: dex.species[toId(foe.species)]?.baseStats?.spe}))
    .filter((entry): entry is {foe: OpponentActive; index: number; spe: number} =>
      entry.spe !== undefined && entry.spe <= SLOW_FOE_SPE_CAP && !exclude?.(entry.foe))
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

/** 换入型指令的槽位选择：目标换入选项存在、槽位空闲且该换入 key 未被其他指令占用时，选 HP 最低的槽位。 */
function switchSlotFor(input: {
  request: BattleRequest;
  plans: SlotQuestionPlan[];
  actives: RequestPokemon[];
  busy: Set<number>;
  /** 已使用的换入 key：同一只替补不能在一回合被两条指令重复换入 */
  takenKeys: Set<string>;
  setter: RequestPokemon;
}): {slot: 1 | 2; key: string} | null {
  const key = `switch_${teamSlotOf(input.request, input.setter)}`;
  if (input.takenKeys.has(key)) return null;
  const candidates = input.plans
    .filter(plan => plan.questionName.startsWith('action_slot_') && !input.busy.has(plan.slot))
    .map(plan => {
      const option = plan.options.find(entry => entry.key === key && entry.action.kind === 'switch');
      const me = input.actives[plan.slot - 1];
      return option && me ? {plan, hp: conditionPercent(me.condition)} : null;
    })
    .filter((entry): entry is {plan: SlotQuestionPlan; hp: number} => entry !== null)
    .sort((a, b) => a.hp - b.hp || a.plan.slot - b.plan.slot);
  const pick = candidates[0];
  return pick ? {slot: pick.plan.slot, key} : null;
}

/** 场地被对手覆盖时，把替补中存活的场地手换回来抢回场地（选 HP 最低且未被其他指令占用的槽位）。 */
function terrainDirective(input: {
  dex: DexData;
  request: BattleRequest;
  state: BattleState;
  plans: SlotQuestionPlan[];
  actives: RequestPokemon[];
  busy: Set<number>;
  takenKeys: Set<string>;
}): TurnDirective | null {
  const {dex, request, state, plans, actives, busy, takenKeys} = input;
  const contested = state.fieldConditions.find(field => CONTESTED_TERRAINS.has(toId(field.replace(/^move:\s*/i, ''))));
  if (!contested) return null;
  const setter = request.side.pokemon.find(pokemon =>
    !pokemon.active && !isFainted(pokemon.condition) && isSurgeSetter(dex, speciesOf(pokemon)));
  if (!setter) return null;
  const picked = switchSlotFor({request, plans, actives, busy, takenKeys, setter});
  if (!picked) return null;
  return {
    slot: picked.slot,
    key: picked.key,
    note: `hard:terrain: ${speciesOf(setter)} re-enters to contest ${contested}`,
  };
}

/** H8 Fake Out 防御：对手场上有刚上场的已知 Fake Out 手时，把替补的精神场地手换入——换人先于招式结算，精神场地让 Fake Out 打不到地面目标。 */
function fakeOutGuardDirective(input: {
  request: BattleRequest;
  state: BattleState;
  plans: SlotQuestionPlan[];
  actives: RequestPokemon[];
  busy: Set<number>;
  takenKeys: Set<string>;
}): TurnDirective | null {
  const {request, state, plans, actives, busy, takenKeys} = input;
  const threats = fakeOutThreats(state);
  if (!threats.length) return null;
  const setter = request.side.pokemon.find(pokemon =>
    !pokemon.active && !isFainted(pokemon.condition)
    && toId(pokemon.ability ?? pokemon.baseAbility ?? '') === 'psychicsurge');
  if (!setter) return null;
  const picked = switchSlotFor({request, plans, actives, busy, takenKeys, setter});
  if (!picked) return null;
  return {
    slot: picked.slot,
    key: picked.key,
    note: `hard:fakeout: ${speciesOf(setter)} re-enters to set Psychic Terrain and block Fake Out from ${threats.join(', ')}`,
  };
}

/** H9 雨天覆盖：场上天气为雨时，把替补的班基拉斯换入——Sand Stream 进场沙暴立即覆盖雨天，终结对手的雨天收益。 */
function rainCoverDirective(input: {
  dex: DexData;
  request: BattleRequest;
  state: BattleState;
  plans: SlotQuestionPlan[];
  actives: RequestPokemon[];
  busy: Set<number>;
  takenKeys: Set<string>;
}): TurnDirective | null {
  const {dex, request, state, plans, actives, busy, takenKeys} = input;
  const weatherId = toId(state.weather ?? '');
  if (weatherId !== 'raindance' && weatherId !== 'rain') return null;
  const setter = request.side.pokemon.find(pokemon =>
    !pokemon.active && !isFainted(pokemon.condition)
    && toId(dex.species[toId(speciesOf(pokemon))]?.baseSpecies ?? speciesOf(pokemon)).replace(/mega[xy]?$/, '') === 'tyranitar');
  if (!setter) return null;
  const picked = switchSlotFor({request, plans, actives, busy, takenKeys, setter});
  if (!picked) return null;
  return {
    slot: picked.slot,
    key: picked.key,
    note: `hard:rain-cover: ${speciesOf(setter)} re-enters with Sand Stream to overwrite the foes' rain`,
  };
}

/**
 * 收集本回合的硬指令（按优先级 H5 → H2 → H3 → H4 → H8 → H9，每个槽位最多一条）。
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
    // H2：持讲究围巾 + Trick 可用 + 对手有慢速目标 → 把围巾套给最慢者（锁招收益最大）。
    // Mega 石无法被 Trick 交换（#43 T4 实证）：已 Mega 或可能持石的慢速目标必须跳过，否则整回合空过。
    if (toId(me.item ?? '') === 'choicescarf') {
      const megaRisk = (foe: OpponentActive) => megaStoneSwapRisk(dex, foe) !== null;
      const target = slowestFoe(dex, foes, megaRisk);
      const key = target ? optionKeyFor('trick', target.index) : null;
      if (target && key) {
        const skipped = foes.filter(foe => megaRisk(foe) && isSlowFoe(dex, foe)).map(foe => foe.species);
        const skipNote = skipped.length ? ` (skipped for Mega-stone risk: ${skipped.join(', ')})` : '';
        directives.push({
          slot: plan.slot,
          key,
          note: `hard:trick: ${speciesOf(me)} swaps a Choice Scarf onto ${target.foe.species}${skipNote}`,
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
  const takenKeys = new Set<string>();
  const terrain = terrainDirective({dex, request, state, plans, actives, busy, takenKeys});
  if (terrain) {
    directives.push(terrain);
    busy.add(terrain.slot);
    takenKeys.add(terrain.key);
  }
  // H8：对手已知 Fake Out 手刚上场 → 换入爱管侍开精神场地挡招（不占已用槽位，也不重复换同一只）
  const fakeout = fakeOutGuardDirective({request, state, plans, actives, busy, takenKeys});
  if (fakeout) {
    directives.push(fakeout);
    busy.add(fakeout.slot);
    takenKeys.add(fakeout.key);
  }
  // H9：对手雨天生效 → 换入班基拉斯用沙暴覆盖（不占已用槽位，也不重复换同一只）
  const rain = rainCoverDirective({dex, request, state, plans, actives, busy, takenKeys});
  if (rain) {
    directives.push(rain);
    busy.add(rain.slot);
    takenKeys.add(rain.key);
  }
  return directives;
}

// ---------- 最终动作校正（H7） ----------

/**
 * H7 强制 Mega：我方班基拉斯在场时，只要它的动作存在 Mega 变体（持石、非状态招），就强制声明 Mega。
 * - 模型选了普通招式 → 从既有选项升级为对应 _mega 变体（不构造新动作，始终合法）；
 * - 班基拉斯声明 Mega 后，其他槽位的 Mega 声明让位（本局唯一 Mega 归班基拉斯）；
 * - 班基拉斯不在场、未选中招式或没有 Mega 变体（没带石 / Protect 等状态招）时不动任何槽位，避免误伤。
 * 在 degradeMegaConflicts 之后对最终动作调用：同时覆盖“模型放弃 Mega”与“双 Mega 让位降级”两条路径。
 */
export function enforceTyranitarMega(input: {
  dex: DexData;
  request: BattleRequest;
  plans: SlotQuestionPlan[];
  actions: ChooseAction[];
}): {actions: ChooseAction[]; notes: string[]} {
  const {dex, request, plans, actions} = input;
  const notes: string[] = [];
  if (!request.active) return {actions, notes};
  const actives = activeEntries(request);
  const ttIndex = actives.findIndex(me =>
    toId(dex.species[toId(speciesOf(me))]?.baseSpecies ?? speciesOf(me)).replace(/mega[xy]?$/, '') === 'tyranitar');
  if (ttIndex < 0) return {actions, notes};
  const slot = (ttIndex + 1) as 1 | 2;
  const ttAction = actions.find(action => action.kind === 'move' && action.slot === slot);
  if (ttAction?.kind !== 'move') return {actions, notes};
  // 未声明 Mega 时，只从该槽位的既有选项里找同动作（招式下标与目标一致）的 _mega 变体；找不到就不干预
  let upgrade = false;
  if (ttAction.mega !== true) {
    const options = plans.find(plan => plan.slot === slot)?.options ?? [];
    const base = options.find(option => option.action.kind === 'move'
      && option.action.slot === slot
      && option.action.moveIndex === ttAction.moveIndex
      && option.action.target === ttAction.target
      && !option.key.endsWith('_mega'));
    if (!base || !options.some(option => option.key === `${base.key}_mega`)) return {actions, notes};
    upgrade = true;
  }
  // 本局唯一 Mega 归班基拉斯：其他槽位已声明的 Mega 让位
  const downgraded: number[] = [];
  const result = actions.map(action => {
    if (action.kind !== 'move') return action;
    if (action.slot === slot) return upgrade ? {...action, mega: true} : action;
    if (!action.mega) return action;
    downgraded.push(action.slot);
    return {...action, mega: undefined};
  });
  if (upgrade) notes.push(`hard:mega: Tyranitar must Mega Evolve - this slot's action was upgraded to its Mega variant`);
  if (downgraded.length) notes.push(`hard:mega: slot ${downgraded.join(', ')} Mega declaration downgraded - Tyranitar takes the team's only Mega Evolve`);
  return {actions: result, notes};
}
