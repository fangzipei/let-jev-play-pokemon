import {canMegaWith, speciesTypes, type DexData} from '../dex/index.js';
import {effectiveness, estimateDamagePercent, knownEffectiveness} from './calc.js';
import {DAMAGE_CAVEAT, estimateRevealedIncoming, findOurPokemon, type AnalysisContext, type OurSpeed, type TeamThreat} from './analysis.js';
import {toId} from './protocol.js';
import {activeEntries, speciesOf, type BattleRequest, type RequestPokemon} from './request.js';
import type {BattleState, PokemonState} from './tracker.js';

export interface OpponentActive {
  ident?: string;
  label: string;
  species: string;
  types: string[];
  hpPercent: number;
  status: string | null;
  revealedMoves: string[];
}

/** 对手场上宝可梦，按参战位置排序：index 0 对应 TARGETSPEC `+1`，index 1 对应 `+2` */
export function opponentActives(dex: DexData, state: BattleState): OpponentActive[] {
  const oppSideId = state.ourSideId === 'p1' ? 'p2' : 'p1';
  const side = state.sides[oppSideId];
  if (!side) return [];
  return side.pokemon
    .filter(p => p.activePos >= 0)
    .sort((a, b) => a.activePos - b.activePos)
    .map((p, i) => ({
      ident: p.ident,
      label: `Foe ${String.fromCharCode(65 + i)}`,
      species: p.species,
      types: speciesTypes(dex, p.species),
      hpPercent: p.hpPercent,
      status: p.fainted ? 'fnt' : p.status,
      revealedMoves: p.revealedMoves,
    }));
}

function seenInBattle(p: PokemonState, state: BattleState): boolean {
  if (p.activePos >= 0 || p.fainted || p.revealedMoves.length || p.item !== undefined || p.ability !== undefined ||
      p.consumedItem || p.hpPercent !== 100 || p.status || p.volatiles.length) return true;
  return state.log.some(line => {
    const match = /^\|(switch|drag|replace)\|(p\d)[a-z]?:\s*([^|]+)\|/.exec(line);
    return match && `${match[2]}: ${match[3]}` === p.ident;
  });
}

function speedFields(speed: OurSpeed | undefined) {
  return {speed: speed?.speed ?? null, speed_notes: speed?.notes ?? ['unknown'], speed_uncertain: speed?.uncertain ?? true};
}

function speedText(speed: OurSpeed | undefined): string {
  return `estimated speed ${speed?.speed ?? 'unknown'}${speed?.uncertain ? ' (uncertain)' : ''}; ${speed?.notes.join('; ') ?? ''}`;
}

function potentialText(threat: TeamThreat | undefined): string {
  const matchups = threat?.potentialStab ?? [];
  const weaknesses = matchups.filter(m => m.multiplier !== null && m.multiplier > 1);
  const unknown = matchups.filter(m => m.multiplier === null);
  const parts = weaknesses.map(m => `${m.foeSpecies} (${m.multiplier}x)`);
  if (!matchups.length) parts.push('unknown');
  if (unknown.length) parts.push(`unknown: ${unknown.map(m => m.foeSpecies).join(', ')}`);
  if (!parts.length) parts.push('no potential STAB weakness among known foes');
  return `potential STAB type-only threats (not revealed moves; ignores abilities/items): ${parts.join(', ')}`;
}

function analysisPokemonText(analysis: AnalysisContext | undefined, ident: string, slot?: number): string[] {
  if (!analysis) return [];
  const matches = (p: {ident: string; slot: number}) => slot === undefined ? p.ident === ident : p.slot === slot;
  const notes = analysis.teamNotes.find(matches)?.notes ?? [];
  return [speedText(analysis.ourSpeeds.find(matches)), potentialText(analysis.threats.find(matches)),
    ...(analysis.level >= 2 && notes.length ? [`role: ${notes.join('; ')}`] : [])];
}

export interface SerializeInput {
  state: BattleState;
  request: BattleRequest;
  dex: DexData;
  analysis?: AnalysisContext;
}

export function buildStatePayload({state, request, dex, analysis}: SerializeInput): Record<string, unknown> {
  const ourSideId = state.ourSideId ?? request.side.id;
  const ourSideState = state.sides[ourSideId];
  const oppSideState = state.sides[ourSideId === 'p1' ? 'p2' : 'p1'];
  const active = activeEntries(request);
  const ourPokemon = (p: RequestPokemon) => {
    const slot = request.side.pokemon.indexOf(p) + 1;
    const tracked = findOurPokemon(ourSideState, p);
    const threat = analysis?.threats.find(t => t.slot === slot);
    return {
      slot, ident: p.ident, species: speciesOf(p), details: p.details, hp: p.condition,
      item: p.item ?? null, ability: p.ability ?? null, base_ability: p.baseAbility ?? null,
      moves: p.moves ?? null, stats: p.stats ?? null, types: speciesTypes(dex, speciesOf(p)),
      boosts: p.active ? tracked?.boosts ?? {} : {},
      volatiles: p.active ? tracked?.volatiles ?? [] : [], single_turn: p.active ? tracked?.singleTurn ?? [] : [],
      ...(p.active ? {move_request: request.active?.[active.indexOf(p)]?.moves ?? null} : {}),
      ...(analysis ? {...speedFields(analysis.ourSpeeds.find(s => s.slot === slot)),
        potential_stab: threat?.potentialStab ?? [], outgoing_matchups: threat?.outgoing ?? []} : {}),
    };
  };
  const ours = {
    mega_used: ourSideState?.megaUsed ?? false,
    active: active.map(ourPokemon),
    bench: request.side.pokemon.filter(p => !p.active).map(ourPokemon),
    ...(analysis ? {preview: request.side.pokemon.map(ourPokemon)} : {}),
    ...(analysis && analysis.level >= 2 ? {team_notes: analysis.teamNotes} : {}),
  };
  const opponentPokemon = (p: PokemonState) => {
    const seen = seenInBattle(p, state);
    const speed = analysis?.oppSpeedEstimates.find(s => s.ident === p.ident);
    return {
      ident: p.ident, species: p.species, active_position: p.activePos, seen_in_battle: seen,
      hp_percent: seen ? p.hpPercent : null, status: seen ? p.status : null,
      types: speciesTypes(dex, p.species), boosts: p.boosts, revealed_moves: p.revealedMoves,
      item_revealed: p.consumedItem ? null : p.item ?? null, ability_revealed: p.ability ?? null,
      item_consumed: p.consumedItem ?? false, volatiles: p.volatiles, single_turn: p.singleTurn,
      ...(analysis ? {base_speed: speed?.baseSpeed ?? null, speed: null, speed_notes: speed?.notes ?? ['unknown'],
        incoming_estimates: analysis.threats.flatMap(t => t.incoming.filter(i => i.foeIdent === p.ident).map(i => ({
          slot: t.slot, ident: t.ident, rough_percent: i.roughPercent,
          revealed_moves: i.revealedMoves, unknown_moves: i.unknownMoves,
        })))} : {}),
    };
  };
  const opponents = oppSideState?.pokemon ?? [];
  const opponent = {
    side_conditions: oppSideState?.sideConditions ?? [], brought_count: oppSideState?.teamSize ?? 4,
    seen_count: opponents.filter(p => seenInBattle(p, state)).length,
    active: opponents.filter(p => p.activePos >= 0).sort((a, b) => a.activePos - b.activePos).map(opponentPokemon),
    bench: opponents.filter(p => p.activePos < 0 && seenInBattle(p, state)).map(opponentPokemon),
    unseen_from_preview: opponents.filter(p => !seenInBattle(p, state)).map(p => ({species: p.species, types: speciesTypes(dex, p.species)})),
    ...(analysis ? {preview: opponents.map(opponentPokemon)} : {}),
  };

  return {
    format: 'gen9championsvgc2026regmc',
    rules: 'Doubles, bring 6 pick 4, one Mega Evolution per battle, Species/Item Clause',
    turn: state.turn,
    weather: state.weather ?? null,
    field: state.fieldConditions,
    our_side_conditions: ourSideState?.sideConditions ?? [],
    sides: {ours, opponent},
    recent_log: state.log.slice(-10),
    ...(analysis ? {analysis_notes: `${DAMAGE_CAVEAT}; potential STAB is type-only, not revealed moves; opponent actual speed and move order unknown`} : {}),
  };
}

export interface MoveOptionInput {
  dex: DexData;
  moveId: string;
  moveName: string;
  pp: number;
  maxpp: number;
  attackerTypes: string[];
  attackerStats?: Record<string, number>;
  target?: {label: string; species: string; hpPercent: number; ident?: string};
  analysis?: AnalysisContext;
  attackerSlot?: number;
  hitsBoth?: boolean;
  weather?: string;
}

export function describeMoveOption(input: MoveOptionInput): string {
  const move = input.dex.moves[toId(input.moveId)];
  const head = `${input.moveName} [${move?.type ?? '?'}/${move?.category ?? '?'}/${move?.basePower ?? '?'}BP/PP ${input.pp}/${input.maxpp}${
    move && move.priority ? `/priority ${move.priority}` : ''
  }]`;
  const extras: string[] = [];
  if (input.hitsBoth) extras.push('hits both foes (0.75x spread)');
  if (move && move.basePower > 0) {
    if (input.target) {
      const pct = estimateDamagePercent({
        dex: input.dex, moveId: input.moveId, attackerTypes: input.attackerTypes,
        attackerStats: input.attackerStats, defenderSpecies: input.target.species,
        isSpread: input.hitsBoth, weather: input.weather,
      });
      const eff = effectiveness(input.dex, move.type, speciesTypes(input.dex, input.target.species));
      extras.push(`vs ${input.target.label} (${input.target.species}, ${input.target.hpPercent}% HP): ≈${pct ?? '?'}% damage${eff !== 1 ? ` (${eff}x)` : ''}`);
    } else {
      extras.push('(no single direct target)');
    }
  } else if (move?.category === 'Status') {
    extras.push('(status move, no direct damage)');
  } else {
    extras.push('(damage unknown: missing move data or variable power)');
  }
  if (move && move.category !== 'Status') extras.push(`(${DAMAGE_CAVEAT})`);
  if (input.analysis) {
    extras.push(speedText(input.analysis.ourSpeeds.find(s => s.slot === input.attackerSlot)));
    const foes = input.target ? input.analysis.oppSpeedEstimates.filter(s => input.target!.ident ? s.ident === input.target!.ident : s.species === input.target!.species) : input.analysis.oppSpeedEstimates;
    for (const foe of foes) extras.push(`${foe.species} base speed ${foe.baseSpeed ?? 'unknown'}, actual speed unknown; move order unknown`);
    if (move?.priority) extras.push('priority bracket is checked before speed');
  }
  return [head, ...extras].join(' ');
}

export function describeSwitchOption(input: {
  dex: DexData;
  pokemon: RequestPokemon;
  opponentActives: OpponentActive[];
  analysis?: AnalysisContext;
  teamSlot?: number;
  forced?: boolean;
}): string {
  const species = speciesOf(input.pokemon);
  const types = speciesTypes(input.dex, species);
  const head = `${species} [${types.join('/') || '?'}, HP ${input.pokemon.condition}${
    input.pokemon.item ? `, item ${input.pokemon.item}` : ''
  }${input.pokemon.ability ? `, ability ${input.pokemon.ability}` : ''}, ${input.forced ? 'forced replacement' : 'costs your action this turn'}]`;
  const incoming = input.analysis
    ? input.analysis.threats.find(t => input.teamSlot === undefined ? t.ident === input.pokemon.ident : t.slot === input.teamSlot)?.incoming ?? []
    : input.opponentActives.map(foe => estimateRevealedIncoming({dex: input.dex, defenderSpecies: species, foe}));
  const risks = incoming.map(i => `incoming ${i.roughPercent === null ? 'unknown' : `≈${i.roughPercent}%`} from ${i.foeSpecies} (revealed moves only${i.unknownMoves.length ? `; unknown: ${i.unknownMoves.join(', ')}` : ''})`);
  return [head, ...risks, ...(risks.length ? [DAMAGE_CAVEAT] : []),
    ...analysisPokemonText(input.analysis, input.pokemon.ident, input.teamSlot)].filter(Boolean).join('; ');
}

export function describePreviewCandidate(input: {
  dex: DexData;
  pokemon: RequestPokemon;
  opponentPreviewSpecies: string[];
  megaCapable: boolean;
  analysis?: AnalysisContext;
  teamSlot?: number;
}): string {
  const species = speciesOf(input.pokemon);
  const types = speciesTypes(input.dex, species);
  const moveNames = (input.pokemon.moves ?? []).map(id => input.dex.moves[toId(id)]?.name ?? id);
  let bestName = '';
  let bestCount = 0;
  for (const id of input.pokemon.moves ?? []) {
    const mv = input.dex.moves[toId(id)];
    if (!mv || !mv.basePower) continue;
    let count = 0;
    if (input.analysis) {
      const threat = input.analysis.threats.find(t => input.teamSlot === undefined ? t.ident === input.pokemon.ident : t.slot === input.teamSlot);
      count = threat?.outgoing.filter(m => toId(m.move) === toId(id) && m.multiplier !== null && m.multiplier > 1).length ?? 0;
    } else {
      for (const foe of input.opponentPreviewSpecies) {
        const mult = knownEffectiveness(input.dex, mv.type, speciesTypes(input.dex, foe));
        if (mult !== null && mult > 1) count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestName = mv.name;
    }
  }
  const parts = [
    `${species} [${types.join('/') || '?'}]`,
    `moves: ${moveNames.join(', ') || '?'}`,
    input.megaCapable ? "can Mega Evolve (uses the team's only Mega slot)" : '',
    bestCount > 0 ? `best: ${bestName} hits ${bestCount}/${input.analysis?.previewFoes.length ?? input.opponentPreviewSpecies.length} foes super effectively (type-only)` : '',
    ...analysisPokemonText(input.analysis, input.pokemon.ident, input.teamSlot),
  ];
  return parts.filter(Boolean).join('; ');
}

export function isMegaCapable(dex: DexData, pokemon: RequestPokemon): boolean {
  const species = speciesOf(pokemon);
  return canMegaWith(dex, dex.species[toId(species)]?.baseSpecies ?? species, pokemon.item);
}
