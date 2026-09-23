import type {DexData} from '../dex/index.js';
import {activeEntries, speciesOf, type BattleRequest, type RequestPokemon} from './request.js';
import type {BattleState, PokemonState, SideState} from './tracker.js';
import {estimateDamagePercent, knownEffectiveness} from './calc.js';
import {toId} from './protocol.js';

export interface OurSpeed {
  slot: number;
  ident: string;
  species: string;
  requestSpeed: number | null;
  speed: number | null;
  notes: string[];
  uncertain: boolean;
}

export interface OppSpeedEstimate {
  ident: string;
  species: string;
  baseSpeed: number | null;
  speed: null;
  notes: string[];
}

export interface PreviewFoe {
  ident: string;
  species: string;
  types: string[];
  baseSpeed: number | null;
  itemRevealed: string | null;
  abilityRevealed: string | null;
}

export interface IncomingEstimate {
  foeIdent: string;
  foeSpecies: string;
  revealedMoves: string[];
  roughPercent: number | null;
  unknownMoves: string[];
}

export interface TeamThreat {
  slot: number;
  ident: string;
  outgoing: Array<{foeIdent: string; foeSpecies: string; move: string; type: string | null; multiplier: number | null}>;
  potentialStab: Array<{foeIdent: string; foeSpecies: string; types: string[]; multiplier: number | null}>;
  incoming: IncomingEstimate[];
}

export interface TeamNote {
  slot: number;
  ident: string;
  species: string;
  notes: string[];
}

export interface AnalysisContext {
  level: 1 | 2 | 3;
  ourSpeeds: OurSpeed[];
  oppSpeedEstimates: OppSpeedEstimate[];
  previewFoes: PreviewFoe[];
  threats: TeamThreat[];
  teamNotes: TeamNote[];
}

export interface AnalysisInput {
  dex: DexData;
  state: BattleState;
  request: BattleRequest;
  level: 1 | 2 | 3;
}

export const DAMAGE_CAVEAT = 'rough comparison only, not a calibrated actual HP% prediction; ignores real defensive stats, boosts, items, abilities and other battle modifiers';

/** ident 包含昵称；不以物种匹配，避免同种个体和 Mega 形态之间错配。 */
export function findOurPokemon(side: SideState | undefined, pokemon: RequestPokemon): PokemonState | undefined {
  const key = (ident: string) => ident.replace(/^(p\d)[a-z]?:\s*/, '$1: ').trim();
  return side?.pokemon.find(p => key(p.ident) === key(pokemon.ident));
}

function positiveNumber(value: number | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function hasCondition(values: string[], id: string): boolean {
  return values.some(v => toId(v.replace(/^move:\s*/i, '')) === id);
}

function weatherSuppressed(input: AnalysisInput): boolean {
  const abilities = [
    ...activeEntries(input.request).map(p => p.ability),
    ...Object.values(input.state.sides).flatMap(s => s.pokemon.filter(p => p.activePos >= 0 && !p.fainted).map(p => p.ability)),
  ];
  return abilities.some(a => ['cloudnine', 'airlock'].includes(toId(a ?? '')));
}

function ourSpeed(input: AnalysisInput, pokemon: RequestPokemon, slot: number): OurSpeed {
  const side = input.state.sides[input.state.ourSideId ?? input.request.side.id];
  const trackedPokemon = findOurPokemon(side, pokemon);
  const tracked = pokemon.active ? trackedPokemon : undefined;
  const requestSpeed = positiveNumber(pokemon.stats?.spe);
  const notes: string[] = ['request stat before battle modifiers; current conditions only'];
  let uncertain = requestSpeed === null;
  const stage = Math.max(-6, Math.min(6, tracked?.boosts.spe ?? 0));
  let speed = requestSpeed === null ? null : Math.floor(requestSpeed * (stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage)));
  if (stage) notes.push(`speed boost ${stage > 0 ? '+' : ''}${stage}`);
  const ability = toId(pokemon.ability ?? (!trackedPokemon?.mega ? pokemon.baseAbility : undefined) ?? '');
  const item = toId(pokemon.item ?? '');
  let modifier = 1;
  if (item === 'choicescarf') {
    modifier *= 1.5;
    notes.push('Choice Scarf x1.5');
  }
  if (ability === 'sandrush') {
    if (toId(input.state.weather ?? '') === 'sandstorm' && !weatherSuppressed(input)) {
      modifier *= 2;
      notes.push('Sand Rush x2 in current sandstorm');
    } else notes.push('Sand Rush inactive without effective sandstorm');
  }
  if (hasCondition(side?.sideConditions ?? [], 'tailwind')) {
    modifier *= 2;
    notes.push('Tailwind x2');
  }
  // PS 的修正链在能力阶级之后合并；正好半点向下舍入，麻痹最后向下取整。
  if (speed !== null) speed = Math.floor(speed * modifier + 0.5 - 1 / 4096);
  if (/\bpar\b/.test(pokemon.condition)) {
    if (ability !== 'quickfeet') {
      if (speed !== null) speed = Math.floor(speed * 0.5);
      notes.push('paralysis x0.5');
    }
  }
  const unsupportedAbilities = new Set(['chlorophyll', 'swiftswim', 'slushrush', 'surgesurfer', 'unburden', 'quickfeet', 'slowstart', 'protosynthesis', 'quarkdrive', 'speedboost', 'klutz']);
  const unsupportedItems = /^(ironball|machobrace|power(anklet|band|belt|bracer|lens|weight)|quickpowder|laggingtail|fullincense|quickclaw|custapberry)$/;
  if (unsupportedAbilities.has(ability) || unsupportedItems.test(item) || tracked?.volatiles.length ||
      hasCondition(input.state.fieldConditions, 'magicroom') || hasCondition(side?.sideConditions ?? [], 'swamp') ||
      pokemon.ability === undefined || pokemon.item === undefined) {
    uncertain = true;
    notes.push('uncertain: unmodeled ability, item, volatile or field modifier; only supported factors applied');
  }
  if (hasCondition(input.state.fieldConditions, 'trickroom')) notes.push('Trick Room reverses speed order within each priority bracket, not the speed stat');
  if (!pokemon.active) notes.push('bench estimate before entry effects; future weather and boosts may differ');
  return {slot, ident: pokemon.ident, species: speciesOf(pokemon), requestSpeed, speed: speed === null ? null : Math.max(1, speed), notes, uncertain};
}

/** 已揭示招式的来袭粗估集中在此，渲染层不再维护第二套计算。 */
export function estimateRevealedIncoming(input: {
  dex: DexData;
  defenderSpecies: string;
  foe: {ident?: string; species: string; revealedMoves: string[]};
}): IncomingEstimate {
  const {dex, foe, defenderSpecies} = input;
  const attacker = dex.species[toId(foe.species)];
  let roughPercent: number | null = null;
  const unknownMoves: string[] = [];
  for (const id of foe.revealedMoves) {
    const move = dex.moves[toId(id)];
    if (!move) { unknownMoves.push(id); continue; }
    if (move.category === 'Status') continue;
    const pct = attacker ? estimateDamagePercent({dex, moveId: id, attackerTypes: attacker.types, defenderSpecies}) : null;
    if (pct === null) unknownMoves.push(id);
    else roughPercent = Math.max(roughPercent ?? 0, pct);
  }
  return {foeIdent: foe.ident ?? '', foeSpecies: foe.species, revealedMoves: [...foe.revealedMoves], roughPercent, unknownMoves};
}

function teamNote(input: AnalysisInput, pokemon: RequestPokemon, slot: number): TeamNote {
  const species = speciesOf(pokemon);
  const info = input.dex.species[toId(species)];
  const base = toId(info?.baseSpecies ?? species).replace(/mega[xy]?$/, '');
  const notes: string[] = [];
  const result = {slot, ident: pokemon.ident, species, notes};
  // 数据驱动：不设物种白名单，注解完全由当前 request 的实际招式/道具/特性/队友条件生成
  if (!info) return result;
  const moves = new Set((pokemon.moves ?? []).map(toId));
  const item = toId(pokemon.item ?? '');
  const side = input.state.sides[input.state.ourSideId ?? input.request.side.id];
  const tracked = findOurPokemon(side, pokemon);
  const alreadyMega = tracked?.mega === true;
  const ability = toId(pokemon.ability ?? tracked?.ability ?? (!alreadyMega ? pokemon.baseAbility : undefined) ?? '');
  const mega = Object.values(input.dex.species).find(s =>
    toId(s.baseSpecies ?? '') === base && !!s.requiredItem && toId(s.requiredItem) === item);
  const canMega = !!mega && !alreadyMega && !side?.megaUsed;
  const hasTeammate = (test: (p: RequestPokemon) => boolean) => input.request.side.pokemon.some(p => p !== pokemon && !/fnt/.test(p.condition) && test(p));
  if (alreadyMega) notes.push('already Mega Evolved; use the current revealed ability and request stats, not the pre-Mega configuration');
  else if (canMega) notes.push(`Mega option with ${mega!.requiredItem}: ${mega!.name}; consumes the team's one Mega slot; current speed estimate is not a post-Mega stat prediction`);
  else if (mega && side?.megaUsed) notes.push('Mega unavailable: the team has already used its Mega Evolution');
  if (ability === 'emergencyexit') notes.push('Emergency Exit (before Mega if evolving) may force a switch when damage crosses half HP; do not assume the post-Mega ability is the same');
  if (moves.has('suckerpunch')) notes.push('Sucker Punch has priority but works only if the target selects a damaging move and has not acted; it is not guaranteed speed control');
  if (ability === 'sandstream') {
    const sandRushTeammate = hasTeammate(p => toId(p.ability ?? p.baseAbility ?? '') === 'sandrush');
    notes.push('Sand Stream sets temporary sandstorm on entry; the weather is contested: it expires and a foe can replace or suppress it');
    notes.push(sandRushTeammate
      ? "Re-entering with this Pokemon re-sets sandstorm and can overwrite a foe's weather; while the sand is up the Sand Rush teammate keeps its double speed, so losing the weather hands the foe a speed swing"
      : "Re-entering with this Pokemon re-sets sandstorm and can overwrite a foe's weather");
  }
  if (item === 'choicescarf') notes.push('Choice Scarf increases speed x1.5 with a move lock; opponent actual speeds remain unknown');
  if (moves.has('trick')) {
    notes.push(item === 'choicescarf'
      ? 'Trick can pass this Choice Scarf to an opponent: the target is locked into one move for the speed boost and the held items swap'
      : 'Trick swaps held items with the target; when a Choice item changes hands, its single-move lock goes with it');
  }
  if (moves.has('trickroom')) notes.push('Trick Room can support slower teammates by reversing speed order within each priority bracket; faster teammates may be disadvantaged');
  if (moves.has('heatwave')) notes.push('Heat Wave targets both foes with spread reduction when hitting multiple targets');
  if (ability === 'flashfire') notes.push('Flash Fire can absorb Fire attacks unless the ability is bypassed or suppressed');
  if (ability === 'sandrush') notes.push('Sand Rush doubles speed only in effective sandstorm; do not assume weather or a favorable speed matchup');
  if (item === 'focussash') {
    const hp = /^(\d+)\/(\d+)/.exec(pokemon.condition);
    const full = hp && Number(hp[1]) > 0 && hp[1] === hp[2];
    notes.push(full ? 'Focus Sash may save one otherwise lethal hit at full HP; chip damage and multi-hit attacks can defeat it' : 'Focus Sash is not at full HP or HP is unknown; do not rely on it for survival');
  }
  if (moves.has('highhorsepower')) notes.push('High Horsepower is single-target Ground coverage, not a spread move');
  if (ability === 'intimidate') notes.push(`Intimidate ${canMega ? '(before Mega) ' : ''}can lower opposing Attack on entry, subject to immunities and ability interactions`);
  if (moves.has('hypervoice')) {
    const futureAerilate = canMega && Object.values(mega?.abilities ?? {}).some(a => toId(a) === 'aerilate');
    if (ability === 'aerilate') notes.push('The current Aerilate can turn Hyper Voice into Flying spread damage unless suppressed or bypassed');
    else notes.push(futureAerilate ? `With ${mega!.requiredItem}, post-Mega Aerilate can turn Hyper Voice into Flying spread damage; this is conditional, not the current ability` : 'Hyper Voice provides spread damage using the current form and ability');
  }
  if (ability === 'levitate') notes.push('Levitate can grant Ground immunity unless grounded, bypassed or suppressed; type-only matchups do not include this');
  if (moves.has('voltswitch')) notes.push('Volt Switch can pivot after a successful hit; Ground immunity or blocked switching can prevent that plan');
  if (moves.has('electroweb')) {
    notes.push('Electroweb can lower opposing speed when it hits');
    if (hasTeammate(p => (p.moves ?? []).some(m => toId(m) === 'trickroom')) || hasCondition(input.state.fieldConditions, 'trickroom')) {
      notes.push('Electroweb with Trick Room can be counterproductive: making foes slower can help them act earlier within the same priority bracket');
    }
  }
  if (ability === 'psychicsurge') {
    notes.push('Psychic Surge sets Psychic Terrain on entry: Psychic moves are boosted for grounded Pokemon and priority moves are blocked against grounded targets');
    const hasExpandingForce = moves.has('expandingforce') || hasTeammate(p => (p.moves ?? []).some(m => toId(m) === 'expandingforce'));
    notes.push("The terrain is contested: it expires and a foe can replace it with another terrain; re-entering with this Pokemon re-sets Psychic Terrain and can overwrite a foe's terrain" + (hasExpandingForce ? ", restoring the Expanding Force spread bonus" : ''));
  }
  if (moves.has('expandingforce')) {
    const surgeNearby = ability === 'psychicsurge'
      || hasTeammate(p => toId(p.ability ?? p.baseAbility ?? '') === 'psychicsurge');
    notes.push(surgeNearby
      ? 'With the team Psychic Surge setting Psychic Terrain, Expanding Force becomes a spread move with a power bonus while the terrain remains active; without terrain it is a single-target move'
      : 'Expanding Force becomes a spread move with a power bonus only while Psychic Terrain is active; it is single-target otherwise');
  }
  if (ability === 'unburden') {
    notes.push('Unburden doubles speed only after the held item is consumed; speed estimates assume the item is still held until then');
  }
  if (ability === 'competitive') {
    notes.push('Competitive raises Special Attack by 2 stages when an opponent lowers any of its stats; stat-lowering moves against it can backfire');
  }
  // Reg M-C 高频战术条件注解：全部由当前 request 的招式/道具/特性/队友条件真实驱动，无条件不生成
  const hasPriorityMove = (pokemon.moves ?? []).some(id => (input.dex.moves[toId(id)]?.priority ?? 0) > 0);
  if (moves.has('fakeout')) notes.push("Fake Out only works on the user's first turn on the field: it flinches one foe at priority +3, and the window is gone once this Pokemon has already acted or switched");
  if (hasPriorityMove || moves.has('quickguard')) notes.push('Quick Guard blocks priority moves aimed at a side for one turn, including priority flinch attacks; moves with priority 0 are unaffected, and Psychic Terrain blocks priority against grounded targets');
  const hasSingleTargetMove = (pokemon.moves ?? []).some(id => {
    const target = input.dex.moves[toId(id)]?.target;
    return target === 'normal' || target === 'any';
  });
  if (hasSingleTargetMove || moves.has('followme') || moves.has('ragepowder')) notes.push('Follow Me and Rage Powder can redirect single-target attacks onto the user; spread moves ignore redirection and Grass-type Pokemon are immune to powder moves');
  const hasSpreadMove = (pokemon.moves ?? []).some(id => {
    const target = input.dex.moves[toId(id)]?.target;
    return target === 'allAdjacentFoes' || target === 'allAdjacent';
  });
  if (hasSpreadMove || moves.has('wideguard')) notes.push('Wide Guard blocks spread moves against a side for one turn; single-target moves pass through, so keep a single-target option available');
  if (hasTeammate(p => (p.moves ?? []).some(m => toId(m) === 'helpinghand'))) notes.push("A teammate has Helping Hand: this Pokemon's next damage can be boosted x1.5 that turn, at the cost of the teammate's action");
  if (moves.has('coaching')) notes.push("This Pokemon has Coaching: it can raise a teammate's Attack and Defense by one stage each at the cost of its own action");
  else if (hasTeammate(p => (p.moves ?? []).some(m => toId(m) === 'coaching'))) notes.push("A teammate has Coaching: it raises this Pokemon's Attack and Defense by one stage each, arriving after the teammate spends its action");
  if (moves.has('tailwind')) notes.push("Tailwind doubles this side's speed for four turns; it changes the speed order within each priority bracket and its effect ends on a known turn");
  if (moves.has('partingshot')) notes.push('Parting Shot lowers the target Attack and Special Attack by one stage each and then switches the user out; it fails against substitutes and abilities that block stat drops');
  if (moves.has('uturn') || moves.has('flipturn')) notes.push('This Pokemon can pivot out with a damaging move after the hit resolves; pivoting forfeits its remaining presence this turn while bringing in a teammate');
  if (moves.has('knockoff')) notes.push("Knock Off removes the target's held item while dealing damage; it reveals the item, and item-dependent foes lose their boosts, but Mega Stones cannot be removed");
  if (moves.has('perishsong')) notes.push('Perish Song sets a three-turn countdown on all active Pokemon; it forces switches and demands an exit plan before the counter reaches zero');
  if (moves.has('yawn')) notes.push('Yawn puts the target to sleep at the end of its next turn unless it switches out; it is a slow-tempo tool that a switch can answer');
  if (moves.has('auroraveil') || toId(input.state.weather ?? '') === 'snow') notes.push('Aurora Veil halves damage from attacks for five turns while snow is active; it fails without snow and does not reduce indirect damage');
  if (input.state.weather || moves.has('weatherball')) notes.push('Weather boosts matching damage types and changes Weather Ball type and power; the weather is contested and expires, so do not assume it stays');
  const seedItems = ['grassyseed', 'psychicseed', 'mistyseed', 'electricseed'];
  if (seedItems.includes(item) && ability === 'unburden') notes.push('A terrain seed is consumed on terrain entry to raise one stat; with Unburden the consumption also doubles speed, so timing the consumption matters');
  else if (hasTeammate(p => seedItems.includes(toId(p.item ?? '')) && toId(p.ability ?? p.baseAbility ?? '') === 'unburden')) notes.push('A teammate pairs a terrain seed with Unburden: that teammate doubles its speed once the seed is consumed');
  return result;
}

/** 请求级纯分析：一次构建后同时交给 payload 和全部问题构造器。 */
export function buildAnalysisContext(input: AnalysisInput): AnalysisContext {
  const {dex, request, state, level} = input;
  const ourSide = state.ourSideId ?? request.side.id;
  const foes = state.sides[ourSide === 'p1' ? 'p2' : 'p1']?.pokemon ?? [];
  const previewFoes: PreviewFoe[] = foes.map(p => ({
    ident: p.ident, species: p.species, types: [...(dex.species[toId(p.species)]?.types ?? [])],
    baseSpeed: positiveNumber(dex.species[toId(p.species)]?.baseStats.spe),
    itemRevealed: p.consumedItem ? null : p.item ?? null, abilityRevealed: p.ability ?? null,
  }));
  const oppSpeedEstimates: OppSpeedEstimate[] = previewFoes.map(p => ({
    ident: p.ident, species: p.species, baseSpeed: p.baseSpeed, speed: null,
    notes: ['base speed is not actual speed; EVs, nature and unrevealed modifiers unknown; move order unknown',
      ...(p.itemRevealed ? [`revealed item: ${p.itemRevealed}; do not multiply base speed into an actual stat`] : []),
      ...(p.abilityRevealed ? [`revealed ability: ${p.abilityRevealed}`] : [])],
  }));
  const threats: TeamThreat[] = request.side.pokemon.map((p, index) => {
    const species = speciesOf(p);
    const ourTypes = dex.species[toId(species)]?.types ?? [];
    const outgoing = previewFoes.flatMap(foe => (p.moves ?? []).flatMap(id => {
      const move = dex.moves[toId(id)];
      if (move?.category === 'Status') return [];
      return [{foeIdent: foe.ident, foeSpecies: foe.species, move: move?.name ?? id, type: move?.type ?? null,
        multiplier: move ? knownEffectiveness(dex, move.type, foe.types) : null}];
    }));
    const potentialStab = previewFoes.map(foe => {
      const values = foe.types.map(t => knownEffectiveness(dex, t, ourTypes));
      return {foeIdent: foe.ident, foeSpecies: foe.species, types: [...foe.types],
        multiplier: !values.length || values.some(v => v === null) ? null : Math.max(...values as number[])};
    });
    const incoming = foes.filter(foe => foe.activePos >= 0 && !foe.fainted && foe.hpPercent > 0)
      .map(foe => estimateRevealedIncoming({dex, defenderSpecies: species, foe}));
    return {slot: index + 1, ident: p.ident, outgoing, potentialStab, incoming};
  });
  return {
    level, ourSpeeds: request.side.pokemon.map((p, i) => ourSpeed(input, p, i + 1)),
    oppSpeedEstimates, previewFoes, threats,
    teamNotes: level >= 2 ? request.side.pokemon.map((p, i) => teamNote(input, p, i + 1)) : [],
  };
}
