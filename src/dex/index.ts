import {typechartFromDamageTaken, normalizeTypechart} from '../state/calc.js';
import {toId} from '../state/protocol.js';
import {fetchDataFile, filterDataTable, type LiveDataOptions} from './livedata.js';

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
  const id = toId(moveIdOrName);
  return Object.hasOwn(dex.moves, id) ? dex.moves[id]! : null;
}

/** 该宝可梦持有该道具时是否可以 Mega 进化（依据 mega 形态的 requiredItem） */
export function canMegaWith(dex: DexData, species: string, item: string | undefined): boolean {
  if (!item) return false;
  const baseId = toId(species);
  return Object.values(dex.species).some(
    s => toId(s.name).startsWith(`${baseId}mega`) && toId(s.requiredItem ?? '') === toId(item),
  );
}

/** 该物种的全部 Mega 形态（含 X/Y 变体，按 baseSpecies 匹配） */
export function megaFormsOf(dex: DexData, species: string): SpeciesInfo[] {
  const base = toId(dex.species[toId(species)]?.baseSpecies ?? species).replace(/mega[xy]?$/, '');
  return Object.values(dex.species).filter(
    s => !!s.requiredItem && toId(s.baseSpecies ?? '').replace(/mega[xy]?$/, '') === base,
  );
}

export function normalizeSpecies(raw: Record<string, unknown>): Record<string, SpeciesInfo> {
  const out: Record<string, SpeciesInfo> = {};
  for (const [id, s] of Object.entries(filterDataTable('pokedex', raw))) {
    const v = s as Partial<SpeciesInfo>;
    if (!v.types || !v.baseStats || !['hp', 'atk', 'def', 'spa', 'spd', 'spe'].every(stat => v.baseStats![stat] !== undefined)) continue;
    out[toId(id)] = {
      name: v.name ?? id,
      types: [...v.types],
      baseStats: {...v.baseStats},
      abilities: {...v.abilities},
      ...(v.baseSpecies ? {baseSpecies: v.baseSpecies} : {}),
      ...(v.requiredItem ? {requiredItem: v.requiredItem} : {}),
    };
  }
  return out;
}

export function normalizeMoves(raw: Record<string, unknown>): Record<string, MoveInfo> {
  const out: Record<string, MoveInfo> = {};
  for (const [id, m] of Object.entries(filterDataTable('moves', raw))) {
    const v = m as Partial<MoveInfo>;
    if (!v.type || v.basePower === undefined || !v.category || !v.target || v.priority === undefined) continue;
    out[toId(id)] = {
      name: v.name ?? id,
      type: v.type,
      basePower: v.basePower,
      category: v.category,
      target: v.target,
      priority: v.priority,
    };
  }
  return out;
}

type LocalDexData = Partial<Pick<DexData, 'species' | 'moves' | 'typechart'>>;

export interface LoadDexOptions extends LiveDataOptions {
  /** 可注入本地数据加载器；测试无需依赖安装包的数据版本。 */
  localLoader?: () => Promise<LocalDexData>;
}

async function loadLocalDex(): Promise<LocalDexData> {
  const {Dex} = await import('pokemon-showdown');
  const local: LocalDexData = {};
  try {
    local.species = normalizeSpecies(Object.fromEntries(Dex.species.all().map(s => [s.id, s])));
  } catch {
    // 单表不可用不影响其他本地表。
  }
  try {
    local.moves = normalizeMoves(Object.fromEntries(Dex.moves.all().map(m => [m.id, m])));
  } catch {
    // 单表不可用不影响其他本地表。
  }
  try {
    local.typechart = typechartFromDamageTaken(Dex.types.all().map(t => ({name: t.name, damageTaken: t.damageTaken})));
  } catch {
    // 单表不可用不影响其他本地表。
  }
  return local;
}

/** 只合并同 ID 的已校验字段；线上有效值优先，嵌套字段逐项补缺。 */
function mergeTables(local: Record<string, unknown>, live: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const table of [local, live]) for (const [id, entry] of Object.entries(table)) {
    const key = toId(id);
    const old = (out[key] ?? {}) as Record<string, unknown>;
    const merged = {...old};
    for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
      merged[field] = value && typeof value === 'object' && !Array.isArray(value)
        ? {...(old[field] as object | undefined), ...value} : value;
    }
    out[key] = merged;
  }
  return out;
}

/** 线上 JS → 官方 JSON，按表保留成功数据，再由本地同 ID 补缺。 */
export async function loadDex(opts: LoadDexOptions = {}): Promise<DexData> {
  const localPromise = Promise.resolve().then(opts.localLoader ?? loadLocalDex).catch((): LocalDexData => ({}));
  const [results, local] = await Promise.all([
    Promise.allSettled([
      fetchDataFile('pokedex', opts),
      fetchDataFile('moves', opts),
      fetchDataFile('typechart', opts),
    ]),
    localPromise,
  ]);
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('请求已取消');
  const [pokedex, moves, rawChart] = results.map(result => result.status === 'fulfilled' ? result.value : {});
  const species = normalizeSpecies(mergeTables(filterDataTable('pokedex', local.species), pokedex!));
  const moveMap = normalizeMoves(mergeTables(filterDataTable('moves', local.moves), moves!));
  const liveChart = normalizeTypechart(rawChart!);
  const typechart = mergeTables(filterDataTable('typechart', local.typechart), liveChart) as DexData['typechart'];
  if (!Object.keys(species).length && !Object.keys(moveMap).length && !Object.keys(typechart).length) return EMPTY_DEX;
  const hasLive = Object.keys(pokedex!).some(id => Object.hasOwn(species, toId(id))) ||
    Object.keys(moves!).some(id => Object.hasOwn(moveMap, toId(id))) || Object.keys(liveChart).length > 0;
  return {species, moves: moveMap, typechart, source: hasLive ? 'live-data' : 'pokemon-showdown'};
}
