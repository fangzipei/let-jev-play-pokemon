import type {DexData} from '../dex/index.js';
import type {PriorMeta} from '../dex/priors.js';
import type {AnalysisContext} from '../state/analysis.js';
import {benchEntries, conditionPercent, speciesOf, teamSlotOf, type BattleRequest} from '../state/request.js';
import {describeSwitchOption, opponentActives} from '../state/serialize.js';
import {speedControlText} from '../state/speed-control.js';
import type {BattleTracker} from '../state/tracker.js';
import {lethalThreatsFor, type SlotOption, type SlotQuestionPlan} from './turn.js';
import {BATTLE_GOAL} from './battle-goal.js';
import {sceneBriefing} from './scene.js';

const SWITCH_INTRO = BATTLE_GOAL +
  'The server requires a replacement for this slot, for example after fainting or a forced pivot. Pick exactly ONE bench Pokemon to send in. ' +
  'The replacement enters the field immediately and will be exposed to the opponents listed below.';

/** 每个 forceSwitch 为 true 的槽位一个问题：switch_slot_1 / switch_slot_2 */
export function buildSwitchPlans(input: {dex: DexData; request: BattleRequest; tracker: BattleTracker; analysis?: AnalysisContext; priors?: PriorMeta | null}): SlotQuestionPlan[] {
  const forceSwitch = input.request.forceSwitch ?? [];
  const foes = opponentActives(input.dex, input.tracker.state).filter(a => a.status !== 'fnt' && a.hpPercent > 0);
  const bench = benchEntries(input.request);
  const speedText = speedControlText(input.tracker.state, input.tracker.state.ourSideId ?? input.request.side.id);
  const scene = sceneBriefing({dex: input.dex, request: input.request, state: input.tracker.state});
  const requiredSlots = forceSwitch.filter(Boolean).length;
  // 必答槽位多于可用替补时，每槽位追加 pass 出口：避免两槽位必答同一只（服务器拒绝 can only switch in once）
  const needPass = requiredSlots > bench.length;
  const plans: SlotQuestionPlan[] = [];
  for (let i = 0; i < forceSwitch.length; i++) {
    if (!forceSwitch[i]) continue;
    if (bench.length === 0) continue; // 无替补可换 → 交由兜底输出 pass
    const slot = (i + 1) as 1 | 2;
    const options: SlotOption[] = bench.map(p => {
      const teamIndex = teamSlotOf(input.request, p);
      // 换入者的致死警示：强制换人的替补同样按实际防御值与当前血量、同口径估算（登场前无 boosts）
      const threats = lethalThreatsFor(input, p, undefined, speciesOf(p), foes, conditionPercent(p.condition));
      return {
        key: `switch_${teamIndex}`,
        label: describeSwitchOption({dex: input.dex, pokemon: p, opponentActives: foes, analysis: input.analysis, teamSlot: teamIndex, forced: true, weather: input.tracker.state.weather, lethalThreats: threats}),
        action: {kind: 'switch', slot, teamIndex},
      };
    });
    if (needPass) {
      options.push({
        key: 'pass',
        label: `pass — send no replacement for slot ${slot}. Use this only when the bench holds fewer Pokemon than the slots that must switch: give the remaining bench Pokemon to one of the other switching slots instead, because claiming the same Pokemon in two slots is rejected by the server`,
        action: {kind: 'pass', slot},
      });
    }
    const criteria: Record<string, string> = {};
    for (const option of options) criteria[option.key] = option.label;
    plans.push({
      slot,
      questionName: `switch_slot_${slot}`,
      options,
      question: {
        type: 'choice',
        instructions: `${SWITCH_INTRO}${speedText ? ` ${speedText}` : ''}${scene ? ` ${scene}` : ''} This is slot ${slot}.`,
        criteria,
      },
    });
  }
  return plans;
}
