import {canMegaWith, speciesTypes, type DexData} from '../dex/index.js';
import {effectiveness, estimateDamagePercent} from './calc.js';
import {toId} from './protocol.js';
import {activeEntries, speciesOf, type BattleRequest, type RequestPokemon} from './request.js';
import type {BattleState, SideState} from './tracker.js';

export interface OpponentActive {
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
      label: `Foe ${String.fromCharCode(65 + i)}`,
      species: p.species,
      types: speciesTypes(dex, p.species),
      hpPercent: p.hpPercent,
      status: p.fainted ? 'fnt' : p.status,
      revealedMoves: p.revealedMoves,
    }));
}

function boostsOf(side: SideState | undefined, species: string): Record<string, number> {
  const p = side?.pokemon.find(q => toId(q.species) === toId(species));
  return p?.boosts ?? {};
}

export interface SerializeInput {
  state: BattleState;
  request: BattleRequest;
  dex: DexData;
}

export function buildStatePayload({state, request, dex}: SerializeInput): Record<string, unknown> {
  const ourSideState = state.ourSideId ? state.sides[state.ourSideId] : undefined;
  const oppSideId = state.ourSideId === 'p1' ? 'p2' : 'p1';
  const oppSideState = state.ourSideId ? state.sides[oppSideId] : undefined;

  const ours = {
    mega_used: ourSideState?.megaUsed ?? false,
    active: activeEntries(request).map(p => ({
      species: speciesOf(p),
      hp: p.condition,
      item: p.item ?? null,
      ability: p.ability ?? null,
      types: speciesTypes(dex, speciesOf(p)),
      boosts: boostsOf(ourSideState, speciesOf(p)),
    })),
    bench: request.side.pokemon
      .filter(p => !p.active)
      .map(p => ({
        slot: request.side.pokemon.indexOf(p) + 1,
        species: speciesOf(p),
        hp: p.condition,
        item: p.item ?? null,
        types: speciesTypes(dex, speciesOf(p)),
      })),
  };

  const opponent = {
    side_conditions: oppSideState?.sideConditions ?? [],
    brought_count: oppSideState?.teamSize ?? 4,
    seen_count: oppSideState?.pokemon.filter(p => p.activePos >= 0 || p.fainted).length ?? 0,
    active: opponentActives(dex, state).map(a => ({
      species: a.species,
      hp_percent: a.hpPercent,
      status: a.status,
      types: a.types,
      boosts: boostsOf(oppSideState, a.species),
      revealed_moves: a.revealedMoves,
    })),
    unseen_from_preview: (oppSideState?.pokemon ?? [])
      .filter(p => p.activePos < 0 && !p.fainted && p.revealedMoves.length === 0 && p.hpPercent === 100)
      .map(p => ({species: p.species, types: speciesTypes(dex, p.species)})),
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
  target?: {label: string; species: string; hpPercent: number};
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
  } else {
    extras.push('(status move, no direct damage)');
  }
  return [head, ...extras].join(' ');
}

export function describeSwitchOption(input: {
  dex: DexData;
  pokemon: RequestPokemon;
  opponentActives: OpponentActive[];
}): string {
  const species = speciesOf(input.pokemon);
  const types = speciesTypes(input.dex, species);
  const head = `${species} [${types.join('/') || '?'}, HP ${input.pokemon.condition}${
    input.pokemon.item ? `, item ${input.pokemon.item}` : ''
  }${input.pokemon.ability ? `, ability ${input.pokemon.ability}` : ''}, costs your action this turn]`;
  const risks: string[] = [];
  for (const foe of input.opponentActives) {
    let worst = 0;
    for (const mv of foe.revealedMoves) {
      const pct = estimateDamagePercent({
        dex: input.dex, moveId: mv, attackerTypes: speciesTypes(input.dex, foe.species), defenderSpecies: species,
      });
      if (pct != null && pct > worst) worst = pct;
    }
    if (worst > 0) risks.push(`incoming ≈${worst}% from ${foe.species}`);
  }
  return [head, risks.length ? `(${risks.join('; ')})` : ''].filter(Boolean).join(' ');
}

export function describePreviewCandidate(input: {
  dex: DexData;
  pokemon: RequestPokemon;
  opponentPreviewSpecies: string[];
  megaCapable: boolean;
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
    for (const foe of input.opponentPreviewSpecies) {
      if (effectiveness(input.dex, mv.type, speciesTypes(input.dex, foe)) > 1) count++;
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
    bestCount > 0 ? `best: ${bestName} hits ${bestCount}/${input.opponentPreviewSpecies.length} foes super effectively` : '',
  ];
  return parts.filter(Boolean).join('; ');
}

export function isMegaCapable(dex: DexData, pokemon: RequestPokemon): boolean {
  return canMegaWith(dex, speciesOf(pokemon), pokemon.item);
}
