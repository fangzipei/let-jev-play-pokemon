/**
 * 把 pokechamdb 本地缓存（.cache/pokechamdb，npm run chamdb:refresh 同步）转换为决策链路的
 * 统计先验 PriorMeta。站点数据（招式/道具/特性名）均为日文：通用条目保留日文名并附英文
 * 效果说明 gloss；控速招式与天气速度特性翻译为英文名，供既有 toId 匹配逻辑消费。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  chamdbVariantOf,
  readChamdbMeta,
  readChamdbRankings,
  readChamdbSpecies,
  type ChamdbUsageEntry,
} from './pokechamdb.js';
import type {PriorEntry, PriorMeta, PriorPair} from './priors.js';

/** 控速招式日文名 → 英文名（消费端以 toId 匹配 CONTROL_MOVE_SEMANTICS）。 */
const CONTROL_MOVE_EN: Record<string, string> = {
  'おいかぜ': 'Tailwind',
  'トリックルーム': 'Trick Room',
};

/**
 * 群攻（AOE）招式日文名 → 英文名（消费端以 toId 匹配）。
 * 英文名均经 PS sim 数据验证 target 为 allAdjacentFoes/allAdjacent；'ワイドフォース' 为
 * 条件群攻（默认单体，仅精神场地展开），由消费端额外标注。
 */
export const SPREAD_MOVE_EN: Record<string, string> = {
  'ワイドフォース': 'Expanding Force',
  'ハイパーボイス': 'Hyper Voice',
  'ねっぷう': 'Heat Wave',
  'いわなだれ': 'Rock Slide',
  'ふぶき': 'Blizzard',
  'マジカルシャイン': 'Dazzling Gleam',
  'バークアウト': 'Snarl',
  'ヘドロウェーブ': 'Sludge Wave',
  'じしん': 'Earthquake',
  'なみのり': 'Surf',
  'ばくおんぱ': 'Boomburst',
  'ほうでん': 'Discharge',
  'エレキネット': 'Electroweb',
  'ゴールドラッシュ': 'Make It Rain',
  'もえるねたみ': 'Burning Jealousy',
  'じならし': 'Bulldoze',
  'ワイドブレイカー': 'Breaking Swipe',
  'はなふぶき': 'Petal Blizzard',
  'ふんか': 'Eruption',
  'しおふき': 'Water Spout',
  'こごえるかぜ': 'Icy Wind',
  'だくりゅう': 'Muddy Water',
  'うたかたのアリア': 'Sparkling Aria',
};

/** 招式日文名 → 英文名统一翻译表（控速 + 群攻）。 */
const MOVE_EN: Record<string, string> = {...CONTROL_MOVE_EN, ...SPREAD_MOVE_EN};

/** 天气速度特性日文名 → 英文名（消费端 weatherDoublesSpeed 以 toId 匹配）。 */
const WEATHER_SPEED_ABILITY_EN: Record<string, string> = {
  'すいすい': 'Swift Swim',
  'ようりょくそ': 'Chlorophyll',
  'すなかき': 'Sand Rush',
  'ゆきかき': 'Slush Rush',
};

/** notes 文件名（站点原名）；moves 兼容早期缓存名 move-notes-en.json，按序尝试。 */
const NOTES_FILES = {
  items: ['item-notes-en.json'],
  abilities: ['ability-notes-en.json'],
  moves: ['learnset-move-notes-en.json', 'move-notes-en.json'],
} as const;

export interface LoadChamdbPriorsOptions {
  cacheDir: string;
  /** 只消费榜单前 N 名（默认全部已缓存条目）。 */
  limit?: number;
  log?: (msg: string) => void;
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** 站点数据偶有空格瑕疵（如 'きあい のタスキ'）：去空白后与说明文件键对齐。 */
function normalizeName(name: string): string {
  return name.replace(/[\s\u3000]/g, '');
}

/** 读取“日文名 → 英文说明”索引；首个可用文件生效，缺失/损坏返回空表。 */
async function readGlossIndex(cacheDir: string, files: readonly string[]): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const file of files) {
    const raw = await readJson(path.join(cacheDir, file));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      index.set(normalizeName(key), value);
    }
    break;
  }
  return index;
}

/** 说明截取首句且不超过 90 字符（超出部分以省略号结尾），避免注解被整段描述淹没。 */
function clipGloss(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

function toPair(entry: ChamdbUsageEntry, glossIndex: Map<string, string>, translate: Record<string, string> | null): PriorPair {
  const gloss = glossIndex.get(normalizeName(entry.name));
  const pair: PriorPair = {name: translate?.[entry.name] ?? entry.name, percent: entry.percentage};
  if (gloss) pair.gloss = clipGloss(gloss);
  return pair;
}

/** 道具：说明含 "Mega Evolve" 措辞时打标（日文名 Mega 石无法与英文 requiredItem 对消）。 */
function toItemPair(entry: ChamdbUsageEntry, glossIndex: Map<string, string>): PriorPair {
  const pair = toPair(entry, glossIndex, null);
  if (pair.gloss && /mega evolve/i.test(pair.gloss)) pair.mega = true;
  return pair;
}

/**
 * 读取本地 pokechamdb 缓存构建先验；无缓存（缺 meta 或缺榜单）返回 null。
 * 说明文件缺失或损坏时降级为无 gloss 先验，不抛出。leads 无数据（站点 partners 占比恒为 0）。
 */
export async function loadChamdbPriors(opts: LoadChamdbPriorsOptions): Promise<PriorMeta | null> {
  const meta = await readChamdbMeta(opts.cacheDir);
  if (!meta) {
    opts.log?.('Pokechamdb 无本地缓存（先运行 npm run chamdb:refresh）；无假设注入');
    return null;
  }
  const rankings = await readChamdbRankings(opts.cacheDir, meta.season, meta.format);
  if (!rankings) {
    opts.log?.(`Pokechamdb 缺少榜单 ${meta.season}/${meta.format} 本地缓存；无假设注入`);
    return null;
  }
  const [itemsIndex, abilitiesIndex, movesIndex] = await Promise.all([
    readGlossIndex(opts.cacheDir, NOTES_FILES.items),
    readGlossIndex(opts.cacheDir, NOTES_FILES.abilities),
    readGlossIndex(opts.cacheDir, NOTES_FILES.moves),
  ]);
  const bySpecies: Record<string, PriorEntry> = {};
  for (const ranking of rankings.entries.slice(0, opts.limit ?? rankings.entries.length)) {
    const slug = typeof ranking?.pokemonSlug === 'string' ? ranking.pokemonSlug : '';
    if (!slug) continue;
    const variant = chamdbVariantOf(await readChamdbSpecies(opts.cacheDir, slug), meta.season, meta.format);
    if (!variant) continue;
    bySpecies[slug.replace(/-/g, '')] = {
      items: variant.items.map(item => toItemPair(item, itemsIndex)),
      abilities: variant.abilities.map(ability => toPair(ability, abilitiesIndex, WEATHER_SPEED_ABILITY_EN)),
      moves: variant.moves.map(move => toPair(move, movesIndex, MOVE_EN)),
      leads: [],
    };
  }
  const label = `pokechamdb ${meta.season} ${meta.format} ${meta.rankingsUpdatedAt.slice(0, 10)}`;
  opts.log?.(`Pokechamdb 先验已从本地缓存构建（${Object.keys(bySpecies).length} 物种，${label}）`);
  return {label, bySpecies};
}
