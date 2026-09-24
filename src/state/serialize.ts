import {canMegaWith, megaFormsOf, speciesTypes, type DexData} from '../dex/index.js';
import {effectiveness, entryWeatherOf, estimateDamagePercent, knownEffectiveness, weatherAdjustedType} from './calc.js';
import {DAMAGE_CAVEAT, estimateRevealedIncoming, findOurPokemon, type AnalysisContext, type OurSpeed, type TeamThreat} from './analysis.js';
import type {OpponentNoteSet} from './opponent-notes.js';
import {buildBattleContext, seenInBattle} from './battle-context.js';
import {toId} from './protocol.js';
import {activeEntries, speciesOf, type BattleRequest, type RequestPokemon} from './request.js';
import {speedControlOf, turnsPhrase, type SpeedControl} from './speed-control.js';
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
  opponentNotes?: Record<string, OpponentNoteSet> | null;
}

export function buildStatePayload({state, request, dex, analysis, opponentNotes}: SerializeInput): Record<string, unknown> {
  const battleContext = buildBattleContext({state, request});
  const ourSideId = request.side.id;
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
    const seen = seenInBattle(p);
    const speed = analysis?.oppSpeedEstimates.find(s => s.ident === p.ident);
    const noteSet = opponentNotes && analysis && analysis.level >= 2 ? opponentNotes[p.ident] : undefined;
    const notes = noteSet
      ? Object.fromEntries(Object.entries(noteSet).filter(([, lines]) => lines.length > 0))
      : {};
    return {
      ident: p.ident, species: p.species, active_position: p.activePos, seen_in_battle: seen,
      hp_percent: seen ? p.hpPercent : null, status: seen ? p.status : null,
      types: speciesTypes(dex, p.species), boosts: p.activePos >= 0 && !p.fainted ? p.boosts : {}, revealed_moves: p.revealedMoves,
      item_revealed: p.consumedItem ? null : p.item ?? null, ability_revealed: p.ability ?? null,
      item_consumed: p.consumedItem ?? false, volatiles: p.volatiles, single_turn: p.singleTurn,
      ...(analysis ? {base_speed: speed?.baseSpeed ?? null, speed: null, speed_notes: speed?.notes ?? ['unknown'],
        incoming_estimates: analysis.threats.flatMap(t => t.incoming.filter(i => i.foeIdent === p.ident).map(i => ({
          slot: t.slot, ident: t.ident, rough_percent: i.roughPercent,
          revealed_moves: i.revealedMoves, unknown_moves: i.unknownMoves,
        })))} : {}),
      ...(Object.keys(notes).length ? {notes} : {}),
    };
  };
  const opponents = oppSideState?.pokemon ?? [];
  const opponent = {
    side_conditions: oppSideState?.sideConditions ?? [],
    brought_count: battleContext.summary.opponent.brought_count.confirmed,
    seen_count: opponents.filter(p => seenInBattle(p)).length,
    active: opponents.filter(p => p.activePos >= 0).sort((a, b) => a.activePos - b.activePos).map(opponentPokemon),
    bench: opponents.filter(p => p.activePos < 0 && seenInBattle(p)).map(opponentPokemon),
    unseen_from_preview: opponents.filter(p => !seenInBattle(p)).map(p => ({species: p.species, types: speciesTypes(dex, p.species)})),
    ...(analysis ? {preview: opponents.map(opponentPokemon)} : {}),
  };

  return {
    format: 'gen9championsvgc2026regmc',
    rules: 'Doubles, bring 6 pick 4, one Mega Evolution per battle, Species/Item Clause',
    turn: state.turn,
    weather: state.weather ?? null,
    field: state.fieldConditions,
    our_side_conditions: ourSideState?.sideConditions ?? [],
    speed_control: speedControlOf(state, ourSideId),
    sides: {ours, opponent},
    battle_context: battleContext,
    // 兼容旧消费者，但不再将聊天、原始 request 等噪声旁路送入模型。
    recent_log: battleContext.recent_turns.flatMap(row => row.events).slice(-10),
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
  /** 当前场地条件（如已激活的 Trick Room），用于场地类战术注解 */
  fieldConditions?: string[];
  /** 当前控速状态（顺风/空间/天气剩余回合）；传入时启用量回合数的控速注解 */
  speedControl?: SpeedControl;
  /** 我方已阵亡数量（Last Respects 按此成长威力） */
  faintedAllies?: number;
  /** true = 本回合是该宝可梦本次上场后的首个行动回合（Fake Out 窗口、讲究锁招） */
  firstActionSinceSwitchIn?: boolean;
  /** 使用者的持道具（讲究类道具锁招注解） */
  attackerItem?: string;
  /** 对手本场是否已用掉 Mega 进化（true 时不再提示目标 Mega 免疫风险） */
  opponentMegaUsed?: boolean;
}

/** Last Respects 真实威力：50 基础 + 每名已阵亡队友 50（PS basePowerCallback） */
const LAST_RESPECTS_BASE_POWER = 50;
const CHOICE_ITEMS: Record<string, string> = {
  choicescarf: 'Choice Scarf', choiceband: 'Choice Band', choicespecs: 'Choice Specs',
};

function lastRespectsPower(input: MoveOptionInput): number | undefined {
  if (toId(input.moveId) !== 'lastrespects' || input.faintedAllies === undefined) return undefined;
  return LAST_RESPECTS_BASE_POWER + LAST_RESPECTS_BASE_POWER * input.faintedAllies;
}

/** Mega 形态特性对特定属性的免疫（属性型免疫表，用于招式警示） */
const MEGA_ABILITY_IMMUNITY: Record<string, string> = {
  levitate: 'ground', flashfire: 'fire', lightningrod: 'electric', motordrive: 'electric',
  voltabsorb: 'electric', waterabsorb: 'water', dryskin: 'water', stormdrain: 'water',
  sapsipper: 'grass', eartheater: 'ground', wellbakedbody: 'fire', windrider: 'flying',
};

/** 目标可能 Mega 后其特性免疫该招式属性时的警示；目标已是 Mega 形态时不提示。 */
function megaImmunityWarning(dex: DexData, targetSpecies: string, moveType: string): string | null {
  if (/mega[xy]?$/.test(toId(targetSpecies))) return null;
  for (const mega of megaFormsOf(dex, targetSpecies)) {
    const ability = Object.values(mega.abilities ?? {})[0];
    const immuneType = ability ? MEGA_ABILITY_IMMUNITY[toId(ability)] : undefined;
    if (!immuneType || toId(moveType) !== immuneType) continue;
    return `caution: ${targetSpecies} can Mega Evolve into ${mega.name} before any moves this turn; if it does, ${ability} makes this ${moveType}-type move deal no damage`;
  }
  return null;
}

/** move 选项级战术注解：全部由真实机制与当前对局数据驱动，不设物种白名单 */
function moveTacticNotes(input: MoveOptionInput): string[] {
  const notes: string[] = [];
  const move = input.dex.moves[toId(input.moveId)];
  if (!move) return notes;
  const moveId = toId(input.moveId);
  if (moveId === 'trickroom') {
    const tr = input.speedControl?.trick_room;
    const legacyActive = (input.fieldConditions ?? []).some(f => toId(f.replace(/^move:\s*/i, '')) === 'trickroom');
    if (tr) {
      notes.push(`Trick Room is already active with ${turnsPhrase(tr.turns_left)}: using it again cancels the current Trick Room instead of extending it`);
    } else if (legacyActive) {
      notes.push('Trick Room is already active: using it again cancels the current Trick Room instead of extending it');
    } else {
      notes.push('Trick Room lasts 5 turns; within each priority bracket the slower Pokemon moves first (speed stats themselves are unchanged); at -7 priority it resolves last this turn');
    }
  }
  if (moveId === 'tailwind' && input.speedControl) {
    const tw = input.speedControl.our_tailwind;
    notes.push(tw
      ? `Tailwind is already active on your side with ${turnsPhrase(tw.turns_left)}: using it again will fail, it does not extend or restart the current Tailwind`
      : 'Tailwind lasts 4 turns; a side can only have one Tailwind, so using it while one is already active fails');
  }
  const bp = lastRespectsPower(input);
  if (bp !== undefined) {
    notes.push(`Last Respects current power ≈${bp} BP (50 base + 50 per fainted ally; ${input.faintedAllies} fainted)`);
  }
  if (move.type === 'Water' && move.basePower > 0 && /sun/i.test(input.weather ?? '')) {
    notes.push('the current sun halves Water-type damage; the damage estimate above already reflects this reduction');
  }
  if (moveId === 'weatherball') {
    const adjusted = weatherAdjustedType(input.moveId, move.type, input.weather);
    notes.push(adjusted !== move.type
      ? `in the current weather Weather Ball is a ${adjusted}-type move with 100 BP instead of 50; the estimate above already uses that type and the current weather's modifiers`
      : 'Weather Ball changes type and doubles power only while a weather is active: Fire in sun, Water in rain, Rock in sandstorm, Ice in snow');
  }
  if (moveId === 'fakeout') {
    if (input.firstActionSinceSwitchIn === true) {
      notes.push("Fake Out works only on the user's first action since entering the field, and this is that action: it flinches one foe at +3 priority if it lands");
    } else if (input.firstActionSinceSwitchIn === false) {
      notes.push('Fake Out will fail now: this Pokemon has already spent its first action since entering the field');
    }
  }
  const choiceName = CHOICE_ITEMS[toId(input.attackerItem ?? '')];
  if (input.firstActionSinceSwitchIn === true && choiceName) {
    notes.push(`${choiceName} locks this Pokemon into the first move it uses until it switches out; this choice decides its role for this stint`);
  }
  return notes;
}

export function describeMoveOption(input: MoveOptionInput): string {
  const move = input.dex.moves[toId(input.moveId)];
  // 气象球随当前天气改属性并翻倍威力（晴 → Fire/100BP），头部与估算保持一致
  const moveType = move ? weatherAdjustedType(input.moveId, move.type, input.weather) : undefined;
  const shownPower = move && moveType !== move.type ? move.basePower * 2 : move?.basePower;
  const head = `${input.moveName} [${moveType ?? '?'}/${move?.category ?? '?'}/${shownPower ?? '?'}BP/PP ${input.pp}/${input.maxpp}${
    move && move.priority ? `/priority ${move.priority}` : ''
  }]`;
  const extras: string[] = [];
  if (input.hitsBoth) extras.push('hits both foes (0.75x spread)');
  if (move && move.basePower > 0) {
    const type = moveType ?? move.type;
    if (input.target) {
      const pct = estimateDamagePercent({
        dex: input.dex, moveId: input.moveId, attackerTypes: input.attackerTypes,
        attackerStats: input.attackerStats, defenderSpecies: input.target.species,
        isSpread: input.hitsBoth, weather: input.weather, powerOverride: lastRespectsPower(input),
      });
      const eff = effectiveness(input.dex, type, speciesTypes(input.dex, input.target.species));
      extras.push(`vs ${input.target.label} (${input.target.species}, ${input.target.hpPercent}% HP): ≈${pct ?? '?'}% damage${eff !== 1 ? ` (${eff}x)` : ''}`);
      if (input.opponentMegaUsed !== true) {
        const warning = megaImmunityWarning(input.dex, input.target.species, type);
        if (warning) extras.push(warning);
      }
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
  return [head, ...extras, ...moveTacticNotes(input)].join(' ');
}

export function describeSwitchOption(input: {
  dex: DexData;
  pokemon: RequestPokemon;
  opponentActives: OpponentActive[];
  analysis?: AnalysisContext;
  teamSlot?: number;
  forced?: boolean;
  weather?: string;
}): string {
  const species = speciesOf(input.pokemon);
  const types = speciesTypes(input.dex, species);
  const head = `${species} [${types.join('/') || '?'}, HP ${input.pokemon.condition}${
    input.pokemon.item ? `, item ${input.pokemon.item}` : ''
  }${input.pokemon.ability ? `, ability ${input.pokemon.ability}` : ''}, ${input.forced ? 'forced replacement' : 'costs your action this turn'}]`;
  const incoming = input.analysis
    ? input.analysis.threats.find(t => input.teamSlot === undefined ? t.ident === input.pokemon.ident : t.slot === input.teamSlot)?.incoming ?? []
    : input.opponentActives.map(foe => estimateRevealedIncoming({dex: input.dex, defenderSpecies: species, weather: input.weather, foe}));
  const risks = incoming.map(i => `incoming ${i.roughPercent === null ? 'unknown' : `≈${i.roughPercent}%`} from ${i.foeSpecies} (revealed moves only${i.unknownMoves.length ? `; unknown: ${i.unknownMoves.join(', ')}` : ''})`);
  return [head, ...risks, ...(risks.length ? [DAMAGE_CAVEAT] : []),
    ...analysisPokemonText(input.analysis, input.pokemon.ident, input.teamSlot)].filter(Boolean).join('; ');
}

/** 先验推断的对手预期 Mega 形态（preview 对位行用） */
export interface LikelyMegaFoe {
  species: string;
  name: string;
  types: string[];
  percent: number;
}

export function describePreviewCandidate(input: {
  dex: DexData;
  pokemon: RequestPokemon;
  opponentPreviewSpecies: string[];
  megaCapable: boolean;
  analysis?: AnalysisContext;
  teamSlot?: number;
  likelyMegaFoes?: LikelyMegaFoe[];
}): string {
  const species = speciesOf(input.pokemon);
  const types = speciesTypes(input.dex, species);
  const moveNames = (input.pokemon.moves ?? []).map(id => input.dex.moves[toId(id)]?.name ?? id);
  // 自身入场造天气（如 Drought 造晴）时，气象球按该天气属性参与预览对位
  const entryWeather = entryWeatherOf(input.pokemon);
  const effectiveType = (id: string, mv: {type: string}) => weatherAdjustedType(id, mv.type, entryWeather);
  const typeLabel = (mv: {type: string}, type: string) => type === mv.type ? mv.type : `${type} in ${entryWeather}`;
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
        const mult = knownEffectiveness(input.dex, effectiveType(id, mv), speciesTypes(input.dex, foe));
        if (mult !== null && mult > 1) count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestName = mv.name;
    }
  }
  const coverage: string[] = [];
  for (const foe of input.likelyMegaFoes ?? []) {
    const hits: Array<{name: string; label: string; multiplier: number}> = [];
    for (const id of input.pokemon.moves ?? []) {
      const mv = input.dex.moves[toId(id)];
      if (!mv || !mv.basePower) continue;
      const type = effectiveType(id, mv);
      const mult = knownEffectiveness(input.dex, type, foe.types);
      if (mult !== null && mult > 1) hits.push({name: mv.name, label: typeLabel(mv, type), multiplier: mult});
    }
    if (!hits.length) continue;
    const bestMult = Math.max(...hits.map(h => h.multiplier));
    const best = hits.filter(h => h.multiplier === bestMult).slice(0, 2);
    const desc = best.map(h => `${h.name} (${h.label})`).join(' and ');
    coverage.push(`${desc} ${best.length > 1 ? 'hit' : 'hits'} likely ${foe.name} [${foe.types.join('/')}] ${bestMult}x (${foe.percent.toFixed(1)}% Mega-stone prior, type-only)`);
  }
  const parts = [
    `${species} [${types.join('/') || '?'}]`,
    `moves: ${moveNames.join(', ') || '?'}`,
    input.megaCapable ? "can Mega Evolve (uses the team's only Mega slot)" : '',
    bestCount > 0 ? `best: ${bestName} hits ${bestCount}/${input.analysis?.previewFoes.length ?? input.opponentPreviewSpecies.length} foes super effectively (type-only)` : '',
    ...(coverage.length ? [`likely-form coverage: ${coverage.slice(0, 2).join('; ')}`] : []),
    ...analysisPokemonText(input.analysis, input.pokemon.ident, input.teamSlot),
  ];
  return parts.filter(Boolean).join('; ');
}

export function isMegaCapable(dex: DexData, pokemon: RequestPokemon): boolean {
  const species = speciesOf(pokemon);
  return canMegaWith(dex, dex.species[toId(species)]?.baseSpecies ?? species, pokemon.item);
}
