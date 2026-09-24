#!/usr/bin/env node
/**
 * Pokechamdb 同步脚本：把双打前 N 名（默认 100）物种的使用率/能力点分布持久化到本地缓存，
 * 并下载 items/abilities/moves 的英文效果说明（notes）供决策先验生成 gloss；
 * 减少对战期间对站点的访问。meta 在 JEV_CHAMDB_TTL_HOURS（默认 24）内重复运行不会回源。
 * 运行：npm run chamdb:refresh [-- --limit 100 --season M-6 --format double --force]
 */
import {loadConfig} from '../src/config.js';
import {CHAMDB_DEFAULT_FORMAT, CHAMDB_DEFAULT_SEASON, fetchChamdbNotes, syncChamdb} from '../src/dex/pokechamdb.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env, {requireApiKey: false});
  const season = argValue('season') ?? CHAMDB_DEFAULT_SEASON;
  const format = argValue('format') ?? CHAMDB_DEFAULT_FORMAT;
  const limit = Number(argValue('limit') ?? 100);
  const force = process.argv.includes('--force');
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`--limit 必须是正整数（收到 ${argValue('limit')}）`);

  console.log(`[chamdb] season=${season} format=${format} limit=${limit} dir=${cfg.chamdbDir}${force ? '（force 忽略 TTL）' : ''}`);
  const startedAt = Date.now();
  const res = await syncChamdb({
    cacheDir: cfg.chamdbDir,
    season,
    format,
    limit,
    ttlMs: cfg.chamdbTtlHours * 3_600_000,
    force,
    log: msg => console.log(`[chamdb] ${msg}`),
  });
  const meta = res.meta;
  console.log(`[chamdb] 来源=${res.source} 榜单更新时间=${meta.rankingsUpdatedAt} 本地物种=${meta.speciesCount}`);
  console.log(
    `[chamdb] 下载=${meta.fetched.length} 跳过=${meta.skipped.length} 失败=${meta.failures.length} ` +
    `耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (meta.failures.length) console.log(`[chamdb] 失败物种：${meta.failures.join(', ')}（下次运行会重试）`);

  // 英文效果说明（notes）：变更频率低，普通运行跳过已存在文件，--force 时重下。
  const notes = await fetchChamdbNotes({cacheDir: cfg.chamdbDir, force});
  console.log(`[chamdb] notes 下载=${notes.fetched.length} 跳过=${notes.skipped.length} 失败=${notes.failures.length}`);
  if (notes.failures.length) console.log(`[chamdb] notes 失败文件：${notes.failures.join(', ')}（缺少时对应 gloss 静默省略）`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
