import fs from 'node:fs/promises';
import path from 'node:path';
import {toId} from '../state/protocol.js';

export interface PikaPair {name: string; percent: number}

export interface PikaEntry {
  name: string;
  rank: number;
  usagePercent: number;
  winPercent: number;
  items: PikaPair[];
  abilities: PikaPair[];
  moves: PikaPair[];
  teammates: PikaPair[];
  leads: PikaPair[];
  baseSpeed: number | null;
}

export interface PikaMeta {
  dataDate: string;
  format: string;
  fetchedAt: number;
  bySpecies: Record<string, PikaEntry>;
}

const MAX_PAIRS = 24;
const MAX_LEADS = 12;

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function pairs(raw: unknown, nameKey: string, limit = MAX_PAIRS): PikaPair[] {
  if (!Array.isArray(raw)) return [];
  const out: PikaPair[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = obj[nameKey];
    const percent = num(obj.percent);
    if (typeof name !== 'string' || !name.trim() || percent === null) continue;
    out.push({name: name.trim(), percent});
    if (out.length >= limit) break;
  }
  return out;
}

/** Pikalytics 列表 JSON → 内部条目（纯函数；非法输入返回空表）。 */
export function parsePikaList(json: unknown, dataDate: string, format: string): PikaMeta {
  const bySpecies: Record<string, PikaEntry> = {};
  for (const item of Array.isArray(json) ? json : []) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const key = toId(name);
    if (!name || !key || key in bySpecies) continue;
    const stats = obj.stats && typeof obj.stats === 'object' ? obj.stats as Record<string, unknown> : {};
    bySpecies[key] = {
      name,
      rank: num(obj.rank) ?? 0,
      usagePercent: num(obj.percent) ?? 0,
      winPercent: num(obj.winPercent) ?? 0,
      items: pairs(obj.items, 'item'),
      abilities: pairs(obj.abilities, 'ability'),
      moves: pairs(obj.moves, 'move'),
      teammates: pairs(obj.team, 'pokemon'),
      leads: pairs(obj.leads, 'pokemon', MAX_LEADS),
      baseSpeed: num(stats.spe),
    };
  }
  return {dataDate, format, fetchedAt: Date.now(), bySpecies};
}

/** 列表 API 通常只给概要：除默认物种外 items/abilities 全空，需要拉详情补全。 */
function needsDetail(entry: PikaEntry): boolean {
  return entry.items.length === 0 && entry.abilities.length === 0;
}

/** 详情覆盖明细数组，但保留概要的排名/使用率（详情端点这两个字段缺失或口径不同）。 */
function mergeDetail(base: PikaEntry, detail: PikaEntry): PikaEntry {
  return {
    name: base.name,
    rank: base.rank,
    usagePercent: base.usagePercent,
    winPercent: base.winPercent || detail.winPercent,
    items: detail.items.length ? detail.items : base.items,
    abilities: detail.abilities.length ? detail.abilities : base.abilities,
    moves: detail.moves.length ? detail.moves : base.moves,
    teammates: detail.teammates.length ? detail.teammates : base.teammates,
    leads: detail.leads.length ? detail.leads : base.leads,
    baseSpeed: base.baseSpeed ?? detail.baseSpeed,
  };
}

/** 从 game.js 源码提取 dataDate（纯函数；失败 null）。 */
export function extractDataDate(source: string): string | null {
  const m = /dataDate:\s*"(\d{4}-\d{2})"/.exec(source);
  return m ? m[1] : null;
}

const GAME_JS_URL = 'https://cdn.pikalytics.com/scripts/game.js';
const API_BASE = 'https://www.pikalytics.com/api/l';

export interface LoadPikaOptions {
  format: string;
  cutoff: number;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 详情补全的请求节流间隔（毫秒）；测试可传 0 加速。 */
  detailPaceMs?: number;
  log?: (msg: string) => void;
}

/** 从 game.js 源码提取站点默认赛制（拉取失败时的回退格式）。 */
function siteDefaultFormat(source: string): string | null {
  const m = /defaultFormat:\s*"([^"]+)"/.exec(source);
  return m ? m[1] : null;
}

async function fetchText(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await doFetch(url, {signal: controller.signal});
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const API_DETAIL_BASE = 'https://www.pikalytics.com/api/p';
// 实测详情端点约每 10 秒只容忍 ~20 次请求：必须顺序 + 节流，否则触发 429 限流
const DETAIL_PACE_MS = 500;
const DETAIL_RETRIES = 3;
const ENRICH_BUDGET_MS = 300000;
const CHECKPOINT_EVERY = 40;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface DetailResult {status: number; body: string | null}

async function fetchDetail(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<DetailResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await doFetch(url, {signal: controller.signal});
    if (!res.ok) return {status: res.status, body: null};
    return {status: res.status, body: await res.text()};
  } catch {
    return {status: 0, body: null};
  } finally {
    clearTimeout(timer);
  }
}

/** 顺序拉取缺详情物种并就地合并；限流退避重试、失败静默跳过，返回是否有更新。 */
async function enrichDetails(
  meta: PikaMeta,
  opts: LoadPikaOptions,
  doFetch: typeof fetch,
  timeoutMs: number,
  checkpoint: () => Promise<void>,
): Promise<boolean> {
  const pending = Object.values(meta.bySpecies).filter(needsDetail)
    .sort((a, b) => (a.rank || Number.MAX_SAFE_INTEGER) - (b.rank || Number.MAX_SAFE_INTEGER));
  if (!pending.length) return false;
  const deadline = Date.now() + ENRICH_BUDGET_MS;
  const pace = opts.detailPaceMs ?? DETAIL_PACE_MS;
  let merged = 0;
  let throttledLogged = false;
  for (let i = 0; i < pending.length && Date.now() < deadline; i++) {
    const entry = pending[i];
    const key = toId(entry.name);
    const url = `${API_DETAIL_BASE}/${meta.dataDate}/${meta.format}-${opts.cutoff}/${encodeURIComponent(entry.name)}`;
    let body: string | null = null;
    for (let attempt = 0; attempt < DETAIL_RETRIES; attempt++) {
      const res = await fetchDetail(url, doFetch, timeoutMs);
      if (res.status === 429) {
        if (!throttledLogged) {
          throttledLogged = true;
          opts.log?.('Pikalytics 详情端点限流，退避重试');
        }
        await sleep(Math.min(pace * 8 * 2 ** attempt, 30000));
        continue;
      }
      body = res.body;
      break;
    }
    if (body !== null) {
      try {
        const detail = parsePikaList([JSON.parse(body)], meta.dataDate, meta.format).bySpecies[key];
        if (detail) {
          meta.bySpecies[key] = mergeDetail(entry, detail);
          merged++;
          if (merged % CHECKPOINT_EVERY === 0) await checkpoint();
        }
      } catch {
        // 单条解析失败静默跳过
      }
    }
    if (pace > 0 && i < pending.length - 1) await sleep(pace);
  }
  if (merged) opts.log?.(`Pikalytics 详情补全：${merged} 个物种`);
  return merged > 0;
}

async function writeCache(cacheDir: string, cachePath: string, meta: PikaMeta): Promise<void> {
  try {
    await fs.mkdir(cacheDir, {recursive: true});
    const tmp = `${cachePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta));
    await fs.rename(tmp, cachePath);
  } catch {
    // 缓存写入失败不影响本次使用
  }
}

async function readCachedMeta(cacheDir: string, format: string): Promise<PikaMeta | null> {
  try {
    const files = (await fs.readdir(cacheDir)).filter(f => /^meta-\d{4}-\d{2}\.json$/.test(f)).sort();
    const metas: PikaMeta[] = [];
    for (const file of files.reverse()) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(cacheDir, file), 'utf8')) as PikaMeta;
        if (parsed?.bySpecies && Object.keys(parsed.bySpecies).length) metas.push(parsed);
      } catch {
        // 损坏文件跳过，继续尝试更旧的缓存
      }
    }
    // 优先同赛制缓存；全部不匹配时才退回最新（网络完全不可用时的尽力降级）
    return metas.find(m => m.format === format) ?? metas[0] ?? null;
  } catch {
    return null;
  }
}

/** 任何失败返回 null（静默降级），不抛出；先验只用于决策辅助。 */
export async function loadPikaMeta(opts: LoadPikaOptions): Promise<PikaMeta | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const gameJs = await fetchText(GAME_JS_URL, doFetch, timeoutMs);
  const dataDate = gameJs ? extractDataDate(gameJs) : null;
  if (!dataDate) {
    opts.log?.('Pikalytics dataDate 获取失败；尝试本地缓存');
    return readCachedMeta(opts.cacheDir, opts.format);
  }
  const cachePath = path.join(opts.cacheDir, `meta-${dataDate}.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as PikaMeta;
    // 赛制不符视为无效缓存（换赛制不能静默沿用旧先验）
    if (parsed?.bySpecies && Object.keys(parsed.bySpecies).length && parsed.format === opts.format) {
      const checkpoint = (): Promise<void> => writeCache(opts.cacheDir, cachePath, parsed);
      if (await enrichDetails(parsed, opts, doFetch, timeoutMs, checkpoint)) await checkpoint();
      return parsed;
    }
  } catch {
    // 缓存缺失或损坏：继续拉取
  }
  // 优先用调用方配置的赛制（cfg.psFormat）；失败时回退 game.js 的 defaultFormat。
  const formats = [opts.format];
  const siteDefault = gameJs ? siteDefaultFormat(gameJs) : null;
  if (siteDefault && siteDefault !== opts.format) formats.push(siteDefault);
  let meta: PikaMeta | null = null;
  for (const format of formats) {
    const body = await fetchText(`${API_BASE}/${dataDate}/${format}-${opts.cutoff}`, doFetch, timeoutMs);
    if (body === null) continue;
    let parsed: PikaMeta;
    try {
      parsed = parsePikaList(JSON.parse(body), dataDate, format);
    } catch {
      continue;
    }
    if (!Object.keys(parsed.bySpecies).length) {
      opts.log?.(`Pikalytics ${format} 列表无数据；尝试回退格式`);
      continue;
    }
    meta = parsed;
    break;
  }
  if (!meta) {
    opts.log?.('Pikalytics 列表拉取失败；尝试本地缓存');
    return readCachedMeta(opts.cacheDir, opts.format);
  }
  const checkpoint = (): Promise<void> => writeCache(opts.cacheDir, cachePath, meta);
  await enrichDetails(meta, opts, doFetch, timeoutMs, checkpoint);
  await checkpoint();
  return meta;
}
