import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE = 'https://play.pokemonshowdown.com/data';
const DEFAULT_CACHE_DIR = '.cache/ps-data';
const TTL_MS = 24 * 60 * 60 * 1000;

export interface LiveDataOptions {
  base?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

/**
 * 解析 PS 线上 data/*.js。这些文件是官方客户端同款数据源，形态为
 * `exports.BattlePokedex = {...}` 或裸对象字面量（用 new Function 求值，
 * 信任模型与官方客户端一致：只从 play.pokemonshowdown.com 拉取）。
 */
export function parseDataJs(src: string): Record<string, unknown> {
  const exportsObj: Record<string, unknown> = {};
  try {
    const fn = new Function('exports', `${src}\n; return exports;`);
    fn(exportsObj);
    const values = Object.values(exportsObj);
    if (values.length >= 1) return values[0] as Record<string, unknown>;
  } catch {
    // 裸对象字面量（如 {"fire":{...}}）在 exports 形式下会 SyntaxError，走表达式求值
  }
  const fn2 = new Function(`return (${src});`);
  return fn2() as Record<string, unknown>;
}

export async function fetchDataFile(name: string, opts: LiveDataOptions = {}): Promise<Record<string, unknown>> {
  const base = opts.base ?? DEFAULT_BASE;
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const doFetch = opts.fetchImpl ?? fetch;
  const cachePath = path.join(cacheDir, `${name}.json`);
  try {
    const [stat, raw] = await Promise.all([fs.stat(cachePath), fs.readFile(cachePath, 'utf8')]);
    if (Date.now() - stat.mtimeMs < TTL_MS) return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 无缓存或缓存损坏，继续拉取
  }
  const res = await doFetch(`${base}/${name}.js`);
  if (!res.ok) throw new Error(`拉取 ${name}.js 失败: ${res.status}`);
  const data = parseDataJs(await res.text());
  await fs.mkdir(cacheDir, {recursive: true});
  await fs.writeFile(cachePath, JSON.stringify(data));
  return data;
}
