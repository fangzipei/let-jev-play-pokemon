import {canMegaWith, megaFormsOf, speciesTypes, type DexData} from '../dex/index.js';
import {effectiveness, entryWeatherOf, estimateDamagePercent, hpScaledBasePower, knownEffectiveness, neutralSpeedTier, weatherAdjustedType} from './calc.js';
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
  /** 已揭示特性（来袭伤害估算中的 Adaptability 等修正） */
  ability?: string | null;
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
      ability: p.ability ?? null,
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
  /** 攻击方当前特性（Adaptability 等本系加成修正） */
  attackerAbility?: string;
  target?: {label: string; species: string; hpPercent: number; ident?: string};
  /** 群攻招式的每个目标：为每个对手各出一条伤害估算（单目标招式沿用 target） */
  targets?: Array<{label: string; species: string; hpPercent: number; ident?: string}>;
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
  /** 使用者当前 HP%（喷火/喷水/龙之能量按出手时血量缩放威力；缺省时不输出相关注解） */
  attackerHpPercent?: number;
  /** true = 本回合是该宝可梦本次上场后的首个行动回合（Fake Out 窗口、讲究锁招） */
  firstActionSinceSwitchIn?: boolean;
  /** 使用者的持道具（讲究类道具锁招注解） */
  attackerItem?: string;
  /** 对手本场是否已用掉 Mega 进化（true 时不再提示目标 Mega 免疫风险） */
  opponentMegaUsed?: boolean;
  /** 使用者主攻属性与当前阶级：主攻被降且本招类别匹配时，提醒伤害估算未包含能力阶级 */
  attackerMainAttack?: {stat: 'spa' | 'atk'; stage: number};
  /** 我方未倒下成员（含替补）的速度估计与在场标记：供 Trick Room 收益注解统计慢速成员 */
  ourLiveSpeeds?: Array<{species: string; speed: number; active: boolean}>;
}

/** Last Respects 真实威力：50 基础 + 每名已阵亡队友 50（PS basePowerCallback） */
const LAST_RESPECTS_BASE_POWER = 50;
/** 保护/拖延类招式（PS stallingMove，与 Endure 共用 stall 计数）：连续使用第二次成功率约 1/3、第三次约 1/9 */
export const PROTECT_LIKE_MOVES = new Set(['protect', 'detect', 'endure', 'spikyshield', 'banefulbunker', 'kingsshield', 'silktrap', 'burningbulwark', 'obstruct']);
const CHOICE_ITEMS: Record<string, string> = {
  choicescarf: 'Choice Scarf', choiceband: 'Choice Band', choicespecs: 'Choice Specs',
};

function lastRespectsPower(input: MoveOptionInput): number | undefined {
  if (toId(input.moveId) !== 'lastrespects' || input.faintedAllies === undefined) return undefined;
  return LAST_RESPECTS_BASE_POWER + LAST_RESPECTS_BASE_POWER * input.faintedAllies;
}

/** 喷火/喷水/龙之能量按出手时血量缩放威力（无 HP 数据或非该类招式时 undefined） */
function hpScaledPower(input: MoveOptionInput): number | undefined {
  if (input.attackerHpPercent === undefined) return undefined;
  return hpScaledBasePower(input.dex, input.moveId, input.attackerHpPercent) ?? undefined;
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
      const outlook = trickRoomOutlook(input);
      if (outlook) notes.push(outlook);
      if (input.speedControl?.opponent_tailwind) {
        notes.push("the foe's Tailwind is active: Trick Room inverts the acting order within each priority bracket, so their doubled Speed would work against them while it lasts; your own faster members would also move later under it");
      }
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
  // 喷火类：真实威力随当前 HP 缩放，并对照速度推断出手时会被削掉多少血
  const attackerHp = input.attackerHpPercent;
  const scaledPower = attackerHp === undefined ? null : hpScaledBasePower(input.dex, moveId, attackerHp);
  if (attackerHp !== undefined && scaledPower !== null) {
    notes.push(`${input.moveName}'s power scales with your HP when it resolves: ≈${scaledPower} BP at your current ${attackerHp}% HP, about ${Math.round(move.basePower / 10)} BP per 10% HP lost`);
    const ownSpeed = input.analysis?.ourSpeeds.find(s => s.slot === input.attackerSlot)?.speed ?? null;
    if (ownSpeed !== null) {
      const targets = input.targets?.length ? input.targets : input.target ? [input.target] : [];
      const foes = (targets.length
        ? input.analysis?.oppSpeedEstimates.filter(s => targets.some(t => t.ident ? s.ident === t.ident : s.species === t.species))
        : input.analysis?.oppSpeedEstimates) ?? [];
      const trickRoom = input.speedControl?.trick_room != null;
      for (const foe of foes) {
        if (foe.baseSpeed == null) continue;
        const neutral = neutralSpeedTier(foe.baseSpeed);
        if (trickRoom) {
          notes.push(ownSpeed < neutral
            ? `under the active Trick Room your estimated speed ${ownSpeed} acts before ${foe.species} (neutral full-investment ${neutral})`
            : `under the active Trick Room the slower side moves first: ${foe.species} (neutral full-investment ${neutral}) would likely act before your estimated speed ${ownSpeed}`);
          continue;
        }
        if (ownSpeed >= neutral) continue;
        const rough = input.analysis?.threats.find(t => t.slot === input.attackerSlot)?.incoming
          .find(i => i.foeIdent === foe.ident)?.roughPercent ?? null;
        const prefix = `${foe.species} (neutral full-investment ${neutral}) outruns your estimated speed ${ownSpeed}`;
        if (rough === null) {
          notes.push(`${prefix}: if it damages you first, this move resolves weaker`);
        } else if (rough >= attackerHp) {
          notes.push(`${prefix}: a first hit for ≈${rough}% (revealed moves only) would KO you before this resolves`);
        } else {
          const hpAfter = attackerHp - rough;
          const bpAfter = hpScaledBasePower(input.dex, moveId, hpAfter) ?? scaledPower;
          notes.push(`${prefix}: if it hits you first for ≈${rough}% (revealed moves only), this resolves at ≈${hpAfter}% HP and ≈${bpAfter} BP`);
        }
      }
    }
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

/**
 * Trick Room 收益事实：我方未倒下成员中速度低于在场对手中性满速档位的（他们在空间下会先出手）。
 * 数据不足（无 analysis、无在场对手或速度未知）时不生成，不猜测。
 */
function trickRoomOutlook(input: MoveOptionInput): string | null {
  const analysis = input.analysis;
  if (!analysis || input.attackerSlot === undefined) return null;
  const liveFoes = analysis.threats.find(t => t.slot === input.attackerSlot)?.incoming ?? [];
  const foes = liveFoes.flatMap(foe => {
    const base = analysis.oppSpeedEstimates.find(s => s.ident === foe.foeIdent)?.baseSpeed;
    return base == null ? [] : [{species: foe.foeSpecies, tier: neutralSpeedTier(base)}];
  });
  if (!foes.length) return null;
  const slower = (input.ourLiveSpeeds ?? [])
    .filter(s => foes.every(f => s.speed < f.tier))
    .sort((a, b) => a.speed - b.speed);
  if (!slower.length) return null;
  const members = slower.map(s => `${s.species} (estimated speed ${s.speed}, ${s.active ? 'on the field' : 'on the bench'})`).join(', ');
  const benchmark = foes.length === 1
    ? `foe ${foes[0].species}'s neutral full-investment tier (${foes[0].tier})`
    : `both foes' neutral full-investment tiers (${foes.map(f => `${f.species} ${f.tier}`).join(', ')})`;
  const subject = slower.length === 1 ? 'it' : 'they';
  return `under Trick Room your slower Pokemon act first: ${members} ${slower.length === 1 ? 'is' : 'are'} below ${benchmark}, so ${subject} would move before ${foes.length === 1 ? 'the remaining foe' : 'the foes'} while it lasts`;
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
  // 空数组视为未提供：回退到 target 而不是吞掉目标；群攻减益只在实际命中多于一个目标时生效（sim battle-actions trySpreadMoveHit）
  const targets = input.targets?.length ? input.targets : input.target ? [input.target] : [];
  const spreadPenalty = input.hitsBoth === true && targets.length > 1;
  if (input.hitsBoth) extras.push(spreadPenalty
    ? 'hits both foes (0.75x spread)'
    : 'hits the remaining foe at full power: the spread reduction applies only when a move hits more than one target');
  if (move && move.basePower > 0) {
    const type = moveType ?? move.type;
    if (targets.length) {
      for (const target of targets) {
        const pct = estimateDamagePercent({
          dex: input.dex, moveId: input.moveId, attackerTypes: input.attackerTypes,
          attackerStats: input.attackerStats, attackerAbility: input.attackerAbility,
          defenderSpecies: target.species,
          isSpread: spreadPenalty, weather: input.weather, powerOverride: lastRespectsPower(input) ?? hpScaledPower(input),
        });
        const eff = effectiveness(input.dex, type, speciesTypes(input.dex, target.species));
        extras.push(`vs ${target.label} (${target.species}, ${target.hpPercent}% HP): ≈${pct ?? '?'}% damage${eff !== 1 ? ` (${eff}x)` : ''}`);
        if (input.opponentMegaUsed !== true) {
          const warning = megaImmunityWarning(input.dex, target.species, type);
          if (warning) extras.push(warning);
        }
      }
    } else {
      extras.push('(no single direct target)');
    }
  } else if (move?.category === 'Status') {
    extras.push('(status move, no direct damage)');
  } else {
    extras.push('(damage unknown: missing move data or variable power)');
  }
  const main = input.attackerMainAttack;
  // 主攻属性被降时伤害估算不含阶级会高估；仅对与该属性匹配的伤害招明确提醒
  if (move && move.basePower > 0 && main && main.stage <= -1
    && (main.stat === 'spa' ? move.category === 'Special' : move.category === 'Physical')) {
    const label = main.stat === 'spa' ? 'Special Attack' : 'Attack';
    extras.push(`(the attacker's ${label} is at ${main.stage} (about ${Math.round(200 / (2 - main.stage))}% of its usual output); this estimate does not include stat stages, so actual damage is lower)`);
  }
  if (move && move.category !== 'Status') extras.push(`(${DAMAGE_CAVEAT})`);
  if (input.analysis) {
    extras.push(speedText(input.analysis.ourSpeeds.find(s => s.slot === input.attackerSlot)));
    const foes = targets.length
      ? input.analysis.oppSpeedEstimates.filter(s => targets.some(t => t.ident ? s.ident === t.ident : s.species === t.species))
      : input.analysis.oppSpeedEstimates;
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
  /** 当前槽位在场者的状态：换出收益注解（自愿换人时传入；强制换人时无意义） */
  outgoing?: {species: string; yawning?: boolean; hpPercent?: number; boosts?: Record<string, number>;
    /** 主攻属性与当前阶级：主攻被降时给"优先考虑换人"强化行（通用阶级行不再重复该项） */
    mainAttack?: {stat: 'spa' | 'atk'; stage: number}};
}): string {
  const species = speciesOf(input.pokemon);
  const types = speciesTypes(input.dex, species);
  const head = `${species} [${types.join('/') || '?'}, HP ${input.pokemon.condition}${
    input.pokemon.item ? `, item ${input.pokemon.item}` : ''
  }${input.pokemon.ability ? `, ability ${input.pokemon.ability}` : ''}, ${input.forced ? 'forced replacement' : 'costs your action this turn'}]`;
  const outgoingNotes: string[] = [];
  if (input.outgoing) {
    const o = input.outgoing;
    if (o.yawning) outgoingNotes.push(`switching this slot out removes Yawn from ${o.species} before it falls asleep`);
    if (o.hpPercent !== undefined && o.hpPercent <= 33) outgoingNotes.push(`${o.species} is at ${o.hpPercent}% HP: switching preserves it`);
    const mainWeakened = o.mainAttack !== undefined && o.mainAttack.stage <= -1;
    const drops = Object.entries(o.boosts ?? {})
      .filter(([stat, v]) => v < 0 && !(mainWeakened && stat === o.mainAttack?.stat))
      .map(([stat, v]) => `${stat} ${v}`);
    if (drops.length) outgoingNotes.push(`switching out clears ${o.species}'s lowered stats (${drops.join(', ')})`);
    // 输出手主攻属性被降：继续输出会大打折扣，换出清除收益单独强化（可以优先考虑换人）
    if (mainWeakened && o.mainAttack) {
      const label = o.mainAttack.stat === 'spa' ? 'Special Attack' : 'Attack';
      const role = o.mainAttack.stat === 'spa' ? 'special' : 'physical';
      outgoingNotes.push(`this Pokemon is your main ${role} attacker and its ${label} is at ${o.mainAttack.stage} (about ${Math.round(200 / (2 - o.mainAttack.stage))}% of its usual damage output); switching out clears it, so consider switching out first`);
    }
  }
  const incoming = input.analysis
    ? input.analysis.threats.find(t => input.teamSlot === undefined ? t.ident === input.pokemon.ident : t.slot === input.teamSlot)?.incoming ?? []
    : input.opponentActives.map(foe => estimateRevealedIncoming({dex: input.dex, defenderSpecies: species, weather: input.weather, foe}));
  const risks = incoming.map(i => `incoming ${i.roughPercent === null ? 'unknown' : `≈${i.roughPercent}%`} from ${i.foeSpecies} (revealed moves only${i.unknownMoves.length ? `; unknown: ${i.unknownMoves.join(', ')}` : ''})`);
  // 手动换人必须提醒代价：换入者本回合不能行动，会先吃打向该槽位的攻击（可能少血甚至被击倒）
  const manualCost = input.forced ? [] : ['the switch-in cannot act this turn and will take any attacks aimed at this slot'];
  return [head, ...outgoingNotes, ...manualCost, ...risks, ...(risks.length ? [DAMAGE_CAVEAT] : []),
    ...analysisPokemonText(input.analysis, input.pokemon.ident, input.teamSlot)].filter(Boolean).join('; ');
}

/** 先验推断的对手预期 Mega 形态（preview 对位行用） */
export interface LikelyMegaFoe {
  species: string;
  name: string;
  types: string[];
  percent: number;
}

/** preview 预期对手首发情报（L2+ 逐槽 as-a-lead 行用；由 team-preview 从先验+经验库计算） */
export interface PreviewLeadIntel {
  species: string;
  types: string[];
  /** 经验库交手记录（seen>=3；无记录为 null） */
  memory: {seen: number; wins: number; losses: number; leads: number} | null;
}

/**
 * preview 逐槽 as a lead 评估行（L2+）：速度排名与超速事实 + 对预期首发攻防 + 交手战绩。
 * 与预期首发无攻防关系的槽位省略经验句，避免机械重复。
 */
function describeLeadLine(input: {
  dex: DexData;
  pokemon: RequestPokemon;
  analysis: AnalysisContext;
  teamSlot?: number;
  foeLeads: PreviewLeadIntel[];
}): string {
  const {dex, analysis} = input;
  const own = analysis.ourSpeeds.find(s => input.teamSlot === undefined ? s.ident === input.pokemon.ident : s.slot === input.teamSlot);
  const known = analysis.ourSpeeds.filter(s => s.speed !== null);
  const speed = own?.speed ?? null;
  let speedPart: string;
  if (speed === null) speedPart = 'speed unknown';
  else {
    const rank = 1 + known.filter(s => (s.speed as number) > speed).length;
    const foes = analysis.previewFoes.filter(f => f.baseSpeed !== null);
    speedPart = `speed ${speed} (rank ${rank} of your ${known.length})` + (foes.length
      ? ` — outruns ${foes.filter(f => speed > (f.baseSpeed as number)).length}/${foes.length} foe base speeds (fastest foe base ${Math.max(...foes.map(f => f.baseSpeed as number))}; base stats only, natures/EVs/items unknown)`
      : ' — foe base speeds unknown');
  }
  const types = speciesTypes(dex, speciesOf(input.pokemon));
  const entryWeather = entryWeatherOf(input.pokemon);
  const offense: string[] = [];
  const defense: string[] = [];
  // 关系判定覆盖全部预期首发；攻防展示仍各限 2 条，经验句不因展示截断而丢失
  const related = new Set<string>();
  for (const lead of input.foeLeads) {
    let hit: {name: string; mult: number} | null = null;
    for (const id of input.pokemon.moves ?? []) {
      const mv = dex.moves[toId(id)];
      if (!mv || !mv.basePower) continue;
      const mult = knownEffectiveness(dex, weatherAdjustedType(id, mv.type, entryWeather), lead.types);
      if (mult !== null && mult > 1 && (!hit || mult > hit.mult)) hit = {name: mv.name, mult};
    }
    if (hit) {
      related.add(lead.species);
      if (offense.length < 2) offense.push(`hits ${lead.species} ${hit.mult}x (${hit.name})`);
    }
    let threat: {type: string; mult: number} | null = null;
    for (const type of lead.types) {
      const mult = knownEffectiveness(dex, type, types);
      if (mult !== null && mult > 1 && (!threat || mult > threat.mult)) threat = {type, mult};
    }
    if (threat) {
      related.add(lead.species);
      if (defense.length < 2) defense.push(`threatened by ${lead.species} ${threat.mult}x (potential ${threat.type} STAB)`);
    }
  }
  const memoryEntries = input.foeLeads
    .filter(lead => related.has(lead.species) && lead.memory && lead.memory.seen >= 3)
    .map(lead => `${lead.species} ${lead.memory!.seen} battles (${lead.memory!.wins}W-${lead.memory!.losses}L)`);
  return [
    `as a lead: ${speedPart}`,
    offense.length || defense.length ? `vs probable foe leads: ${[...offense, ...defense].join('; ')}` : '',
    memoryEntries.length ? `memory: ${memoryEntries.join(', ')}` : '',
  ].filter(Boolean).join('; ');
}

export function describePreviewCandidate(input: {
  dex: DexData;
  pokemon: RequestPokemon;
  opponentPreviewSpecies: string[];
  megaCapable: boolean;
  analysis?: AnalysisContext;
  teamSlot?: number;
  likelyMegaFoes?: LikelyMegaFoe[];
  /** 预期对手首发情报（L2+ 逐槽 as-a-lead 评估行；由 team-preview 传入） */
  leadIntel?: {foeLeads: PreviewLeadIntel[]};
}): string {
  const species = speciesOf(input.pokemon);
  const types = speciesTypes(input.dex, species);
  const moveNames = (input.pokemon.moves ?? []).map(id => input.dex.moves[toId(id)]?.name ?? id);
  // 自身入场造天气（如 Drought 造晴）时，气象球按该天气属性参与预览对位
  const entryWeather = entryWeatherOf(input.pokemon);
  const effectiveType = (id: string, mv: {type: string}) => weatherAdjustedType(id, mv.type, entryWeather);
  const typeLabel = (mv: {type: string}, type: string) => type === mv.type ? mv.type : `${type} in ${entryWeather}`;
  let bestName = '';
  let bestId = '';
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
      bestId = id;
    }
  }
  const attackerAbility = input.pokemon.ability ?? input.pokemon.baseAbility;
  // best 行与 coverage 行同用当前形态的伤害估算口径（STAB、攻击值、克制、天气）
  const damageOf = (moveId: string, defenderSpecies: string): number | null => {
    const mv = input.dex.moves[toId(moveId)];
    return estimateDamagePercent({
      dex: input.dex, moveId, attackerTypes: types, attackerStats: input.pokemon.stats,
      attackerAbility, defenderSpecies, weather: entryWeather,
      isSpread: !!mv && (mv.target === 'allAdjacentFoes' || mv.target === 'allAdjacent'),
    });
  };
  let topText = '';
  if (bestId) {
    let topPercent: number | null = null;
    let topFoe = '';
    for (const foe of input.analysis?.previewFoes.map(f => f.species) ?? input.opponentPreviewSpecies) {
      const pct = damageOf(bestId, foe);
      if (pct !== null && (topPercent === null || pct > topPercent)) {
        topPercent = pct;
        topFoe = foe;
      }
    }
    if (topPercent !== null) topText = `; top ≈${topPercent}% vs ${topFoe} (rough estimate)`;
  }
  const coverage: string[] = [];
  for (const foe of input.likelyMegaFoes ?? []) {
    const hits: Array<{moveId: string; name: string; label: string; multiplier: number}> = [];
    for (const id of input.pokemon.moves ?? []) {
      const mv = input.dex.moves[toId(id)];
      if (!mv || !mv.basePower) continue;
      const type = effectiveType(id, mv);
      const mult = knownEffectiveness(input.dex, type, foe.types);
      if (mult !== null && mult > 1) hits.push({moveId: id, name: mv.name, label: typeLabel(mv, type), multiplier: mult});
    }
    if (!hits.length) continue;
    const bestMult = Math.max(...hits.map(h => h.multiplier));
    const best = hits.filter(h => h.multiplier === bestMult).slice(0, 2);
    const desc = best.map(h => `${h.name} (${h.label})`).join(' and ');
    // 预期 Mega 形态在 dex 中有条目时按 Mega 形态的防御种族值估算，否则退回基础形态
    const pct = damageOf(best[0].moveId, input.dex.species[toId(foe.name)] ? foe.name : foe.species);
    coverage.push(`${desc} ${best.length > 1 ? 'hit' : 'hits'} likely ${foe.name} [${foe.types.join('/')}] ${bestMult}x${pct !== null ? ` ≈${pct}%` : ''} (${foe.percent.toFixed(1)}% Mega-stone prior, rough estimate)`);
  }
  const parts = [
    `${species} [${types.join('/') || '?'}]`,
    `moves: ${moveNames.join(', ') || '?'}`,
    input.megaCapable ? "can Mega Evolve (uses the team's only Mega slot)" : '',
    bestCount > 0 ? `best: ${bestName} hits ${bestCount}/${input.analysis?.previewFoes.length ?? input.opponentPreviewSpecies.length} foes super effectively${topText}` : '',
    ...(coverage.length ? [`likely-form coverage: ${coverage.slice(0, 2).join('; ')}`] : []),
    ...analysisPokemonText(input.analysis, input.pokemon.ident, input.teamSlot),
    ...(input.leadIntel && input.analysis && input.analysis.level >= 2
      ? [describeLeadLine({dex: input.dex, pokemon: input.pokemon, analysis: input.analysis, teamSlot: input.teamSlot, foeLeads: input.leadIntel.foeLeads})]
      : []),
  ];
  return parts.filter(Boolean).join('; ');
}

export function isMegaCapable(dex: DexData, pokemon: RequestPokemon): boolean {
  const species = speciesOf(pokemon);
  return canMegaWith(dex, dex.species[toId(species)]?.baseSpecies ?? species, pokemon.item);
}

/** 主攻方向：按伤害招式的类别计数判定，平手按 stats 比较；无伤害招或数据不足时 null（不提示）。 */
export function mainAttackOf(dex: DexData, pokemon: Pick<RequestPokemon, 'moves' | 'stats'>): 'spa' | 'atk' | null {
  let special = 0;
  let physical = 0;
  for (const id of pokemon.moves ?? []) {
    const move = dex.moves[toId(id)];
    if (!move || !move.basePower) continue;
    if (move.category === 'Special') special++;
    else if (move.category === 'Physical') physical++;
  }
  if (special + physical === 0) return null;
  if (special !== physical) return special > physical ? 'spa' : 'atk';
  const spa = pokemon.stats?.spa;
  const atk = pokemon.stats?.atk;
  if (spa === undefined || atk === undefined) return null;
  return spa >= atk ? 'spa' : 'atk';
}
