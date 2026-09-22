#!/usr/bin/env node
/**
 * spec §13 验证脚本：pokemon-showdown 本地包与线上 data 的 Champions 数据覆盖。
 * 运行：npx tsx scripts/check-ps-data.ts
 */
import {createRequire} from 'node:module';
import {loadConfig} from '../src/config.js';
import {canMegaWith, getMove, loadDex, speciesTypes} from '../src/dex/index.js';

const require = createRequire(import.meta.url);

const TEAM_SPECIES = ['Golisopod', 'Tyranitar', 'Chandelure', 'Excadrill', 'Salamence', 'Rotom-Wash'];

async function main(): Promise<void> {
  const cfg = loadConfig(process.env, {requireApiKey: false});
  console.log(`PS_FORMAT=${cfg.psFormat}`);

  // 1) 本地包（pokemon-showdown）是否认识该 format 与队伍成员
  try {
    const pkg = require('pokemon-showdown') as {Dex: any};
    const format = pkg.Dex.formats.get(cfg.psFormat);
    console.log(`[local] format ${cfg.psFormat}.exists = ${format.exists}`);
    const champions = pkg.Dex.formats
      .all()
      .filter((f: any) => f.id.includes('champions'))
      .map((f: any) => f.id);
    console.log(`[local] champions 相关 format: ${champions.join(', ') || '(无)'}`);
    for (const name of ['Golisopod', 'Golisopod-Mega', 'Salamence-Mega']) {
      const s = pkg.Dex.species.get(name);
      console.log(`[local] species ${name}.exists = ${s.exists}${s.exists ? ` (types=${s.types.join('/')})` : ''}`);
    }
  } catch (err) {
    console.log(`[local] pokemon-showdown 不可用: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) loadDex 最终数据来源与关键条目
  const dex = await loadDex();
  console.log(
    `[loadDex] source=${dex.source} species=${Object.keys(dex.species).length} moves=${Object.keys(dex.moves).length}`,
  );
  for (const name of TEAM_SPECIES) {
    console.log(`  ${name}: types=${speciesTypes(dex, name).join('/') || '(未知)'}`);
  }
  console.log(`  Helping Hand: ${getMove(dex, 'helpinghand') ? '有' : '无'}`);
  console.log(`  canMegaWith(Golisopod, Golisopite) = ${canMegaWith(dex, 'Golisopod', 'Golisopite')}`);
  console.log(`  canMegaWith(Salamence, Salamencite) = ${canMegaWith(dex, 'Salamence', 'Salamencite')}`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
