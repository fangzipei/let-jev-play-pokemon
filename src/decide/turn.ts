import {megaFormsOf, speciesTypes, type DexData} from '../dex/index.js';
import type {ChoiceQuestion} from '../jev/types.js';
import {findOurPokemon, type AnalysisContext} from '../state/analysis.js';
import {toId} from '../state/protocol.js';
import {
  activeEntries, benchEntries, isFainted, speciesOf, teamSlotOf,
  type BattleRequest,
} from '../state/request.js';
import {describeMoveOption, describeSwitchOption, opponentActives, type OpponentActive} from '../state/serialize.js';
import {speedControlOf, speedControlText} from '../state/speed-control.js';
import type {BattleTracker} from '../state/tracker.js';
import {BATTLE_GOAL} from './battle-goal.js';

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
  'For the given slot you must pick exactly ONE action in the current turn. ' +
  'Moves that hit both foes need no target. Single-target moves must pick which foe to hit (Foe A / Foe B). ' +
  'Ally-targeting moves support your partner. Switching uses that slot\'s action for the turn. ' +
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

/** mega 选项描述：形态名 + 变更后的特性与速度（缺数据时退化为形态名） */
function megaSummaryOf(dex: DexData, species: string, item?: string): string {
  const form = megaFormsOf(dex, species).find(f => !!f.requiredItem && (item === undefined || toId(f.requiredItem) === toId(item)));
  if (!form) return megaNameOf(dex, species, item);
  const ability = Object.values(form.abilities ?? {})[0];
  const details = [ability ? `ability ${ability}` : '', form.baseStats.spe !== undefined ? `Speed ${form.baseStats.spe}` : ''].filter(Boolean);
  return details.length ? `${form.name} (${details.join(', ')})` : form.name;
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
  // 对手已用掉本场唯一 Mega 后，目标“Mega 后免疫”的警示不再适用
  const opponentMegaUsed = tracker.state.sides[tracker.state.ourSideId === 'p1' ? 'p2' : 'p1']?.megaUsed === true;
  // 上场后首个行动回合：Fake Out 唯一可用窗口，讲究道具的首个选择即锁招
  const firstActionSinceSwitchIn = trackedSelf?.switchInTurn === undefined
    ? undefined
    : tracker.state.turn - trackedSelf.switchInTurn <= 1;
  const faintedAllies = ourSideState?.pokemon.filter(p => p.fainted).length ?? 0;
  const options: SlotOption[] = [];

  for (let j = 0; j < reqActive.moves.length; j++) {
    const mv = reqActive.moves[j];
    if (mv.disabled || mv.pp <= 0) continue;
    const moveInfo = dex.moves[toId(mv.id)];
    const damaging = (moveInfo?.basePower ?? 0) > 0;
    const hitsBoth = mv.target === 'allAdjacentFoes' || mv.target === 'allAdjacent';
    const canMega = reqActive.canMegaEvo === true && damaging;
    for (const spec of targetSpecsFor(mv.target, slot, foes.length)) {
      const key = `move_${j + 1}${spec.suffix}`;
      const foe = spec.foeIndex != null ? foes[spec.foeIndex] : undefined;
      const label = describeMoveOption({
        dex,
        moveId: mv.id,
        moveName: mv.move,
        pp: mv.pp,
        maxpp: mv.maxpp,
        attackerTypes: types,
        attackerStats: me.stats,
        target: foe ? {label: foe.label, species: foe.species, hpPercent: foe.hpPercent, ident: foe.ident} : undefined,
        analysis: input.analysis,
        attackerSlot: teamSlotOf(request, me),
        hitsBoth,
        weather,
        fieldConditions: tracker.state.fieldConditions,
        speedControl,
        faintedAllies,
        firstActionSinceSwitchIn,
        attackerItem: me.item,
        opponentMegaUsed,
      });
      const action: SlotMoveAction = {kind: 'move', slot, moveIndex: j + 1};
      if (spec.target) action.target = spec.target;
      options.push({key, label, action});
      if (canMega) {
        options.push({
          key: `${key}_mega`,
          label: `${label} — MEGA EVOLVE ${species} into ${megaSummaryOf(dex, species, me.item)} with this move (your team's only Mega; the form change resolves before any moves this turn, so the new ability and stats including Speed apply immediately; declaring it early is usually better — the Mega is wasted if this Pokemon faints before you declare it)`,
          action: {...action, mega: true},
        });
      }
    }
  }

  if (reqActive.trapped !== true) {
    for (const bench of benchEntries(request)) {
      const teamIndex = teamSlotOf(request, bench);
      options.push({
        key: `switch_${teamIndex}`,
        label: describeSwitchOption({dex, pokemon: bench, opponentActives: foes, analysis: input.analysis, teamSlot: teamIndex}),
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
        instructions: `${TURN_INTRO} It is turn ${input.tracker.state.turn}.${speedText ? ` ${speedText}` : ''} Choose the action for slot ${slot}.`,
        criteria,
      },
    });
  }
  return plans;
}
