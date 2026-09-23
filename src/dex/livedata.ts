import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE = 'https://play.pokemonshowdown.com/data';
const DEFAULT_CACHE_DIR = '.cache/ps-data';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_LENGTH = 8 * 1024 * 1024;
const EXPORTS = {pokedex: ['BattlePokedex'], moves: ['BattleMovedex', 'BattleMoves'], typechart: ['BattleTypeChart']} as const;
export type DataName = keyof typeof EXPORTS;
type DataTable = Record<string, unknown>;
const TYPES = new Set('Normal Fire Water Electric Grass Ice Fighting Poison Ground Flying Psychic Bug Rock Ghost Dragon Dark Steel Fairy Stellar'.split(' '));
const TYPE_IDS = new Set([...TYPES].map(type => type.toLowerCase()));
const MOVE_TARGETS = new Set('normal adjacentAlly adjacentAllyOrSelf adjacentFoe all allAdjacent allAdjacentFoes allies allySide allyTeam any foeSide randomNormal scripted self'.split(' '));
const STATS = new Set(['hp', 'atk', 'def', 'spa', 'spd', 'spe']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface LiveDataOptions {
  base?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  /** 单表所有源及响应体读取共用的总预算。 */
  timeoutMs?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}

function record(value: unknown): value is DataTable {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 只解析数据字面量；不运行脚本、函数、访问器或任何表达式。 */
export function parseDataJs(src: string, expected?: DataName): DataTable {
  if (src.length > MAX_SOURCE_LENGTH) throw new Error('数据文件过大');
  let offset = 0;
  const fail = (): never => {throw new Error(`不支持的数据语法，位置 ${offset}`);};
  const skip = () => {
    const whitespace = /(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*/y;
    whitespace.lastIndex = offset;
    offset += whitespace.exec(src)![0].length;
  };
  const consume = (text: string): boolean => {
    skip();
    if (!src.startsWith(text, offset)) return false;
    offset += text.length;
    return true;
  };
  const match = (pattern: RegExp): string | undefined => {
    skip();
    pattern.lastIndex = offset;
    const result = pattern.exec(src);
    if (!result) return undefined;
    offset = pattern.lastIndex;
    return result[0];
  };
  const string = (): string => {
    const token = match(/"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'/y) ?? fail();
    return token.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/g, (_full, escape: string) => {
      if (/^(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})$/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
      const escapes: Record<string, string> = {'"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0'};
      return Object.hasOwn(escapes, escape) ? escapes[escape]! : fail();
    });
  };
  const value = (depth: number): unknown => {
    if (depth > 64) return fail();
    skip();
    if (src[offset] === '"' || src[offset] === "'") return string();
    if (consume('{')) {
      const out: DataTable = {};
      if (consume('}')) return out;
      do {
        skip();
        const key = src[offset] === '"' || src[offset] === "'" ? string() : match(/[A-Za-z_$][\w$]*|\d+/y) ?? fail();
        if (FORBIDDEN_KEYS.has(key) || Object.hasOwn(out, key) || !consume(':')) return fail();
        out[key] = value(depth + 1);
        if (consume('}')) return out;
        if (!consume(',')) return fail();
      } while (!consume('}'));
      return out;
    }
    if (consume('[')) {
      const out: unknown[] = [];
      if (consume(']')) return out;
      do {
        out.push(value(depth + 1));
        if (consume(']')) return out;
        if (!consume(',')) return fail();
      } while (!consume(']'));
      return out;
    }
    const number = match(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y);
    if (number !== undefined) return Number.isFinite(Number(number)) ? Number(number) : fail();
    for (const [text, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (consume(text)) return result;
    }
    return fail();
  };
  if (consume('exports')) {
    if (!consume('.')) return fail();
    const name = match(/[A-Za-z]+/y) ?? fail();
    const allowed: readonly string[] = expected ? EXPORTS[expected] : Object.values(EXPORTS).flat();
    if (!allowed.includes(name) || !consume('=')) return fail();
  }
  const data = value(0);
  consume(';');
  skip();
  if (offset !== src.length || !record(data)) return fail();
  return data;
}

/** 保留通过校验的字段，缺项留给同 ID 本地数据补齐，不制造默认事实。 */
export function filterDataTable(name: DataName, raw: unknown): DataTable {
  const out: DataTable = {};
  if (!record(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!/^[a-z0-9]+$/i.test(id) || FORBIDDEN_KEYS.has(id) || !record(entry)) continue;
    const clean: DataTable = {};
    const copyText = (key: string) => {
      if (typeof entry[key] === 'string' && entry[key].trim()) clean[key] = entry[key];
    };
    const copyNumbers = (source: unknown, allowed: (key: string, value: number) => boolean): Record<string, number> => {
      const values: Record<string, number> = {};
      if (record(source)) for (const [key, v] of Object.entries(source)) {
        if (!FORBIDDEN_KEYS.has(key) && typeof v === 'number' && Number.isFinite(v) && allowed(key, v)) values[key] = v;
      }
      return values;
    };
    if (name === 'typechart') {
      if (!TYPE_IDS.has(id.toLowerCase())) continue;
      if (record(entry.damageTaken)) {
        const damageTaken = copyNumbers(entry.damageTaken, (_key, v) => [0, 1, 2, 3].includes(v));
        if (Object.keys(damageTaken).length) clean.damageTaken = damageTaken;
      } else {
        Object.assign(clean, copyNumbers(entry, (key, v) => TYPE_IDS.has(key.toLowerCase()) && [0, 0.5, 1, 2].includes(v)));
      }
    } else if (name === 'pokedex') {
      if (Array.isArray(entry.types) && entry.types.length > 0 && entry.types.length <= 2 && entry.types.every(t => TYPES.has(t))) clean.types = entry.types;
      const baseStats = copyNumbers(entry.baseStats, (key, v) => STATS.has(key) && Number.isInteger(v) && v > 0);
      if (Object.keys(baseStats).length) clean.baseStats = baseStats;
      if (record(entry.abilities)) {
        const abilities = Object.fromEntries(Object.entries(entry.abilities).filter(([key, v]) => /^(0|1|H|S)$/.test(key) && typeof v === 'string' && v.trim()));
        if (Object.keys(abilities).length) clean.abilities = abilities;
      }
      if (!Object.keys(clean).length) continue;
      copyText('name');
      copyText('baseSpecies');
      copyText('requiredItem');
    } else {
      if (typeof entry.type === 'string' && TYPES.has(entry.type)) clean.type = entry.type;
      if (typeof entry.basePower === 'number' && Number.isFinite(entry.basePower) && entry.basePower >= 0) clean.basePower = entry.basePower;
      if (!Object.keys(clean).length) continue;
      copyText('name');
      if (typeof entry.target === 'string' && MOVE_TARGETS.has(entry.target)) clean.target = entry.target;
      if (typeof entry.category === 'string' && ['Physical', 'Special', 'Status'].includes(entry.category)) clean.category = entry.category;
      if (typeof entry.priority === 'number' && Number.isInteger(entry.priority)) clean.priority = entry.priority;
    }
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

export async function fetchDataFile(name: string, opts: LiveDataOptions = {}): Promise<DataTable> {
  if (!Object.hasOwn(EXPORTS, name)) throw new Error('不支持的数据表');
  const table = name as DataName;
  const timeoutMs = opts.timeoutMs ?? 8000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || (opts.deadlineAt !== undefined && !Number.isFinite(opts.deadlineAt))) throw new Error('无效的数据请求预算');
  const deadline = Math.min(Date.now() + timeoutMs, opts.deadlineAt ?? Infinity);
  const controller = new AbortController();
  const assertActive = () => {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('请求已取消');
    if (controller.signal.aborted) throw controller.signal.reason;
    if (Date.now() >= deadline) throw new Error('数据请求超时');
  };
  assertActive();
  const base = (opts.base ?? DEFAULT_BASE).replace(/\/$/, '');
  const sources = [{url: `${base}/${name}.js`, json: false}];
  if (table !== 'typechart') sources.push({url: `${DEFAULT_BASE}/${name}.json`, json: true});
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const cachePath = path.join(cacheDir, `${name}.json`);
  const decode = (raw: string, json: boolean): DataTable => {
    if (raw.length > MAX_SOURCE_LENGTH) throw new Error('数据文件过大');
    const parsed: unknown = json ? JSON.parse(raw) : parseDataJs(raw, table);
    const data = filterDataTable(table, parsed);
    if (!Object.keys(data).length) throw new Error(`${name} 没有有效数据`);
    return data;
  };
  try {
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    const source = sources.find(s => s.url === cache?.sourceUrl);
    const age = Date.now() - cache?.fetchedAt;
    if (cache?.version === 1 && cache.name === name && source && typeof cache.fetchedAt === 'number' && age >= 0 && age < TTL_MS && typeof cache.raw === 'string') {
      const data = decode(cache.raw, source.json);
      assertActive();
      return data;
    }
  } catch {
    // 旧版、损坏、过期或不可验证的缓存不用于本次结果。
  }
  assertActive();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const stop = (reason: unknown) => {controller.abort(reason); reject(reason);};
    timer = setTimeout(() => stop(new Error('数据请求超时')), Math.max(0, deadline - Date.now()));
    onAbort = () => stop(opts.signal?.reason ?? new Error('请求已取消'));
    opts.signal?.addEventListener('abort', onAbort, {once: true});
    if (opts.signal?.aborted) onAbort();
  });
  const download = async () => {
    let lastError: unknown;
    for (const source of sources) {
      assertActive();
      try {
        const res = await (opts.fetchImpl ?? fetch)(source.url, {signal: controller.signal});
        assertActive();
        if (!res.ok) throw new Error(`拉取 ${name} 失败: ${res.status}`);
        const raw = await res.text();
        assertActive();
        const data = decode(raw, source.json);
        assertActive();
        return {data, cache: {version: 1, name, sourceUrl: source.url, fetchedAt: Date.now(), raw}};
      } catch (error) {
        assertActive();
        lastError = error;
      }
    }
    throw lastError;
  };
  let result: Awaited<ReturnType<typeof download>>;
  try {
    result = await Promise.race([download(), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
  try {
    await fs.mkdir(cacheDir, {recursive: true});
    await fs.writeFile(cachePath, JSON.stringify(result.cache));
  } catch {
    // 缓存是尽力而为，写入失败不能丢弃已校验的线上数据。
  }
  return result.data;
}
