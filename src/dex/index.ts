import {typechartFromDamageTaken, normalizeTypechart} from '../state/calc.js';
import {toId} from '../state/protocol.js';
import {fetchDataFile, type LiveDataOptions} from './livedata.js';

export interface SpeciesInfo {
  name: string;
  types: string[];
  baseStats: Record<string, number>;
  abilities: Record<string, string>;
  baseSpecies?: string;
  requiredItem?: string;
}

export interface MoveInfo {
  name: string;
  type: string;
  basePower: number;
  category: string;
  target: string;
  priority: number;
}

export interface DexData {
  species: Record<string, SpeciesInfo>;
  moves: Record<string, MoveInfo>;
  typechart: Record<string, Record<string, number>>;
  source: 'live-data' | 'pokemon-showdown' | 'empty';
}

export const EMPTY_DEX: DexData = {species: {}, moves: {}, typechart: {}, source: 'empty'};

export function speciesTypes(dex: DexData, species: string): string[] {
  return dex.species[toId(species)]?.types ?? [];
}

export function getMove(dex: DexData, moveIdOrName: string): MoveInfo | null {
  return dex.moves[toId(moveIdOrName)] ?? null;
}

/** 该宝可梦持有该道具时是否可以 Mega 进化（依据 mega 形态的 requiredItem） */
export function canMegaWith(dex: DexData, species: string, item: string | undefined): boolean {
  if (!item) return false;
  const baseId = toId(species);
  return Object.values(dex.species).some(
    s => toId(s.name).startsWith(`${baseId}mega`) && toId(s.requiredItem ?? '') === toId(item),
  );
}

export function normalizeSpecies(raw: Record<string, unknown>): Record<string, SpeciesInfo> {
  const out: Record<string, SpeciesInfo> = {};
  for (const [id, s] of Object.entries(raw)) {
    const v = s as Record<string, any>;
    if (!v || typeof v !== 'object' || !v.types || !v.baseStats) continue;
    out[toId(v.name ?? id)] = {
      name: v.name ?? id,
      types: v.types,
      baseStats: v.baseStats,
      abilities: v.abilities ?? {},
      baseSpecies: v.baseSpecies,
      requiredItem: v.requiredItem,
    };
  }
  return out;
}

export function normalizeMoves(raw: Record<string, unknown>): Record<string, MoveInfo> {
  const out: Record<string, MoveInfo> = {};
  for (const [, m] of Object.entries(raw)) {
    const v = m as Record<string, any>;
    if (!v || typeof v !== 'object' || !v.type || typeof v.basePower !== 'number') continue;
    out[toId(v.name)] = {
      name: v.name,
      type: v.type,
      basePower: v.basePower,
      category: v.category ?? 'Status',
      target: v.target ?? 'normal',
      priority: v.priority ?? 0,
    };
  }
  return out;
}

export interface LoadDexOptions extends LiveDataOptions {}

/**
 * 数据来源优先级：线上 data 文件（与服务器一致）→ 本地 pokemon-showdown 包 → 空降级。
 */
export async function loadDex(opts: LoadDexOptions = {}): Promise<DexData> {
  try {
    const [pokedex, moves, typechart] = await Promise.all([
      fetchDataFile('pokedex', opts),
      fetchDataFile('moves', opts),
      fetchDataFile('typechart', opts),
    ]);
    const species = normalizeSpecies(pokedex);
    const moveMap = normalizeMoves(moves);
    if (Object.keys(species).length && Object.keys(moveMap).length) {
      return {species, moves: moveMap, typechart: normalizeTypechart(typechart), source: 'live-data'};
    }
  } catch {
    // 线上不可用，走本地包
  }
  try {
    const pkg = (await import('pokemon-showdown')) as any;
    const Dex = pkg.Dex;
    if (Dex) {
      const species: Record<string, SpeciesInfo> = {};
      for (const s of Dex.species.all()) {
        species[s.id] = {name: s.name, types: s.types, baseStats: s.baseStats, abilities: {...s.abilities}, baseSpecies: s.baseSpecies, requiredItem: s.requiredItem};
      }
      const moveMap: Record<string, MoveInfo> = {};
      for (const m of Dex.moves.all()) {
        moveMap[m.id] = {name: m.name, type: m.type, basePower: m.basePower, category: m.category, target: m.target, priority: m.priority};
      }
      const typechart = typechartFromDamageTaken(Dex.types.all().map((t: any) => ({name: t.name, damageTaken: t.damageTaken})));
      if (Object.keys(species).length) return {species, moves: moveMap, typechart, source: 'pokemon-showdown'};
    }
  } catch {
    // 本地包不可用
  }
  return EMPTY_DEX;
}
