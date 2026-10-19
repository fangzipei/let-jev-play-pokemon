import {getMove, speciesTypes, type DexData} from '../dex/index.js';
import {priorEntryFor, type PriorMeta} from '../dex/priors.js';
import type {Answer, Question} from '../jev/types.js';
import type {MemoryData} from '../learn/store.js';
import type {BattleRequest} from '../state/request.js';
import type {AnalysisContext} from '../state/analysis.js';
import {expectedFoeLeadLines, expectedFoeLeads, likelyMegaForm, speciesRecordLines, SPREAD_MOVE_CONDITION, topCoreLine} from '../state/opponent-notes.js';
import {hasEntryWeatherSetter} from '../state/calc.js';
import {toId} from '../state/protocol.js';
import {describePreviewCandidate, isMegaCapable, type LikelyMegaFoe, type PreviewLeadIntel} from '../state/serialize.js';
import {BATTLE_GOAL} from './battle-goal.js';

export const PREVIEW_QUESTION_NAMES = ['lead_1', 'lead_2', 'bring_3', 'bring_4'] as const;

export interface PreviewQuestionSet {
  questions: Record<string, Question>;
  descriptionByKey: Record<string, string>;
  /** 四个问题共享的选队上下文（批次规则 + 对手相关指导）：随 state 送一次，不逐题重复 */
  briefing: string;
}

/**
 * 批次级共享上下文：先验/经验驱动的选队指导句也拼到这里（只出现一次）。
 * 逐题指令只保留整局目标与本题任务，避免同一段文本在四个问题里各复制一遍。
 */
const FRAMING =
  'You are choosing which 4 of your 6 Pokemon to bring to a doubles (VGC-style) battle, and in which order. ' +
  'The first two brought Pokemon are your leads (they start on the field). ' +
  'Species/item clauses are active; Mega Evolution is limited to one Pokemon per battle. ' +
  'These four choices are independent questions in the same batch; answers to other questions are not available. ' +
  'Plan one coherent team of four distinct slots: two complementary leads and two reserves supporting the same win condition. ' +
  'Use each question role to express that combination; duplicates will be resolved after the batch. ' +
  'Never answer with a Pokemon already used in this batch: if your preferred pick for a question is taken, answer your next-best different slot instead of repeating - a repeated answer wastes the question because it will be replaced.';

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
    ? ` Your team has ${megaHolders} Mega-capable Pokemon; only one can Mega Evolve per battle. Bring exactly one of them in every battle: bringing zero gives up your Mega entirely, and bringing both wastes a slot. If both matchups look poor against this opponent's preview, still bring the better of the two and use your other three slots for the matchup answers.` +
      ' A Mega whose entry effect blunts the foe\'s offense (Intimidate, a speed-control move like Tailwind) is the stronger lead against physical or setup-reliant previews; a Mega with entry weather or greater bulk is better in attrition matchups.'
    : megaHolders === 1
      ? ' Your team has one Mega-capable Pokemon; include it in your four in every battle: leaving it out gives up your Mega entirely. If its matchup looks poor against this opponent, still bring it and use your other three slots for the matchup answers.'
      : '';
  // 对手预览自带入场天气时：提示用我方天气手覆盖（不必是 Mega 进化者），优先级高于 one-Mega 指导
  const foeWeatherSetters = input.opponentPreviewSpecies.filter(species => hasEntryWeatherSetter(input.dex, species));
  const ourWeatherSetters = input.request.side.pokemon
    .map(pokemon => pokemon.details.split(',')[0]?.trim() || pokemon.ident.split(':')[1]?.trim() || '')
    .filter(species => species && hasEntryWeatherSetter(input.dex, species));
  const weatherAdvice = foeWeatherSetters.length && ourWeatherSetters.length
    ? ` The foe preview can set weather on entry (${foeWeatherSetters.join(', ')}); bring ${ourWeatherSetters.join(' or ')} to overwrite it with your own entry weather - that takes priority over the one-Mega guideline above, and the weather setter does not need to be the Pokemon that Mega Evolves.`
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
  // 反事实覆盖检查：四题独立作答时模型不会自查“留下的槽位是否让某威胁失去答案”，用一句显式自查补上（只进简报，不逐题重复）
  const counterfactualAdvice = ' Before locking in your four, run one counterfactual: for each threat you expect from the opponent preview, name which of your answers handles it - if the slot you leave out was your only answer to a real threat, swap it back in.';
  const briefing = FRAMING + (input.analysis && input.analysis.level >= 2
    ? ' Vary your leads based on the opponent: consider both directions of type matchups, uncertain speed information and current team roles; do not default to the same leads every game. A support or terrain setter earns a lead slot only when its entry effect or matchup answers the opponent\'s likely opening, not out of habit.' + coverageAdvice + megaAdvice + weatherAdvice + leadIntelText + spreadAdvice + counterfactualAdvice : '');
  const instructions: Record<string, string> = {
    lead_1: `${BATTLE_GOAL} Read state.briefing for this batch's shared selection rules, opponent reads and matchup guidance. Pick your FIRST lead: the primary anchor of your intended lead pair against the opponent preview.`,
    lead_2: `${BATTLE_GOAL} Read state.briefing for this batch's shared selection rules, opponent reads and matchup guidance. Pick your SECOND lead: a complementary partner in the intended lead pair and a DIFFERENT Pokemon than your first lead; if your ideal pair would reuse the same anchor, promote your next-best partner instead of a second copy of its primary anchor.`,
    bring_3: `${BATTLE_GOAL} Read state.briefing for this batch's shared selection rules, opponent reads and matchup guidance. Pick the THIRD Pokemon (first reserve): the main backup answer to threats that pressure your intended leads, and a Pokemon you have not answered with in the other questions.`,
    bring_4: `${BATTLE_GOAL} Read state.briefing for this batch's shared selection rules, opponent reads and matchup guidance. Pick the FOURTH Pokemon (second reserve): the flex slot that closes the biggest remaining gap of your intended four against this opponent preview - if two candidates look close, take the one the opponent must plan around rather than the passive backup. It must differ from your other three answers.`,
  };

  const questions: Record<string, Question> = {};
  for (const name of PREVIEW_QUESTION_NAMES) {
    questions[name] = {type: 'choice', instructions: instructions[name], criteria: {...descriptionByKey}};
  }
  return {questions, descriptionByKey, briefing};
}

/** 各槽位的角色标签集合（用于修正重复答案时衡量与已用槽位的互补性）。 */
export function slotRoleVector(dex: DexData, request: BattleRequest): Record<number, Set<string>> {
  const TERRAIN = new Set(['psychicsurge', 'electricsurge', 'grassyurge', 'mistyurge']);
  const WEATHER = new Set(['sandstream', 'drizzle', 'drought', 'snowwarning']);
  const SUPPORT = new Set(['followme', 'ragepowder', 'helpinghand', 'wideguard', 'fakeout']);
  const SPEED_CTRL = new Set(['tailwind', 'trickroom']);
  const roles: Record<number, Set<string>> = {};
  request.side.pokemon.forEach((pokemon, index) => {
    const set = new Set<string>();
    const abilityId = toId(pokemon.ability ?? pokemon.baseAbility ?? '');
    if (TERRAIN.has(abilityId)) set.add('terrain');
    if (WEATHER.has(abilityId)) set.add('weather');
    if (abilityId === 'intimidate') set.add('intimidate');
    for (const mid of pokemon.moves ?? []) {
      const mId = toId(mid);
      if (SUPPORT.has(mId)) set.add('support');
      if (SPEED_CTRL.has(mId)) set.add('speed_control');
      const mv = getMove(dex, mid);
      if (mv && mv.basePower >= 75) {
        if (mv.category === 'Physical') set.add('physical');
        else if (mv.category === 'Special') set.add('special');
      }
    }
    roles[index + 1] = set;
  });
  return roles;
}

/** 按 lead_1 → lead_2 → bring_3 → bring_4 取答案；重复/非法时综合 probabilities 与角色互补性修正。 */
export function resolvePreviewOrder(
  answers: Record<string, Answer>,
  questionNames: readonly string[] = PREVIEW_QUESTION_NAMES,
  /** 各槽位角色向量：修正时对与已用槽重叠多的候选降权（每重叠一个标签扣 0.15），使 lead_2/bring 更互补 */
  slotRoles?: Record<number, Set<string>>,
): {order: number[]; adjusted: string[]} {
  const used: number[] = [];
  const adjusted: string[] = [];
  for (const name of questionNames) {
    const validKeys = [1, 2, 3, 4, 5, 6]
      .filter(n => !used.includes(n))
      .map(n => `slot_${n}`);
    const answer = answers[name];
    // 原始答案合法：直接取
    if (answer && answer.type === 'choice' && typeof answer.choice === 'string' && validKeys.includes(answer.choice)) {
      used.push(Number(answer.choice.replace('slot_', '')));
      continue;
    }
    // 修正：用角色互补加权后的有效分排序（无 slotRoles 时退化为纯 probabilities argmax）
    const probs = answer && answer.type === 'choice' ? answer.probabilities : undefined;
    if (probs && validKeys.length) {
      const ROLE_PENALTY = 0.15;
      const scored = validKeys.map(key => {
        const slot = Number(key.replace('slot_', ''));
        let score = probs[key] ?? 0;
        if (slotRoles && used.length) {
          const candRoles = slotRoles[slot];
          if (candRoles?.size) {
            for (const u of used) {
              const usedRoles = slotRoles[u];
              if (!usedRoles) continue;
              for (const r of candRoles) if (usedRoles.has(r)) score -= ROLE_PENALTY;
            }
          }
        }
        return {key, score};
      }).sort((a, b) => b.score - a.score);
      const best = scored[0]!;
      adjusted.push(`${name}: ${best.key}`);
      used.push(Number(best.key.replace('slot_', '')));
      continue;
    }
    adjusted.push(`missing:${name}`);
    const firstFree = [1, 2, 3, 4, 5, 6].find(n => !used.includes(n));
    if (firstFree !== undefined) used.push(firstFree);
  }
  return {order: used, adjusted};
}

/** 四题 probabilities 逐槽取最大值：衡量模型对各槽位的整体偏好（缺省 0），供零 Mega 兜底等结构指令排序。 */
export function previewSlotScores(answers: Record<string, Answer>): Record<number, number> {
  const scores: Record<number, number> = {};
  for (const name of PREVIEW_QUESTION_NAMES) {
    const answer = answers[name];
    if (!answer || answer.type !== 'choice') continue;
    for (const [key, value] of Object.entries(answer.probabilities ?? {})) {
      const match = /^slot_(\d+)$/.exec(key);
      if (!match) continue;
      const slot = Number(match[1]);
      if (value > (scores[slot] ?? 0)) scores[slot] = value;
    }
  }
  return scores;
}

/** 完整 6 位 team order：前 4 位为带入顺序（前两位首发），后 2 位按自然顺序补齐 */
export function fullTeamOrder(order4: number[]): number[] {
  const rest = [1, 2, 3, 4, 5, 6].filter(n => !order4.includes(n));
  return [...order4, ...rest];
}
