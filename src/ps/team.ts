import fs from 'node:fs';
import {createRequire} from 'node:module';

// pokemon-showdown 是 CJS 包，用 createRequire 保证 ESM 下可用
const require = createRequire(import.meta.url);
const {Teams} = require('pokemon-showdown') as typeof import('pokemon-showdown');

export interface PackedTeam {
  packed: string;
  hasMegaFormSpecies: boolean;
}

export function loadTeamPaste(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').trim();
}

/** `Golisopod-Mega @ Golisopite` → `Golisopod @ Golisopite`（服务器拒绝 -Mega 物种时的回退） */
export function stripMegaSuffix(paste: string): string {
  return paste.replace(/^(.+?)-Mega(-[XY])?(?=\s*@|\s*$)/gm, '$1');
}

export function packTeam(paste: string): PackedTeam {
  const sets = Teams.import(paste) as Array<{species: string}>;
  if (!sets || !sets.length) throw new Error('team paste 解析为空');
  const packed = Teams.pack(sets);
  // 本地包 Dex 不认识 Champions 专属形态时 import 会把物种改写为 id 形式，
  // 无法从 sets 里可靠检测 -Mega，改从原始 paste 文本检测
  return {packed, hasMegaFormSpecies: /-Mega(-[XY])?\s*@/m.test(paste)};
}

/** 解析 packed 每段的物种 id（格式为 `name|speciesId|item|...`，speciesId 为空时回退到 name 段） */
export function unpackSpeciesIds(packed: string): string[] {
  return packed
    .split(']')
    .filter(Boolean)
    .map(block => {
      const [name, speciesField] = block.split('|');
      return (speciesField || name).toLowerCase().replace(/[^a-z0-9]/g, '');
    });
}
