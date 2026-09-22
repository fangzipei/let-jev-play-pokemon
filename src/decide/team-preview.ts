import type {DexData} from '../dex/index.js';
import type {Answer, Question} from '../jev/types.js';
import type {BattleRequest} from '../state/request.js';
import {describePreviewCandidate, isMegaCapable} from '../state/serialize.js';
import {resolveKey} from './answers.js';

export const PREVIEW_QUESTION_NAMES = ['lead_1', 'lead_2', 'bring_3', 'bring_4'] as const;

export interface PreviewQuestionSet {
  questions: Record<string, Question>;
  descriptionByKey: Record<string, string>;
}

const INTRO =
  'You are choosing which 4 of your 6 Pokemon to bring to a doubles (VGC-style) battle, and in which order. ' +
  'The first two brought Pokemon are your leads (they start on the field). ' +
  'Species/item clauses are active; Mega Evolution is limited to one Pokemon per battle.';

export function buildPreviewQuestions(input: {
  dex: DexData;
  request: BattleRequest;
  opponentPreviewSpecies: string[];
}): PreviewQuestionSet {
  const descriptionByKey: Record<string, string> = {};
  input.request.side.pokemon.forEach((pokemon, index) => {
    descriptionByKey[`slot_${index + 1}`] = describePreviewCandidate({
      dex: input.dex,
      pokemon,
      opponentPreviewSpecies: input.opponentPreviewSpecies,
      megaCapable: isMegaCapable(input.dex, pokemon),
    });
  });

  const instructions: Record<string, string> = {
    lead_1: `${INTRO} Pick your FIRST lead: the Pokemon that should start the battle given the opponent's 6 revealed Pokemon.`,
    lead_2: `${INTRO} Pick your SECOND lead: it must be the best partner for your already-chosen first lead, do NOT reuse a slot that was already picked.`,
    bring_3: `${INTRO} Pick the THIRD Pokemon to bring (first reserve): the best remaining answer to the opponent's threats, do NOT reuse an already-picked slot.`,
    bring_4: `${INTRO} Pick the FOURTH Pokemon to bring (second reserve): the best remaining coverage, do NOT reuse an already-picked slot.`,
  };

  const questions: Record<string, Question> = {};
  for (const name of PREVIEW_QUESTION_NAMES) {
    questions[name] = {type: 'choice', instructions: instructions[name], criteria: {...descriptionByKey}};
  }
  return {questions, descriptionByKey};
}

/** 按 lead_1 → lead_2 → bring_3 → bring_4 取答案；重复/非法时用 probabilities 或首个未用槽位补齐 */
export function resolvePreviewOrder(
  answers: Record<string, Answer>,
  questionNames: readonly string[] = PREVIEW_QUESTION_NAMES,
): {order: number[]; adjusted: string[]} {
  const used: number[] = [];
  const adjusted: string[] = [];
  for (const name of questionNames) {
    const validKeys = [1, 2, 3, 4, 5, 6]
      .filter(n => !used.includes(n))
      .map(n => `slot_${n}`);
    const resolved = resolveKey(answers[name], validKeys);
    if (resolved) {
      if (resolved.adjusted) adjusted.push(`${name}: ${resolved.key}`);
      used.push(Number(resolved.key.replace('slot_', '')));
    } else {
      adjusted.push(`missing:${name}`);
      const firstFree = [1, 2, 3, 4, 5, 6].find(n => !used.includes(n));
      if (firstFree !== undefined) used.push(firstFree);
    }
  }
  return {order: used, adjusted};
}

/** 完整 6 位 team order：前 4 位为带入顺序（前两位首发），后 2 位按自然顺序补齐 */
export function fullTeamOrder(order4: number[]): number[] {
  const rest = [1, 2, 3, 4, 5, 6].filter(n => !order4.includes(n));
  return [...order4, ...rest];
}
