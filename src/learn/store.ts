// src/learn/store.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import {toId} from '../state/protocol.js';
import type {BattleObservation} from './extract.js';

export interface SpeciesRecord {
  name: string;
  seen: number; wins: number; losses: number; leads: number;
  items: Record<string, number>;
  abilities: Record<string, number>;
  moves: Record<string, number>;
  notes: string[];
}

export interface CoreRecord {seen: number; wins: number; losses: number; notes: string[]}

export interface MemoryData {
  version: 1;
  species: Record<string, SpeciesRecord>;
  cores: Record<string, CoreRecord>;
  processed: Record<string, string>;
  /** 缺少条目表示旧库进度未知；pending 可补跑，empty 是成功但无模式。 */
  modelReviews: Record<string, 'pending' | 'complete' | 'empty'>;
}

export function emptyMemory(): MemoryData {
  return {version: 1, species: {}, cores: {}, processed: {}, modelReviews: {}};
}

export async function loadMemory(dir: string): Promise<MemoryData> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'memory.json'), 'utf8')) as MemoryData;
    if (!parsed || parsed.version !== 1 || typeof parsed.species !== 'object' || typeof parsed.cores !== 'object') {
      throw new Error('invalid');
    }
    return {version: 1, species: parsed.species ?? {}, cores: parsed.cores ?? {},
      processed: parsed.processed ?? {}, modelReviews: parsed.modelReviews ?? {}};
  } catch {
    return emptyMemory();
  }
}

export async function saveMemory(dir: string, data: MemoryData): Promise<void> {
  await fs.mkdir(dir, {recursive: true});
  const target = path.join(dir, 'memory.json');
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, target);
}

/** 字母序去重的配对 key。 */
export function coreKey(a: string, b: string): string {
  const [x, y] = [toId(a), toId(b)].sort();
  return `${x}+${y}`;
}

function bump(counter: Record<string, number>, name: string): void {
  counter[name] = (counter[name] ?? 0) + 1;
}

function topName(counter: Record<string, number>, limit: number): string[] {
  return Object.entries(counter)
    .filter(([name]) => name !== 'unknown')
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

/** 把一局观察合并进经验库（纯计数；processed 幂等跳过）。 */
export function mergeObservation(data: MemoryData, obs: BattleObservation): void {
  if (data.processed[obs.battleId]) return;
  data.processed[obs.battleId] = new Date().toISOString();
  data.modelReviews[obs.battleId] = 'pending';
  for (const r of obs.revealed) {
    const key = toId(r.species);
    if (!key) continue;
    const record = (data.species[key] ??= {
      name: r.species, seen: 0, wins: 0, losses: 0, leads: 0, items: {}, abilities: {}, moves: {}, notes: [],
    });
    record.seen++;
    if (obs.won) record.wins++;
    else record.losses++;
    if (r.led) record.leads++;
    bump(record.items, r.item ?? 'unknown');
    bump(record.abilities, r.ability ?? 'unknown');
    for (const move of r.moves) bump(record.moves, move);
  }
  const species = [...new Set(obs.opponentSpecies)];
  for (let i = 0; i < species.length; i++) {
    for (let j = i + 1; j < species.length; j++) {
      const key = coreKey(species[i], species[j]);
      const core = (data.cores[key] ??= {seen: 0, wins: 0, losses: 0, notes: []});
      core.seen++;
      if (obs.won) core.wins++;
      else core.losses++;
    }
  }
}

export interface MemoryCoreLine {key: string; text: string}

export interface MemoryQueryResult {bySpecies: Record<string, string[]>; cores: MemoryCoreLine[]}

/** 对手物种列表 → 注入用经验条（物种 ≤limit.species、组合 ≤limit.cores）。 */
export function queryForOpponent(
  data: MemoryData | null,
  speciesList: string[],
  limits = {species: 6, cores: 3},
): MemoryQueryResult {
  if (!data) return {bySpecies: {}, cores: []};
  const unique = [...new Set(speciesList.map(toId))].filter(Boolean);
  const bySpecies: Record<string, string[]> = {};
  const ranked = unique
    .map(key => [key, data.species[key]] as const)
    .filter((pair): pair is readonly [string, SpeciesRecord] => !!pair[1] && (pair[1].seen > 0 || pair[1].notes.length > 0))
    .sort((a, b) => b[1].seen - a[1].seen)
    .slice(0, limits.species);
  for (const [key, record] of ranked) {
    if (record.seen === 0) {
      bySpecies[key] = [`${record.name}: review lesson (configuration statistics unavailable); note: ${record.notes[0]}`];
      continue;
    }
    const itemNames = topName(record.items, 2);
    const abilityNames = topName(record.abilities, 1);
    const summary = [...itemNames, ...abilityNames].join(' + ') || 'no consistent configuration observed';
    const note = record.notes[0] ? `; note: ${record.notes[0]}` : '';
    bySpecies[key] = [`${record.name} (${record.seen} battles seen): usually ${summary}${note}`];
  }
  const coreHits: Array<{key: string; record: CoreRecord}> = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const record = data.cores[coreKey(unique[i], unique[j])];
      if (record && record.seen > 0) coreHits.push({key: coreKey(unique[i], unique[j]), record});
    }
  }
  const cores = coreHits
    .sort((a, b) => b.record.seen - a.record.seen)
    .slice(0, limits.cores)
    .map(({key, record}) => {
      const [a, b] = key.split('+');
      const nameA = data.species[a]?.name ?? a;
      const nameB = data.species[b]?.name ?? b;
      return {key, text: `${nameA}+${nameB} core (${record.seen} battles seen): our ${record.wins}W-${record.losses}L`};
    });
  return {bySpecies, cores};
}

export interface ModelNoteScope {species: string[]; cores: string[]}

export interface ModelNoteApplication {
  received: number;
  added: number;
  duplicates: number;
  unmatched: number;
  discarded: number;
  unmatchedKeys: string[];
}

export function emptyModelApplication(): ModelNoteApplication {
  return {received: 0, added: 0, duplicates: 0, unmatched: 0, discarded: 0, unmatchedKeys: []};
}

/** 模型复盘产物合并：每物种/组合 ≤3 条，新的优先保留。 */
export function applyModelNotes(
  data: MemoryData,
  notes: {species: Record<string, string[]>; cores: Record<string, string[]>},
  scope?: ModelNoteScope,
): ModelNoteApplication {
  const result = emptyModelApplication();
  const allowedSpecies = scope ? new Map(scope.species.map(name => [toId(name), name])) : null;
  const normalizeCore = (key: string): string => key.split('+').map(toId).sort().join('+');
  const allowedCores = scope ? new Set(scope.cores.map(normalizeCore)) : null;
  // 别名键归并后再计数，避免同批多次更新同一记录而虚报新增。
  const grouped = new Map<SpeciesRecord | CoreRecord, string[]>();
  for (const section of ['species', 'cores'] as const) {
    for (const [name, list] of Object.entries(notes[section])) {
      result.received += list.length;
      const key = section === 'species' ? toId(name) : normalizeCore(name);
      const allowed = section === 'species' ? allowedSpecies : allowedCores;
      if (allowed && !allowed.has(key)) {
        result.unmatched += list.length;
        result.unmatchedKeys.push(`${section}:${name}`);
        continue;
      }
      // 仅当前日志确认的物种可补建无统计记录；绝不猜测或迁移昵称的历史计数。
      if (section === 'species' && allowedSpecies?.has(key) && !data.species[key]) {
        data.species[key] = {name: allowedSpecies.get(key)!, seen: 0, wins: 0, losses: 0, leads: 0,
          items: {}, abilities: {}, moves: {}, notes: []};
      }
      const record = data[section][key];
      if (!record) {
        result.unmatched += list.length;
        result.unmatchedKeys.push(`${section}:${name}`);
        continue;
      }
      grouped.set(record, [...(grouped.get(record) ?? []), ...list]);
    }
  }
  for (const [record, list] of grouped) {
    const previous = new Set(record.notes);
    const fresh = new Set<string>();
    for (const raw of list) {
      const note = raw.trim();
      if (!note) result.discarded++;
      else if (previous.has(note) || fresh.has(note)) result.duplicates++;
      else fresh.add(note);
    }
    record.notes = [...fresh, ...previous].slice(0, 3);
    const added = record.notes.filter(n => !previous.has(n)).length;
    result.added += added;
    result.discarded += fresh.size - added;
  }
  return result;
}
