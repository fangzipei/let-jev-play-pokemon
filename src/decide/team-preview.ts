import {getMove, speciesTypes, type DexData} from '../dex/index.js';
import {priorEntryFor, type PriorMeta} from '../dex/priors.js';
import type {Answer, Question} from '../jev/types.js';
import type {MemoryData} from '../learn/store.js';
import type {BattleRequest} from '../state/request.js';
import type {AnalysisContext} from '../state/analysis.js';
import {expectedFoeLeadLines, expectedFoeLeads, likelyMegaForm, speciesRecordLines, SPREAD_MOVE_CONDITION, topCoreLine} from '../state/opponent-notes.js';
import {toId} from '../state/protocol.js';
import {describePreviewCandidate, isMegaCapable, type LikelyMegaFoe, type PreviewLeadIntel} from '../state/serialize.js';
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

/** 我方全队可用的无损群攻招式（allAdjacentFoes；含条件群攻的展开说明），按队伍顺序，上限 6 条。 */
function ourSpreadMoves(dex: DexData, request: BattleRequest): string[] {
  const out: string[] = [];
  for (const pokemon of request.side.pokemon) {
    const species = pokemon.details.split(',')[0]?.trim() || pokemon.ident.split(':')[1]?.trim() || '?';
    for (const moveId of pokemon.moves ?? []) {
      const move = getMove(dex, moveId);
      if (!move) continue;
      const condition = SPREAD_MOVE_CONDITION[toId(move.name)];
      if (move.target !== 'allAdjacentFoes' && condition === undefined) continue;
      out.push(`${species} ${move.name}${condition ? ` (${condition})` : ''}`);
    }
  }
  return out.slice(0, 6);
}

export function buildPreviewQuestions(input: {
  dex: DexData;
  request: BattleRequest;
  opponentPreviewSpecies: string[];
  analysis?: AnalysisContext;
  /** 跨局经验库（L2+ 用于预期首发/交手战绩/常见组合；缺省不输出经验段） */
  memory?: MemoryData | null;
  /** 对手群攻先验（L2+ 用于群攻警示与对攻引导；缺省或 L1 不输出） */
  opponentSpreadThreats?: string[];
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
  const foeLeads = level2 ? expectedFoeLeads(priors, input.memory, input.opponentPreviewSpecies, {dex: input.dex}) : [];
  const leadIntelFoes: PreviewLeadIntel[] = foeLeads.map(lead => ({
    species: lead.species,
    types: speciesTypes(input.dex, lead.species),
    memory: lead.memorySeen !== null
      ? {seen: lead.memorySeen, wins: lead.memoryWins ?? 0, losses: lead.memoryLosses ?? 0, leads: lead.memoryLeads ?? 0}
      : null,
  }));
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
      leadIntel: level2 ? {foeLeads: leadIntelFoes} : undefined,
    });
  });

  const megaHolders = input.request.side.pokemon.filter(p => isMegaCapable(input.dex, p)).length;
  const megaAdvice = megaHolders >= 2
    ? ` Your team has ${megaHolders} Mega-capable Pokemon; only one can Mega Evolve per battle, so bring exactly one of them and use the other slot for a different answer - a second Mega-capable Pokemon wastes a slot.`
    : megaHolders === 1
      ? ' Your team has one Mega-capable Pokemon; include it in your four so you keep the option to Mega Evolve.'
      : '';
  // 预期首发段与逐槽经验段同源：先验与经验库各自标注来源；两来源皆缺时不输出经验段
  const leadLines = expectedFoeLeadLines(foeLeads);
  const records = level2 ? speciesRecordLines(input.memory, foeLeads.map(lead => lead.species), {dex: input.dex}) : [];
  const core = level2 ? topCoreLine(input.memory, input.opponentPreviewSpecies) : null;
  const recordParts = [
    records.length ? `vs ${records.join(', ')}` : '',
    core ? `most common core ${core}` : '',
  ].filter(Boolean);
  const leadsSentence = leadLines.length ? ` Most probable foe leads: ${leadLines.join('; ')}.` : '';
  const recordsSentence = recordParts.length ? ` Your recorded results: ${recordParts.join('; ')}.` : '';
  // 指导句只引用实际存在的分段，避免指向不存在的 leads/records
  const guideDetail = [
    leadLines.length ? 'type matchups against these leads' : '',
    recordParts.length ? 'your records' : '',
  ].filter(Boolean);
  const leadIntelText = leadsSentence || recordsSentence
    ? leadsSentence + recordsSentence + ` Use each slot's "as a lead:" evaluation (speed${guideDetail.length ? `, ${guideDetail.join(' and ')}` : ''}) when choosing your own lead pair and bring order for this opponent; do not reuse the same leads every game.`
    : '';
  const spreadThreats = level2 ? input.opponentSpreadThreats ?? [] : [];
  const ourSpread = spreadThreats.length ? ourSpreadMoves(input.dex, input.request) : [];
  const spreadAdvice = spreadThreats.length
    ? ` Opponent spread threats from tournament priors: ${spreadThreats.join('; ')}. Spread moves hit both foes at once and ignore redirection (Follow Me cannot redirect them), so avoid a lead pair that is both weak to the same spread move and plan Protect, Wide Guard or a resist against it.`
      + (ourSpread.length
        ? ` Answer with your own spread moves (they hit both foes at once) instead of trading single-target hits: ${ourSpread.join('; ')}.`
        : '')
    : '';
  const coverageAdvice = likelyMegaFoes.length
    ? " Check each slot's likely-form coverage: when it lists a probable Mega form, favor that attacker and vary your lead pair instead of repeating a default combination."
    : '';
  const intro = INTRO + (input.analysis && input.analysis.level >= 2
    ? ' Vary your leads based on the opponent: consider both directions of type matchups, uncertain speed information and current team roles; do not default to the same leads every game.' + coverageAdvice + megaAdvice + leadIntelText + spreadAdvice : '');
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
