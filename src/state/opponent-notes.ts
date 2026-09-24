import {megaFormsOf, type DexData, type SpeciesInfo} from '../dex/index.js';
import {priorEntryFor, type PriorEntry, type PriorMeta, type PriorPair} from '../dex/priors.js';
import {queryForOpponent, type MemoryData} from '../learn/store.js';
import {entryWeatherOf} from './calc.js';
import {parseIdent, parseLine, toId} from './protocol.js';
import {weatherDoublesSpeed} from './speed-control.js';
import type {BattleState, PokemonState} from './tracker.js';

export interface OpponentNoteSet {
  confirmed: string[];
  recent_actions: string[];
  assumed: string[];
  memory: string[];
}

export interface OpponentNotesInput {
  state: BattleState;
  ourSideId: string;
  priors?: PriorMeta | null;
  memory?: MemoryData | null;
  /** 对手 Mega 威胁注解需要 dex 中的 Mega 形态数据；缺省不输出该注解 */
  dex?: DexData;
}

const STATUS_LABELS: Record<string, string> = {
  psn: 'poisoned', tox: 'badly poisoned', par: 'paralyzed', brn: 'burned', slp: 'asleep', frz: 'frozen',
};

const RESULT_TYPES = new Set(['-damage', '-status', '-boost', '-fail', '-immune', '-miss']);

/** 控速招式的机制语义（用于未激活时的解读）；tailwind 4 回合、trickroom 5 回合 */
const CONTROL_MOVE_SEMANTICS: Record<string, string> = {
  tailwind: "doubles its side's Speed for 4 turns when used",
  trickroom: 'makes slower Pokemon move first for 5 turns when used',
};

/** 该个体所在侧的控速条件是否当前激活（tailwind 按侧、trickroom 全局） */
function controlActiveFor(state: BattleState, sideId: string, moveId: string): boolean {
  if (moveId === 'trickroom') return state.fieldConditionTurns['trickroom'] !== undefined;
  if (moveId === 'tailwind') return state.sides[sideId]?.sideConditionTurns['tailwind'] !== undefined;
  return false;
}

/** 把日志 ident（`p2a: Sneasler`）归一化到 tracker ident（`p2: Sneasler`）。 */
export function normalizeIdent(ident: string): string {
  const parsed = parseIdent(ident);
  return parsed ? `${parsed.side}: ${parsed.name}` : ident.trim();
}

function opponentSideId(state: BattleState, ourSideId: string): string {
  return ourSideId === 'p1' ? 'p2' : 'p1';
}

function lastConsumedItemName(state: BattleState, ident: string): string | null {
  const key = normalizeIdent(ident);
  for (let i = state.log.length - 1; i >= 0; i--) {
    const line = parseLine(state.log[i]);
    if (line?.type !== '-enditem') continue;
    if (line.args[0] && normalizeIdent(line.args[0]) === key && line.args[1]) return line.args[1];
  }
  return null;
}

/** 局内已确认信息（tracker 数据聚合，不看先验）。 */
export function confirmedNotes(state: BattleState, p: PokemonState): string[] {
  const notes: string[] = [];
  if (p.item) notes.push(`item confirmed: ${p.item}`);
  else if (p.consumedItem) {
    const used = lastConsumedItemName(state, p.ident);
    notes.push(used
      ? `item consumed: ${used} (one-time item already used)`
      : 'item consumed: one-time item already used');
  }
  if (p.ability) notes.push(`ability confirmed: ${p.ability}`);
  if (p.mega) notes.push('Mega evolved');
  if (p.revealedMoves.length) notes.push(`moves seen: ${p.revealedMoves.join(', ')}`);
  for (const move of p.revealedMoves) {
    const info = CONTROL_MOVE_SEMANTICS[toId(move)];
    if (info && !controlActiveFor(state, p.side, toId(move))) {
      notes.push(`speed-control threat — ${move} revealed (not active now): ${info}`);
    }
  }
  return notes;
}

interface PendingTarget {
  /** 槽位键 `${side}${pos}`（如 p1a）；同名宝可梦在不同位置也不会互相覆盖 */
  key: string;
  side: string;
  name: string | null;
  hp: string | null;
}

interface PendingMove {
  turn: number;
  actor: string;
  move: string;
  targets: PendingTarget[];
  effects: string[];
}

function applyDamage(target: PendingTarget, token: string | undefined): void {
  if (!token) return;
  const m = /^(\d+)\/(\d+)/.exec(token.trim());
  if (m) {
    const maxhp = Number(m[2]);
    target.hp = maxhp > 0 ? `${Math.round((Number(m[1]) / maxhp) * 100)}%` : '0%';
    return;
  }
  if (/^0\s+fnt/.test(token.trim())) target.hp = '0%';
}

/** PS 的 spread 属性 token：`[spread] p1a,p1b`（受击槽位列表，与主目标 token 分开）。 */
function spreadSlots(token: string): string[] {
  const m = /^\[spread\]\s*(.*)$/.exec(token.trim());
  if (!m) return [];
  return (m[1] ?? '').split(',').map(s => s.trim()).filter(s => /^p\d+[a-z]?$/.test(s));
}

function addTarget(targets: PendingTarget[], key: string, side: string, name: string | null): void {
  const existing = targets.find(t => t.key === key);
  if (existing) {
    if (!existing.name && name) existing.name = name;
    return;
  }
  targets.push({key, side, name, hp: null});
}

/** 最近对手动作（本局动态，供模型读操作）；时间正序，全局 ≤limit、单只 ≤2。 */
export function recentOpponentActions(state: BattleState, ourSideId: string, limit = 5): Map<string, string[]> {
  const oppSide = opponentSideId(state, ourSideId);
  const turnBlocks: string[][] = [];
  let current: string[] = [];
  for (const raw of state.log) {
    const line = parseLine(raw);
    if (line?.type === 'turn') {
      if (current.length) turnBlocks.push(current);
      current = [];
    }
    current.push(raw);
  }
  if (current.length) turnBlocks.push(current);
  // 只看真正的回合块（`|turn|` 开头），开局 switch 段不产生动作流。
  const recent = turnBlocks.filter(block => parseLine(block[0])?.type === 'turn').slice(-2);

  const events: Array<{ident: string; text: string}> = [];
  let pending: PendingMove | null = null;
  let currentTurn = 0;
  const flush = () => {
    if (!pending) return;
    const parts = [`turn ${pending.turn}: used ${pending.move}`];
    const hits = pending.targets.filter(t => t.hp);
    if (hits.length) {
      parts.push(`→ ${hits.map(t => `${t.side === ourSideId ? 'our' : 'its ally'} ${t.name ?? '?'} ${t.hp} HP`).join(', ')}`);
    }
    if (pending.effects.length) parts.push(`(${pending.effects.join(', ')})`);
    // 规格 4.2.2：|move| 本身就是事件源——自目标招式（Tailwind/Protect）与无结果招式也要可见。
    events.push({ident: pending.actor, text: parts.join(' ')});
    pending = null;
  };
  for (const block of recent) {
    for (const raw of block) {
      const line = parseLine(raw);
      if (!line) continue;
      const [a0, a1, a2] = line.args;
      if (line.type === 'turn') {
        flush();
        currentTurn = Number(a0) || currentTurn;
        continue;
      }
      if (line.type === 'move' || line.type === 'switch' || line.type === 'drag' ||
          line.type === '-mega' || line.type === '-enditem') {
        flush();
      }
      const ident = a0 ? parseIdent(a0) : null;
      if (ident && ident.side === oppSide) {
        if (line.type === 'move') {
          const targets: PendingTarget[] = [];
          for (const token of line.args.slice(2)) {
            const t = parseIdent(token);
            if (t) {
              addTarget(targets, `${t.side}${t.pos}`, t.side, t.name);
              continue;
            }
            // `[spread] p1a,p1b`：多体招式真实受击槽位，名称从结果行惰性补全
            for (const slot of spreadSlots(token)) addTarget(targets, slot, slot.slice(0, 2), null);
          }
          pending = {turn: currentTurn, actor: `${ident.side}: ${ident.name}`, move: a1 ?? '?', targets, effects: []};
        } else if (line.type === 'switch' || line.type === 'drag') {
          events.push({ident: `${ident.side}: ${ident.name}`, text: `turn ${currentTurn}: switched in`});
        } else if (line.type === '-mega') {
          events.push({ident: `${ident.side}: ${ident.name}`, text: `turn ${currentTurn}: Mega evolved`});
        }
      }
      if (!pending || !RESULT_TYPES.has(line.type)) continue;
      if (line.args.some(x => x.startsWith('[from]'))) continue;
      const missSource = line.type === '-miss' ? (line.args[1] ?? a0) : a0;
      const targetIdent = missSource ? parseIdent(missSource) : null;
      if (!targetIdent) continue;
      const target = pending.targets.find(t => t.key === `${targetIdent.side}${targetIdent.pos}`);
      if (!target) continue;
      if (!target.name) target.name = targetIdent.name;
      if (line.type === '-damage') {
        applyDamage(target, a1);
        continue;
      }
      // 二段效果（状态/能力变化等）：多目标招式无法可靠归属，只对单目标招式记录。
      if (pending.targets.length !== 1) continue;
      if (line.type === '-status' && a1) pending.effects.push(STATUS_LABELS[a1] ?? a1);
      else if (line.type === '-boost' && a1) pending.effects.push(`${a1} ${a2 ?? ''}`.trim());
      else if (line.type === '-fail') pending.effects.push('no effect');
      else if (line.type === '-immune') pending.effects.push('no effect (immune)');
      else if (line.type === '-miss') pending.effects.push('missed');
    }
    flush();
  }

  const trimmed = events.slice(-limit);
  const out = new Map<string, string[]>();
  for (const event of trimmed) {
    const list = out.get(event.ident) ?? [];
    list.push(event.text);
    out.set(event.ident, list.slice(-2));
  }
  return out;
}

function topList(list: PriorPair[], n: number): string {
  return list.slice(0, n)
    .map(x => `${x.name} ${x.percent.toFixed(1)}%${x.gloss ? ` [${x.gloss}]` : ''}`)
    .join(' / ');
}

/** Mega 形态的 X/Y/Z 后缀标记（无后缀返回 null）。 */
function megaFormMark(megaName: string): string | null {
  return /-Mega-([A-Z])$/.exec(megaName)?.[1] ?? null;
}

/** 说明中独立出现的 X/Y/Z 标记（如 "into Mega Charizard X."）；非字母边界避免匹配单词内字母。 */
function glossHasMark(gloss: string, mark: string): boolean {
  return new RegExp(`(^|[^A-Za-z])${mark}(?![A-Za-z])`).test(gloss);
}

/** 说明中出现的形态标记（X/Y/Z 独立 token）；无标记返回 null。 */
function glossFormMark(gloss: string): string | null {
  for (const mark of ['X', 'Y', 'Z']) {
    if (glossHasMark(gloss, mark)) return mark;
  }
  return null;
}

/**
 * 从先验道具中挑选该物种最可能的 Mega 形态：石匹配双路（英文道具名或说明含 Mega Evolve 且形态标记双向一致），
 * 多形态时取占比最高的候选；无候选返回 null。
 */
export function likelyMegaForm(dex: DexData, species: string, entry: PriorEntry): {mega: SpeciesInfo; pair: PriorPair} | null {
  let best: {mega: SpeciesInfo; pair: PriorPair} | null = null;
  for (const mega of megaFormsOf(dex, species)) {
    const stone = mega.requiredItem;
    if (!stone) continue;
    const mark = megaFormMark(mega.name);
    for (const item of entry.items) {
      if (item.percent <= 0) continue;
      const byName = toId(item.name) === toId(stone);
      // 双向标记校验：形态带标记时要求说明含同一标记；形态无标记时要求说明不含任何标记。
      const itemMark = item.mega === true && item.gloss !== undefined ? glossFormMark(item.gloss) : null;
      const byMark = item.mega === true && itemMark === mark;
      if (!byName && !byMark) continue;
      if (!best || item.percent > best.pair.percent) best = {mega, pair: item};
    }
  }
  return best;
}

/**
 * 先验道具含该物种 Mega 石时的 Mega 威胁：形态属性（含变化）、特性与速度变化（仅道具未知时推断）。
 * 形态已揭示（已 Mega 或 species 带 -Mega 后缀）时不再猜测。
 */
function megaThreatNote(p: PokemonState, entry: PriorEntry, dex: DexData | undefined, source: string): string | null {
  if (!dex || p.item || p.consumedItem || p.mega) return null;
  // 形态已由 switch/detailschange 直接揭示时，目标形态已知，不再输出先验猜测。
  if (dex.species[toId(p.species)]?.requiredItem) return null;
  const best = likelyMegaForm(dex, p.species, entry);
  if (!best) return null;
  const {mega, pair} = best;
  const ability = Object.values(mega.abilities ?? {})[0];
  const base = dex.species[toId(mega.baseSpecies ?? p.species)];
  const baseSpe = base?.baseStats.spe;
  const speed = baseSpe !== undefined && mega.baseStats.spe !== baseSpe
    ? `Speed ${mega.baseStats.spe} (from ${baseSpe})` : `Speed ${mega.baseStats.spe}`;
  const megaTypes = mega.types.join('/');
  const baseTypes = base?.types.join('/');
  // Mega 形态特性为天气手时（按最频繁石配置预设的形态），附带天气后果：覆盖/争抢场上天气
  const futureWeather = ability ? entryWeatherOf({ability}) : undefined;
  return `mega threat — likely ${pair.name} ${pair.percent.toFixed(1)}%: Mega form ${mega.name} [${megaTypes}${baseTypes && baseTypes !== megaTypes ? `, from ${baseTypes}` : ''}] has ${ability ?? 'an unknown ability'} and ${speed}${futureWeather ? `; on Mega Evolution it would set ${futureWeather.toLowerCase()}, contesting any weather in play` : ''} ${source}`;
}

/** 控速先验威胁：先验招式含控速招（未揭示且未激活）或未揭示天气速度特性（当前天气匹配时）。 */
function speedControlThreatNotes(p: PokemonState, entry: PriorEntry, state: BattleState, source: string): string[] {
  const notes: string[] = [];
  const revealed = new Set(p.revealedMoves.map(toId));
  for (const mv of entry.moves) {
    const key = toId(mv.name);
    const info = CONTROL_MOVE_SEMANTICS[key];
    if (!info || revealed.has(key) || mv.percent <= 0) continue;
    if (controlActiveFor(state, p.side, key)) continue;
    notes.push(`speed-control threat — likely ${mv.name} ${mv.percent.toFixed(1)}%: ${info} ${source}`);
  }
  if (!p.ability) {
    for (const ab of entry.abilities) {
      if (ab.percent <= 0 || !weatherDoublesSpeed(ab.name, state.weather)) continue;
      notes.push(`speed-control threat — likely ${ab.name} ${ab.percent.toFixed(1)}%: with the current ${state.weather} up its Speed would double ${source}`);
      break;
    }
  }
  return notes;
}

/** 合理假设（统计先验）；所有条目带 prior 来源标记，与 confirmed 严格区分。 */
export function assumedNotes(
  p: PokemonState,
  entry: PriorEntry,
  opts: {label: string; preview: boolean; dex?: DexData; megaAvailable?: boolean; state?: BattleState},
): string[] {
  const notes: string[] = [];
  const source = `(prior: ${opts.label})`;
  const megaNote = opts.megaAvailable === false ? null : megaThreatNote(p, entry, opts.dex, source);
  if (megaNote) notes.push(megaNote);
  if (!p.item && !p.consumedItem && entry.items.length) {
    notes.push(`item unseen — likely ${topList(entry.items, 3)} ${source}`);
  }
  if (!p.ability && entry.abilities.length) {
    notes.push(`ability unseen — likely ${topList(entry.abilities, 2)} ${source}`);
  }
  const revealed = new Set(p.revealedMoves.map(toId));
  const missing = entry.moves.slice(0, 3).filter(m => !revealed.has(toId(m.name)) && !CONTROL_MOVE_SEMANTICS[toId(m.name)]);
  if (missing.length) notes.push(`commonly runs: ${topList(missing, 3)} ${source}`);
  if (opts.preview && entry.leads.length) {
    const own = entry.leads.find(l => toId(l.name) === toId(p.species));
    if (own && own.percent > 0) notes.push(`commonly leads ${own.percent.toFixed(1)}% of its teams ${source}`);
  }
  const controlNotes = opts.state ? speedControlThreatNotes(p, entry, opts.state, source) : [];
  notes.push(...controlNotes);
  // 常规注解上限 4（Mega 威胁额外 +1）；控速威胁始终保留，不被截断
  return [...notes.slice(0, 4 + (megaNote ? 1 : 0)), ...controlNotes];
}

/** 对手预览的 leads 占比概览（team-preview INTRO 用），降序 top-N。 */
export function leadPriorLines(priors: PriorMeta | null | undefined, speciesList: string[], limit = 3): string[] {
  if (!priors) return [];
  return speciesList
    .map(species => ({species, entry: priorEntryFor(priors, species)}))
    .map(({species, entry}) => {
      const own = entry?.leads.find(l => toId(l.name) === toId(species));
      return own && own.percent > 0 ? {species, percent: own.percent} : null;
    })
    .filter((x): x is {species: string; percent: number} => x !== null)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, limit)
    .map(x => `${x.species} ${x.percent.toFixed(1)}%`);
}

export function buildOpponentNotes(input: OpponentNotesInput): Record<string, OpponentNoteSet> {
  const oppSide = opponentSideId(input.state, input.ourSideId);
  const recent = recentOpponentActions(input.state, input.ourSideId);
  const preview = input.state.turn === 0;
  const megaAvailable = !input.state.sides[oppSide]?.megaUsed;
  const opponents = input.state.sides[oppSide]?.pokemon ?? [];
  const query = input.memory ? queryForOpponent(input.memory, opponents.map(p => p.species)) : null;
  const out: Record<string, OpponentNoteSet> = {};
  for (const p of opponents) {
    const entry = input.priors ? priorEntryFor(input.priors, p.species) : null;
    const key = toId(p.species);
    const coreLines = query
      ? query.cores.filter(core => core.key.split('+').includes(key)).map(core => core.text)
      : [];
    const memoryLines = query ? [...(query.bySpecies[key] ?? []), ...coreLines].slice(0, 3) : [];
    out[p.ident] = {
      confirmed: confirmedNotes(input.state, p),
      recent_actions: recent.get(p.ident) ?? [],
      assumed: entry && input.priors
        ? assumedNotes(p, entry, {label: input.priors.label, preview, dex: input.dex, megaAvailable, state: input.state})
        : [],
      memory: memoryLines,
    };
  }
  return out;
}
