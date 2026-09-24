import type {DexData} from '../dex/index.js';
import {priorEntryFor, type PriorMeta} from '../dex/priors.js';
import type {Answer, Question} from '../jev/types.js';
import type {BattleRequest} from '../state/request.js';
import type {AnalysisContext} from '../state/analysis.js';
import {likelyMegaForm} from '../state/opponent-notes.js';
import {describePreviewCandidate, isMegaCapable, type LikelyMegaFoe} from '../state/serialize.js';
import {resolveKey} from './answers.js';
import {BATTLE_GOAL} from './battle-goal.js';

export const PREVIEW_QUESTION_NAMES = ['lead_1', 'lead_2', 'bring_3', 'bring_4'] as const;

export interface PreviewQuestionSet {
  questions: Record<string, Question>;
  descriptionByKey: Record<string, string>;
}

const INTRO = BATTLE_GOAL +
  'You are choosing which 4 of your 6 Pokemon to bring to a doubles (VGC-style) battle, and in which order. ' +
  'The first two brought Pokemon are your leads (they start on the field). ' +
  'Species/item clauses are active; Mega Evolution is limited to one Pokemon per battle. ' +
  'These four choices are independent questions in the same batch; answers to other questions are not available. ' +
  'Plan one coherent team of four distinct slots: two complementary leads and two reserves supporting the same win condition. ' +
  'Use each question role to express that combination; duplicates will be resolved after the batch.';

export function buildPreviewQuestions(input: {
  dex: DexData;
  request: BattleRequest;
  opponentPreviewSpecies: string[];
  analysis?: AnalysisContext;
  opponentLeadPriors?: string[];
  /** 统计先验（L2+ 用于预期 Mega 形态对位；缺省或 L1 不输出） */
  priors?: PriorMeta | null;
}): PreviewQuestionSet {
  const level2 = input.analysis !== undefined && input.analysis.level >= 2;
  const priors = input.priors;
  const likelyMegaFoes: LikelyMegaFoe[] = level2 && priors
    ? input.opponentPreviewSpecies
        .flatMap(species => {
          const entry = priorEntryFor(priors, species);
          if (!entry) return [];
          const found = likelyMegaForm(input.dex, species, entry);
          return found ? [{species, name: found.mega.name, types: [...found.mega.types], percent: found.pair.percent}] : [];
        })
        .sort((a, b) => b.percent - a.percent)
    : [];
  const descriptionByKey: Record<string, string> = {};
  input.request.side.pokemon.forEach((pokemon, index) => {
    descriptionByKey[`slot_${index + 1}`] = describePreviewCandidate({
      dex: input.dex,
      pokemon,
      opponentPreviewSpecies: input.opponentPreviewSpecies,
      megaCapable: isMegaCapable(input.dex, pokemon),
      analysis: input.analysis,
      teamSlot: index + 1,
      likelyMegaFoes,
    });
  });

  const megaHolders = input.request.side.pokemon.filter(p => isMegaCapable(input.dex, p)).length;
  const megaAdvice = megaHolders >= 2
    ? ` Your team has ${megaHolders} Mega-capable Pokemon; only one can Mega Evolve per battle, so bring exactly one of them and use the other slot for a different answer - a second Mega-capable Pokemon wastes a slot.`
    : megaHolders === 1
      ? ' Your team has one Mega-capable Pokemon; include it in your four so you keep the option to Mega Evolve.'
      : '';
  const leadPriors = input.analysis && input.analysis.level >= 2 && input.opponentLeadPriors?.length
    ? ` Opponent lead tendencies from tournament priors: ${input.opponentLeadPriors.join('; ')}.`
    : '';
  const coverageAdvice = likelyMegaFoes.length
    ? " Check each slot's likely-form coverage: when it lists a probable Mega form, favor that attacker and vary your lead pair instead of repeating a default combination."
    : '';
  const intro = INTRO + (input.analysis && input.analysis.level >= 2
    ? ' Vary your leads based on the opponent: consider both directions of type matchups, uncertain speed information and current team roles; do not default to the same leads every game.' + coverageAdvice + megaAdvice + leadPriors : '');
  const instructions: Record<string, string> = {
    lead_1: `${intro} Pick your FIRST lead: the primary anchor of your intended lead pair against the opponent preview.`,
    lead_2: `${intro} Pick your SECOND lead: a complementary partner in the intended lead pair, rather than a second copy of its primary anchor.`,
    bring_3: `${intro} Pick the THIRD Pokemon (first reserve): the main backup answer to threats that pressure your intended leads.`,
    bring_4: `${intro} Pick the FOURTH Pokemon (second reserve): complementary coverage and an endgame plan for that intended four-Pokemon combination.`,
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
