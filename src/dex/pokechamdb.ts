import fs from 'node:fs/promises';
import path from 'node:path';

export interface ChamdbUsageEntry {
  rank: number;
  percentage: number;
  name: string;
}

/** 能力点（本赛制的 “努力值”）分配：单项 ≤32、合计 66。 */
export interface ChamdbEvSpread {
  hp: number;
  atk: number;
  def: number;
  spAtk: number;
  spDef: number;
  speed: number;
  rank: number;
  percentage: number;
}

export interface ChamdbVariant {
  seasonId: string;
  format: string;
  rank: number;
  pokemonJa: string;
  pokemonSlug: string;
  dexNo: number;
  moves: ChamdbUsageEntry[];
  items: ChamdbUsageEntry[];
  abilities: ChamdbUsageEntry[];
  natures: ChamdbUsageEntry[];
  evs: ChamdbEvSpread[];
  partners: ChamdbUsageEntry[];
  updatedAt: string;
}

export interface ChamdbSpeciesFile {
  slug: string;
  variants: Record<string, ChamdbVariant>;
}

export interface ChamdbRankingEntry {
  rank: number;
  pokemonJa: string;
  pokemonSlug: string;
}

export interface ChamdbRankingsFile {
  seasonId: string;
  format: string;
  updatedAt: string;
  entries: ChamdbRankingEntry[];
}

/** 最近一次同步的结果快照（TTL 判定与诊断用）。 */
export interface ChamdbMeta {
  season: string;
  format: string;
  limit: number;
  fetchedAt: string;
  rankingsUpdatedAt: string;
  speciesCount: number;
  fetched: string[];
  skipped: string[];
  failures: string[];
}

export interface ChamdbSyncResult {
  /** network = 本次访问了站点；cache = 直接使用本地缓存。 */
  source: 'cache' | 'network';
  rankingsFetched: boolean;
  meta: ChamdbMeta;
}

export interface ChamdbSyncOptions {
  cacheDir: string;
  season?: string;
  format?: string;
  /** 只持久化榜单前 N 名物种（默认 100）。 */
  limit?: number;
  /** 距上次同步超过该时长才回源（默认 24 小时）。 */
  ttlMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 顺序下载物种的间隔毫秒，降低站点压力；测试可传 0。 */
  paceMs?: number;
  /** 忽略 TTL 强制回源。 */
  force?: boolean;
  now?: () => number;
  log?: (msg: string) => void;
}

export const CHAMDB_DEFAULT_SEASON = 'M-6';
export const CHAMDB_DEFAULT_FORMAT = 'double';
/** 站点英文说明映射（日文名 → 英文效果说明），供决策先验附加可读语义。 */
export const CHAMDB_NOTES_FILES = {
  items: 'item-notes-en.json',
  abilities: 'ability-notes-en.json',
  moves: 'learnset-move-notes-en.json',
} as const;
const DEFAULT_BASE_URL = 'https://pokechamdb.com';
const DEFAULT_LIMIT = 100;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_PACE_MS = 250;
const META_FILE = 'meta.json';
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rankingsFileName(season: string, format: string): string {
  return `rankings-${season}-${format}.json`;
}

/** 站点 slug 来自远端数据：非法或可能路径穿越的一律拒绝。 */
function speciesPath(cacheDir: string, slug: string): string | null {
  return SLUG_RE.test(slug) ? path.join(cacheDir, `${slug}.json`) : null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 原子写：临时文件 + rename，中断不留下半截 JSON。 */
async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

async function fetchJson(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await doFetch(url, {signal: controller.signal});
    if (!res.ok) return null;
    return JSON.parse(await res.text()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function isChamdbMetaFresh(meta: ChamdbMeta | null, ttlMs: number, now: () => number = Date.now): boolean {
  if (!meta) return false;
  const fetchedAt = Date.parse(meta.fetchedAt);
  return Number.isFinite(fetchedAt) && now() - fetchedAt < ttlMs;
}

export async function readChamdbMeta(cacheDir: string): Promise<ChamdbMeta | null> {
  const parsed = await readJson<ChamdbMeta>(path.join(cacheDir, META_FILE));
  if (!parsed || typeof parsed.fetchedAt !== 'string' || typeof parsed.rankingsUpdatedAt !== 'string') return null;
  return parsed;
}

export async function readChamdbRankings(cacheDir: string, season: string, format: string): Promise<ChamdbRankingsFile | null> {
  if (!TOKEN_RE.test(season) || !TOKEN_RE.test(format)) return null;
  const parsed = await readJson<ChamdbRankingsFile>(path.join(cacheDir, rankingsFileName(season, format)));
  return parsed && Array.isArray(parsed.entries) ? parsed : null;
}

export async function readChamdbSpecies(cacheDir: string, slug: string): Promise<ChamdbSpeciesFile | null> {
  const file = speciesPath(cacheDir, slug);
  if (!file) return null;
  const parsed = await readJson<ChamdbSpeciesFile>(file);
  return parsed && parsed.variants && typeof parsed.variants === 'object' ? parsed : null;
}

export function chamdbVariantOf(file: ChamdbSpeciesFile | null, season: string, format: string): ChamdbVariant | null {
  return file?.variants?.[`${season}:${format}`] ?? null;
}

/**
 * 同步 pokechamdb 静态快照：榜单 + 前 limit 名物种明细，持久化到 cacheDir。
 * 频率控制：meta 在 TTL 内零请求直读缓存；回源时 updatedAt 未变的物种跳过下载。
 * 无缓存且榜单拉取失败时抛出；有旧缓存则降级为 source='cache'。
 */
export async function syncChamdb(opts: ChamdbSyncOptions): Promise<ChamdbSyncResult> {
  const season = opts.season ?? CHAMDB_DEFAULT_SEASON;
  const format = opts.format ?? CHAMDB_DEFAULT_FORMAT;
  if (!TOKEN_RE.test(season)) throw new Error(`Pokechamdb season 参数无效：${season}`);
  if (!TOKEN_RE.test(format)) throw new Error(`Pokechamdb format 参数无效：${format}`);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const paceMs = opts.paceMs ?? DEFAULT_PACE_MS;
  const now = opts.now ?? Date.now;

  const cached = await readChamdbMeta(opts.cacheDir);
  if (!opts.force && isChamdbMetaFresh(cached, ttlMs, now)) {
    opts.log?.(`Pokechamdb 缓存有效（同步于 ${cached!.fetchedAt}），跳过网络访问`);
    return {source: 'cache', rankingsFetched: false, meta: cached!};
  }

  const rankings = await fetchJson(`${baseUrl}/snapshots/rankings/${season}/${format}.json`, doFetch, timeoutMs) as ChamdbRankingsFile | null;
  if (!rankings || !Array.isArray(rankings.entries) || !rankings.entries.length || typeof rankings.updatedAt !== 'string') {
    if (cached) {
      opts.log?.('Pokechamdb 榜单拉取失败；沿用本地缓存');
      return {source: 'cache', rankingsFetched: false, meta: cached};
    }
    throw new Error('Pokechamdb 榜单拉取失败，且无本地缓存可回退');
  }
  const entries = rankings.entries;
  await writeJson(path.join(opts.cacheDir, rankingsFileName(season, format)), rankings);
  opts.log?.(`Pokechamdb 榜单更新时间 ${rankings.updatedAt}；持久化前 ${Math.min(limit, entries.length)} 名`);

  const variantKey = `${season}:${format}`;
  const fetched: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  const slugs: string[] = [];
  const seen = new Set<string>();
  let fetchedAny = false;
  for (const entry of entries.slice(0, limit)) {
    const slug = typeof entry?.pokemonSlug === 'string' ? entry.pokemonSlug : '';
    if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
    if (chamdbVariantOf(await readChamdbSpecies(opts.cacheDir, slug), season, format)?.updatedAt === rankings.updatedAt) {
      skipped.push(slug);
      continue;
    }
    if (fetchedAny && paceMs > 0) await sleep(paceMs);
    fetchedAny = true;
    const body = await fetchJson(`${baseUrl}/snapshots/pokemon/${slug}.json`, doFetch, timeoutMs) as ChamdbSpeciesFile | null;
    if (body?.variants?.[variantKey]) {
      try {
        await writeJson(path.join(opts.cacheDir, `${slug}.json`), body);
        fetched.push(slug);
        continue;
      } catch {
        // 落盘失败按下载失败处理
      }
    }
    failures.push(slug);
  }

  let speciesCount = 0;
  for (const slug of slugs) if (await readChamdbSpecies(opts.cacheDir, slug)) speciesCount++;

  const meta: ChamdbMeta = {
    season, format, limit,
    fetchedAt: new Date(now()).toISOString(),
    rankingsUpdatedAt: rankings.updatedAt,
    speciesCount, fetched, skipped, failures,
  };
  await writeJson(path.join(opts.cacheDir, META_FILE), meta);
  opts.log?.(`Pokechamdb 同步完成：下载 ${fetched.length}、跳过 ${skipped.length}、失败 ${failures.length}`);
  return {source: 'network', rankingsFetched: true, meta};
}

export interface FetchChamdbNotesOptions {
  cacheDir: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 忽略已存在的本地文件强制重下。 */
  force?: boolean;
}

export interface ChamdbNotesSync {
  fetched: string[];
  skipped: string[];
  failures: string[];
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 同步站点上的三个英文说明映射（日文名 → 英文效果说明）。
 * 说明文件低频变动：本地已存在则跳过（force 覆盖重下）；单项失败静默入 failures。
 */
export async function fetchChamdbNotes(opts: FetchChamdbNotesOptions): Promise<ChamdbNotesSync> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetched: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  for (const file of Object.values(CHAMDB_NOTES_FILES)) {
    const target = path.join(opts.cacheDir, file);
    if (!opts.force && await fileExists(target)) {
      skipped.push(file);
      continue;
    }
    const body = await fetchJson(`${baseUrl}/${file}`, doFetch, timeoutMs);
    if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length) {
      try {
        await writeJson(target, body);
        fetched.push(file);
        continue;
      } catch {
        // 落盘失败按下载失败处理
      }
    }
    failures.push(file);
  }
  return {fetched, skipped, failures};
}
