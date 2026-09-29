import {megaFormsOf, speciesTypes, type DexData} from '../dex/index.js';
import type {ChoiceQuestion} from '../jev/types.js';
import {findOurPokemon, type AnalysisContext} from '../state/analysis.js';
import {entryWeatherOf, estimatedMove, megaSkinAbility, superEffectivePhrase} from '../state/calc.js';
import {toId} from '../state/protocol.js';
import {
  activeEntries, benchEntries, conditionPercent, isFainted, speciesOf, teamSlotOf,
  type BattleRequest,
} from '../state/request.js';
import {describeMoveOption, describeSwitchOption, fakeOutThreats, mainAttackOf, opponentActives, PROTECT_LIKE_MOVES, type OpponentActive} from '../state/serialize.js';
import {speedControlOf, speedControlText} from '../state/speed-control.js';
import type {BattleTracker, PokemonState} from '../state/tracker.js';
import {BATTLE_GOAL} from './battle-goal.js';
import {sceneBriefing} from './scene.js';

export interface SlotMoveAction {
  kind: 'move';
  slot: 1 | 2;
  moveIndex: number;
  /** /choose 的目标写法：'+1'/'+2'（对手 active 位）、'-1'/'-2'（同伴）。不写 = 不需要目标 */
  target?: string;
  mega?: boolean;
}

export interface SlotSwitchAction {
  kind: 'switch';
  slot: 1 | 2;
  teamIndex: number;
}

export type SlotAction = SlotMoveAction | SlotSwitchAction;

export interface SlotOption {
  /** 作为 criteria 的 key，也是 jev choice 答案的取值 */
  key: string;
  /** criteria 里给 jev 看的完整描述 */
  label: string;
  action: SlotAction;
}

export interface SlotQuestionPlan {
  slot: 1 | 2;
  questionName: string;
  options: SlotOption[];
  question: ChoiceQuestion;
}

const TURN_INTRO = BATTLE_GOAL +
  'Check battle_context.turn_outcomes before deciding: it lists what actually happened to moves already used this game (blocked, missed, immune, failed, damage, knockouts), so adapt instead of repeating an action that was already stopped. ' +
  'For the given slot you must pick exactly ONE action in the current turn. ' +
  'Moves that hit both foes need no target. Single-target moves must pick which foe to hit (Foe A / Foe B). ' +
  'Ally-targeting moves support your partner. Switching uses that slot\'s action for the turn and is a full-strength option, not a fallback: ' +
  'it can clear volatile conditions such as Yawn, reset a bad matchup or stat drops, and preserve a weakened Pokemon for later. ' +
  'Only one Pokemon on your whole team may Mega Evolve per battle, and declaring it happens while using the move.';

/** 从 dex 里找 species 的 Mega 形态名（用于 mega 选项的描述文本） */
export function megaNameOf(dex: DexData, species: string, item?: string): string {
  const base = toId(dex.species[toId(species)]?.baseSpecies ?? species);
  for (const info of Object.values(dex.species)) {
    if (info.requiredItem && toId(info.baseSpecies ?? '') === base &&
        (item === undefined || toId(info.requiredItem) === toId(item))) return info.name;
  }
  return 'unknown Mega form';
}

/** mega 形态的属性变化对照表（未变化的属性不列出） */
const MEGA_STAT_LABELS: Array<[string, string]> = [['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Speed']];

/** mega 选项描述：形态名 + 特性与变更后属性（缺数据时退化为形态名） */
function megaSummaryOf(dex: DexData, species: string, item?: string): string {
  const form = megaFormsOf(dex, species).find(f => !!f.requiredItem && (item === undefined || toId(f.requiredItem) === toId(item)));
  if (!form) return megaNameOf(dex, species, item);
  const ability = Object.values(form.abilities ?? {})[0];
  const baseStats = dex.species[toId(form.baseSpecies ?? species)]?.baseStats;
  const changes = baseStats ? MEGA_STAT_LABELS.flatMap(([stat, label]) => {
    const from = baseStats[stat];
    const to = form.baseStats[stat];
    return from !== undefined && to !== undefined && from !== to ? [`${label} ${from}→${to}`] : [];
  }) : [];
  const details = [ability ? `ability ${ability}` : '', ...changes].filter(Boolean);
  return details.length ? `${form.name} (${details.join(', ')})` : form.name;
}

/** 天气型 Mega（如 Sand Stream 班基拉斯）的形态变化说明：再次触发特性并覆盖场上天气；非天气 Mega 返回 null */
function megaWeatherNoteOf(dex: DexData, species: string, item?: string): string | null {
  const form = megaFormsOf(dex, species).find(f => !!f.requiredItem && (item === undefined || toId(f.requiredItem) === toId(item)));
  const ability = form ? Object.values(form.abilities ?? {})[0] : undefined;
  const weather = ability ? entryWeatherOf({ability}) : undefined;
  if (!ability || !weather) return null;
  return `the form change also re-activates ${ability}, setting ${weather.toLowerCase()} again and overwriting the current weather`;
}

/** 皮肤型 Mega（-ate 特性）的打击面说明：转换后属性 + 其克制列表；未发生转换或天气已改属性时 null */
function skinCoverageOf(dex: DexData, skinAbility: string, moveId: string, moveType: string, weather: string | undefined): string | null {
  const skinType = estimatedMove(moveId, moveType, undefined, skinAbility).type;
  if (toId(skinType) === toId(moveType)) return null;
  // 天气已改变属性（如气象球）时皮肤不叠加，避免与头部显示不一致
  if (toId(estimatedMove(moveId, moveType, weather, skinAbility).type) !== toId(skinType)) return null;
  const coverage = superEffectivePhrase(dex, skinType);
  return `post-Mega this move becomes ${skinType}-type${coverage ? ` and is super effective against ${coverage} foes` : ''}`;
}

/** 对手是否物攻向：优先按已揭示招式的类别（物攻不劣于特攻即算），无揭示时按 baseStats atk ≥ spa */
function isPhysicalAttacker(dex: DexData, p: PokemonState): boolean {
  const categories = p.revealedMoves.map(m => dex.moves[toId(m)]?.category);
  const physical = categories.filter(c => c === 'Physical').length;
  const special = categories.filter(c => c === 'Special').length;
  if (physical + special > 0) return physical >= special;
  const stats = dex.species[toId(p.species)]?.baseStats;
  return !!stats && (stats.atk ?? 0) >= (stats.spa ?? 0);
}

/** 群攻选项警示：对手在场且已揭示 Wide Guard——可完全挡下（0 伤害）且可连续使用，没有 Protect 链条的失败率。 */
function wideGuardWarning(p: PokemonState): string {
  const lastUsed = toId(p.lastMoveId ?? '') === 'wideguard' && p.lastMoveTurn !== undefined
    ? ` (last used on turn ${p.lastMoveTurn})` : '';
  return ` — warning: foe ${p.species} has revealed Wide Guard${lastUsed}; it can fully block this spread move (0 damage) and can be repeated on consecutive turns with no failure chance (unlike Protect, which becomes unreliable when chained); consider a single-target move or removing the blocker first`;
}

interface TurnInput {
  dex: DexData;
  request: BattleRequest;
  tracker: BattleTracker;
  analysis?: AnalysisContext;
}

interface TargetSpec {
  suffix: string;
  /** undefined = 指令里不写目标 */
  target?: string;
  /** 指向的对手 active 在 foes 数组中的下标（用于生成描述） */
  foeIndex?: number;
}

/** 依据招式的 target 语义决定需要几个选项变体、各写什么目标 */
function targetSpecsFor(target: string, slot: 1 | 2, foeCount: number): TargetSpec[] {
  if (target === 'normal' || target === 'adjacentFoe' || target === 'any') {
    if (foeCount === 0) return [{suffix: ''}];
    const specs: TargetSpec[] = [];
    for (let i = 0; i < foeCount; i++) {
      specs.push({suffix: i === 0 ? '_foe_a' : '_foe_b', target: `+${i + 1}`, foeIndex: i});
    }
    return specs;
  }
  if (target === 'adjacentAlly' || target === 'adjacentAllyOrSelf') {
    // 槽位 1 的同伴在参战位 2 → '-2'；槽位 2 的同伴在参战位 1 → '-1'
    return [{suffix: '_ally', target: slot === 1 ? '-2' : '-1'}];
  }
  // self / all / allAdjacent / allAdjacentFoes / allySide / foeSide … 都不需要写目标
  return [{suffix: ''}];
}

function buildSlotOptions(input: TurnInput, activeIndex: number, foes: OpponentActive[]): SlotOption[] {
  const {dex, request, tracker} = input;
  const slot = (activeIndex + 1) as 1 | 2;
  const reqActive = request.active?.[activeIndex];
  const me = activeEntries(request)[activeIndex];
  if (!reqActive || !me) return [];
  // fainted 槽位由服务器自动 pass（sim/side.ts getChoiceIndex）；提问会生成错位动作
  if (isFainted(me.condition)) return [];
  const species = speciesOf(me);
  const types = speciesTypes(dex, species);
  const weather = tracker.state.weather;
  const ourSideState = tracker.state.sides[tracker.state.ourSideId ?? request.side.id];
  const speedControl = speedControlOf(tracker.state, tracker.state.ourSideId ?? request.side.id);
  const trackedSelf = findOurPokemon(ourSideState, me);
  // 主攻属性与当前阶级（取 tracker 实时 boosts）：主攻被降时换人强化行 + 招式估算偏差提醒
  const mainStat = mainAttackOf(dex, me);
  const mainAttack = mainStat ? {stat: mainStat, stage: trackedSelf?.boosts?.[mainStat] ?? 0} : undefined;
  // Trick Room 收益注解数据：我方未倒下成员（含替补）的速度估计与在场标记
  const ourLiveSpeeds = (input.analysis?.ourSpeeds ?? []).flatMap(s => {
    const member = request.side.pokemon[s.slot - 1];
    if (s.speed === null || !member || isFainted(member.condition)) return [];
    return [{species: s.species, speed: s.speed, active: member.active === true}];
  });
  // 上一回合用过保护类招式 → 本回合不再提供保护类选项（PS stall 计数：连续使用第二次约 1/3、第三次约 1/9）
  const protectUsedLastTurn = trackedSelf?.lastMoveTurn !== undefined
    && trackedSelf.lastMoveTurn === tracker.state.turn - 1
    && PROTECT_LIKE_MOVES.has(toId(trackedSelf.lastMoveId ?? ''));
  // 对手已用掉本场唯一 Mega 后，目标“Mega 后免疫”的警示不再适用
  const opponentMegaUsed = tracker.state.sides[tracker.state.ourSideId === 'p1' ? 'p2' : 'p1']?.megaUsed === true;
  // 对手在场且整局已揭示 Wide Guard：群攻选项标注可能被完全挡下（仅 L2+）
  const wideGuardFoes = (input.analysis?.level ?? 0) >= 2
    ? (tracker.state.sides[tracker.state.ourSideId === 'p1' ? 'p2' : 'p1']?.pokemon ?? [])
      .filter(p => p.activePos >= 0 && !p.fainted && p.revealedMoves.some(m => toId(m) === 'wideguard'))
    : [];
  // 对手在场物攻向数量：物攻手越多，Coil 等防御强化选项的即时价值越高
  const physicalFoes = (tracker.state.sides[tracker.state.ourSideId === 'p1' ? 'p2' : 'p1']?.pokemon ?? [])
    .filter(p => p.activePos >= 0 && !p.fainted && isPhysicalAttacker(dex, p)).length;
  // 上场后首个行动回合：Fake Out 唯一可用窗口，讲究道具的首个选择即锁招
  const firstActionSinceSwitchIn = trackedSelf?.switchInTurn === undefined
    ? undefined
    : tracker.state.turn - trackedSelf.switchInTurn <= 1;
  const faintedAllies = ourSideState?.pokemon.filter(p => p.fainted).length ?? 0;
  const options: SlotOption[] = [];

  for (let j = 0; j < reqActive.moves.length; j++) {
    const mv = reqActive.moves[j];
    if (mv.disabled || mv.pp <= 0) continue;
    // 上一回合用过保护类招式 → 本回合不提供该选项（连续保护不可靠，避免连续守住）
    if (protectUsedLastTurn && PROTECT_LIKE_MOVES.has(toId(mv.id))) continue;
    const moveInfo = dex.moves[toId(mv.id)];
    // 非状态招均可声明 Mega：踢倒等 basePower=0 的变威力攻击招同样生成 mega 变体；缺招式数据时不生成
    const damaging = moveInfo ? moveInfo.category !== 'Status' : false;
    const hitsBoth = mv.target === 'allAdjacentFoes' || mv.target === 'allAdjacent';
    const canMega = reqActive.canMegaEvo === true && damaging;
    for (const spec of targetSpecsFor(mv.target, slot, foes.length)) {
      const key = `move_${j + 1}${spec.suffix}`;
      const foe = spec.foeIndex != null ? foes[spec.foeIndex] : undefined;
      const optionInput = {
        dex,
        moveId: mv.id,
        moveName: mv.move,
        pp: mv.pp,
        maxpp: mv.maxpp,
        attackerTypes: types,
        attackerStats: me.stats,
        attackerBoosts: trackedSelf?.boosts,
        attackerAbility: me.ability ?? me.baseAbility,
        target: foe ? {label: foe.label, species: foe.species, hpPercent: foe.hpPercent, ident: foe.ident, status: foe.status, boosts: foe.boosts, mega: foe.mega, item: foe.item, consumedItem: foe.consumedItem} : undefined,
        targets: hitsBoth && foes.length ? foes.map(f => ({label: f.label, species: f.species, hpPercent: f.hpPercent, ident: f.ident, status: f.status, boosts: f.boosts})) : undefined,
        analysis: input.analysis,
        attackerSlot: teamSlotOf(request, me),
        hitsBoth,
        weather,
        fieldConditions: tracker.state.fieldConditions,
        speedControl,
        faintedAllies,
        attackerHpPercent: conditionPercent(me.condition),
        firstActionSinceSwitchIn,
        attackerItem: me.item,
        attackerMoves: reqActive.moves.map(entry => entry.id),
        opponentMegaUsed,
        attackerMainAttack: mainAttack,
        attackerPerish: trackedSelf?.perish,
        ourLiveSpeeds,
        activeFoes: foes.flatMap(f => (f.ident ? [f.ident] : [])),
        physicalFoes,
      };
      const wideSuffix = hitsBoth && wideGuardFoes.length ? wideGuardFoes.map(wideGuardWarning).join('') : '';
      const described = describeMoveOption(optionInput);
      const label = described + wideSuffix;
      const action: SlotMoveAction = {kind: 'move', slot, moveIndex: j + 1};
      if (spec.target) action.target = spec.target;
      options.push({key, label, action});
      if (canMega) {
        // 皮肤型 Mega（Salamencite→Aerilate 等）：mega 变体的属性/本系/威力按 post-Mega 形态重算，普通选项保持当前形态
        const skin = megaSkinAbility(dex, species, me.item);
        const megaLabel = skin ? describeMoveOption({...optionInput, attackerAbility: skin}) : described;
        const coverage = skin && moveInfo ? skinCoverageOf(dex, skin, mv.id, moveInfo.type, weather) : null;
        const weatherNote = megaWeatherNoteOf(dex, species, me.item);
        options.push({
          key: `${key}_mega`,
          label: `${megaLabel}${wideSuffix} — MEGA EVOLVE ${species} into ${megaSummaryOf(dex, species, me.item)} with this move (${coverage ? `${coverage}; ` : ''}your team's only Mega; the form change resolves at the start of the turn before any moves, so the new stats and ability already apply this turn — including to this attack and this turn's move order; it also still happens if this Pokemon cannot act this turn (asleep, paralyzed or flinching)${weatherNote ? `; ${weatherNote}` : ''})`,
          action: {...action, mega: true},
        });
      }
    }
  }

  if (reqActive.trapped !== true) {
    // 对手已知 Fake Out 窗口（换入精神场地手时给挡招注解）：威胁来自对手侧 tracker 事实
    const fakeOutGuard = fakeOutThreats(tracker.state);
    // 换出收益（给 jev 比较换人时的正向理由）：Yawn/灭歌解除、低血保存、负面阶级清零
    const outgoing = {
      species,
      yawning: (trackedSelf?.volatiles ?? []).some(v => toId(v) === 'yawn'),
      hpPercent: conditionPercent(me.condition),
      boosts: trackedSelf?.boosts,
      perish: trackedSelf?.perish,
      mainAttack,
    };
    for (const bench of benchEntries(request)) {
      const teamIndex = teamSlotOf(request, bench);
      options.push({
        key: `switch_${teamIndex}`,
        label: describeSwitchOption({dex, pokemon: bench, opponentActives: foes, analysis: input.analysis, teamSlot: teamIndex, weather, outgoing, fakeOutGuard}),
        action: {kind: 'switch', slot, teamIndex},
      });
    }
  }
  return options;
}

/** 每个参战槽位一个问题：action_slot_1 / action_slot_2 */
export function buildTurnPlans(input: TurnInput): SlotQuestionPlan[] {
  const foes = opponentActives(input.dex, input.tracker.state).filter(a => a.status !== 'fnt' && a.hpPercent > 0);
  const speedText = speedControlText(input.tracker.state, input.tracker.state.ourSideId ?? input.request.side.id);
  // 被 Yawn 的我方在场成员：明确会睡着、换出可解除（tracker 只记录 volatile 字面值，须在此解释机制）
  const ourSide = input.tracker.state.sides[input.tracker.state.ourSideId ?? input.request.side.id];
  const yawnText = activeEntries(input.request)
    .map(me => ({species: speciesOf(me), tracked: findOurPokemon(ourSide, me)}))
    .filter(x => (x.tracked?.volatiles ?? []).some(v => toId(v) === 'yawn'))
    .map(x => `Yawn on our ${x.species}: it falls asleep at the end of the next resolved turn unless it switches out; switching out removes Yawn and the replacement is unaffected.`)
    .join(' ');
  // 场上简报：速度线与对手已暴露情报（不重复 speedControlText 已覆盖的天气/空间/顺风）
  const scene = sceneBriefing({dex: input.dex, request: input.request, state: input.tracker.state});
  const plans: SlotQuestionPlan[] = [];
  const activeCount = input.request.active?.length ?? 0;
  for (let i = 0; i < activeCount; i++) {
    const slot = (i + 1) as 1 | 2;
    const options = buildSlotOptions(input, i, foes);
    if (options.length === 0) continue;
    const criteria: Record<string, string> = {};
    for (const option of options) criteria[option.key] = option.label;
    plans.push({
      slot,
      questionName: `action_slot_${slot}`,
      options,
      question: {
        type: 'choice',
        instructions: `${TURN_INTRO} It is turn ${input.tracker.state.turn}.${speedText ? ` ${speedText}` : ''}${yawnText ? ` ${yawnText}` : ''}${scene ? ` ${scene}` : ''} Choose the action for slot ${slot}.`,
        criteria,
      },
    });
  }
  return plans;
}
