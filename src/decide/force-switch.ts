import type {DexData} from '../dex/index.js';
import {benchEntries, teamSlotOf, type BattleRequest} from '../state/request.js';
import {describeSwitchOption, opponentActives} from '../state/serialize.js';
import type {BattleTracker} from '../state/tracker.js';
import type {SlotOption, SlotQuestionPlan} from './turn.js';

const SWITCH_INTRO =
  'One of your Pokemon fainted and must be replaced before the next turn. For the given slot pick exactly ONE bench Pokemon to send in. ' +
  'The replacement enters the field immediately and will be exposed to the opponents listed below.';

/** 每个 forceSwitch 为 true 的槽位一个问题：switch_slot_1 / switch_slot_2 */
export function buildSwitchPlans(input: {dex: DexData; request: BattleRequest; tracker: BattleTracker}): SlotQuestionPlan[] {
  const forceSwitch = input.request.forceSwitch ?? [];
  const foes = opponentActives(input.dex, input.tracker.state).filter(a => a.status !== 'fnt' && a.hpPercent > 0);
  const bench = benchEntries(input.request);
  const plans: SlotQuestionPlan[] = [];
  for (let i = 0; i < forceSwitch.length; i++) {
    if (!forceSwitch[i]) continue;
    if (bench.length === 0) continue; // 无替补可换 → 交由兜底输出 pass
    const slot = (i + 1) as 1 | 2;
    const options: SlotOption[] = bench.map(p => {
      const teamIndex = teamSlotOf(input.request, p);
      return {
        key: `switch_${teamIndex}`,
        label: describeSwitchOption({dex: input.dex, pokemon: p, opponentActives: foes}),
        action: {kind: 'switch', slot, teamIndex},
      };
    });
    const criteria: Record<string, string> = {};
    for (const option of options) criteria[option.key] = option.label;
    plans.push({
      slot,
      questionName: `switch_slot_${slot}`,
      options,
      question: {
        type: 'choice',
        instructions: `${SWITCH_INTRO} This is slot ${slot}.`,
        criteria,
      },
    });
  }
  return plans;
}
