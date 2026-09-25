import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {SPREAD_MOVE_EN, loadChamdbPriors} from '../src/dex/chamdb-priors.js';
import {SPREAD_MOVE_IDS} from '../src/state/opponent-notes.js';
import {toId} from '../src/state/protocol.js';

const UPDATED = '2026-09-24T00:43:26.072+00:00';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'chamdb-priors-'));
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(data));
}

function metaJson(): unknown {
  return {
    season: 'M-6', format: 'double', limit: 3,
    fetchedAt: UPDATED, rankingsUpdatedAt: UPDATED,
    speciesCount: 2, fetched: [], skipped: [], failures: [],
  };
}

/**
 * 构造一份可用的本地缓存：榜单 3 物种（metagross 明细缺失）。
 * 站点数据（招式/道具/特性名）按真实形态为日文；'おいかぜ'、'ようりょくそ' 等
 * 为覆盖机制翻译注入的构造条目（不追求队伍合理性）。
 */
async function seed(dir: string, opts: {notes?: boolean; legacyMoveNotes?: boolean} = {}): Promise<void> {
  await writeJson(path.join(dir, 'meta.json'), metaJson());
  await writeJson(path.join(dir, 'rankings-M-6-double.json'), {
    seasonId: 'M-6', format: 'double', updatedAt: UPDATED,
    entries: [
      {rank: 1, pokemonJa: 'ゴリランダー', pokemonSlug: 'rillaboom'},
      {rank: 2, pokemonJa: 'ウォッシュロトム', pokemonSlug: 'rotom-wash'},
      {rank: 3, pokemonJa: 'メタグロス', pokemonSlug: 'metagross'},
    ],
  });
  await writeJson(path.join(dir, 'rillaboom.json'), {
    slug: 'rillaboom',
    variants: {'M-6:double': {
      seasonId: 'M-6', format: 'double', rank: 1, pokemonJa: 'ゴリランダー', pokemonSlug: 'rillaboom', dexNo: 812,
      moves: [
        {rank: 1, percentage: 97.5, name: 'グラススライダー'},
        {rank: 2, percentage: 40.2, name: 'おいかぜ'},
        {rank: 3, percentage: 30.3, name: 'トリックルーム'},
      ],
      items: [
        {rank: 1, percentage: 51.2, name: 'リザードナイトX'},
        {rank: 2, percentage: 20, name: 'きあい のタスキ'},
        {rank: 3, percentage: 10.9, name: 'いのちのたま'},
        {rank: 4, percentage: 8.1, name: 'オボンのみ'},
      ],
      abilities: [
        {rank: 1, percentage: 99.9, name: 'グラスメイカー'},
        {rank: 2, percentage: 30.1, name: 'ようりょくそ'},
      ],
      natures: [], evs: [], partners: [], updatedAt: UPDATED,
    }},
  });
  await writeJson(path.join(dir, 'rotom-wash.json'), {
    slug: 'rotom-wash',
    variants: {'M-6:double': {
      seasonId: 'M-6', format: 'double', rank: 2, pokemonJa: 'ウォッシュロトム', pokemonSlug: 'rotom-wash', dexNo: 479,
      moves: [
        {rank: 1, percentage: 88.4, name: 'ハイドロポンプ'},
        {rank: 2, percentage: 22.8, name: 'ほうでん'},
        {rank: 3, percentage: 12.6, name: 'ワイドフォース'},
      ],
      items: [], abilities: [], natures: [], evs: [], partners: [], updatedAt: UPDATED,
    }},
  });
  if (opts.notes !== false) {
    await writeJson(path.join(dir, 'item-notes-en.json'), {
      'リザードナイトX': 'Mega Evolves Charizard into Mega Charizard X. Holder must be a Charizard.',
      'きあいのタスキ': 'If holder has full HP, survives one hit with 1 HP.',
      'いのちのたま': 'Boosts move power by 30% but costs HP each turn.',
      'オボンのみ': 'Restores a large amount of health when the holder is at half or less of its maximum HP value. Second sentence.',
    });
    await writeJson(path.join(dir, 'ability-notes-en.json'), {
      'グラスメイカー': 'Sets Grassy Terrain when entering battle.',
      'ようりょくそ': 'Doubles Speed in sunlight.',
    });
    await writeJson(path.join(dir, opts.legacyMoveNotes ? 'move-notes-en.json' : 'learnset-move-notes-en.json'), {
      'おいかぜ': "Doubles allies' Speed for 4 turns.",
      'トリックルーム': 'For 5 turns, slower Pokémon move first.',
      'グラススライダー': 'Grassy Glide description text. Second sentence is dropped.',
      'ほうでん': 'Hits all opponents.',
      'ワイドフォース': 'In Psychic Terrain, a grounded user gains 1.5× power and hits all opponents.',
    });
  }
}

describe('loadChamdbPriors', () => {
  it('缺 meta 或缺榜单时返回 null', async () => {
    const empty = await tmpDir();
    expect(await loadChamdbPriors({cacheDir: empty})).toBeNull();
    const onlyMeta = await tmpDir();
    await writeJson(path.join(onlyMeta, 'meta.json'), metaJson());
    expect(await loadChamdbPriors({cacheDir: onlyMeta})).toBeNull();
  });
  it('构建先验：日文名保留、gloss 首句截取、控速/天气键翻英文、Mega 石打标、键归一化', async () => {
    const dir = await tmpDir();
    await seed(dir);
    const meta = await loadChamdbPriors({cacheDir: dir});
    expect(meta?.label).toBe('pokechamdb M-6 double 2026-09-24');
    const rilla = meta!.bySpecies.rillaboom;
    expect(rilla.moves).toEqual([
      {name: 'グラススライダー', percent: 97.5, gloss: 'Grassy Glide description text.'},
      {name: 'Tailwind', percent: 40.2, gloss: "Doubles allies' Speed for 4 turns."},
      {name: 'Trick Room', percent: 30.3, gloss: 'For 5 turns, slower Pokémon move first.'},
    ]);
    expect(rilla.abilities).toEqual([
      {name: 'グラスメイカー', percent: 99.9, gloss: 'Sets Grassy Terrain when entering battle.'},
      {name: 'Chlorophyll', percent: 30.1, gloss: 'Doubles Speed in sunlight.'},
    ]);
    expect(rilla.items.slice(0, 3)).toEqual([
      {name: 'リザードナイトX', percent: 51.2, gloss: 'Mega Evolves Charizard into Mega Charizard X.', mega: true},
      // 站点数据偶有空格瑕疵：去空白后命中说明，且不打 Mega 标记
      {name: 'きあい のタスキ', percent: 20, gloss: 'If holder has full HP, survives one hit with 1 HP.'},
      {name: 'いのちのたま', percent: 10.9, gloss: 'Boosts move power by 30% but costs HP each turn.'},
    ]);
    // 首句 > 90 字符时截断为 89 字符 + 省略号
    const obon = rilla.items.find(i => i.name === 'オボンのみ');
    expect(obon?.gloss).toHaveLength(90);
    expect(obon?.gloss?.endsWith('…')).toBe(true);
    expect(rilla.leads).toEqual([]);
    // slug 含连字符 → 去连字符物种键；榜单中有、明细缺失的物种跳过；群攻招式键翻英文
    expect(meta!.bySpecies.rotomwash?.moves).toEqual([
      {name: 'ハイドロポンプ', percent: 88.4},
      {name: 'Discharge', percent: 22.8, gloss: 'Hits all opponents.'},
      {name: 'Expanding Force', percent: 12.6, gloss: 'In Psychic Terrain, a grounded user gains 1.5× power and hits all opponents.'},
    ]);
    expect(meta!.bySpecies.metagross).toBeUndefined();
  });
  it('兼容旧缓存文件名 move-notes-en.json', async () => {
    const dir = await tmpDir();
    await seed(dir, {legacyMoveNotes: true});
    const meta = await loadChamdbPriors({cacheDir: dir});
    expect(meta!.bySpecies.rillaboom.moves[0].gloss).toBe('Grassy Glide description text.');
  });
  it('说明文件全缺时降级为无 gloss 先验（不失败、不打 Mega 标记）', async () => {
    const dir = await tmpDir();
    await seed(dir, {notes: false});
    const meta = await loadChamdbPriors({cacheDir: dir});
    const rilla = meta!.bySpecies.rillaboom;
    expect(rilla.moves[0]).toEqual({name: 'グラススライダー', percent: 97.5});
    expect(rilla.moves[1]).toEqual({name: 'Tailwind', percent: 40.2});
    expect(rilla.items[0]).toEqual({name: 'リザードナイトX', percent: 51.2});
  });
  it('limit 截取榜单前 N 名', async () => {
    const dir = await tmpDir();
    await seed(dir);
    const meta = await loadChamdbPriors({cacheDir: dir, limit: 1});
    expect(Object.keys(meta!.bySpecies)).toEqual(['rillaboom']);
  });
  it('群攻译表与消费端 id 集双向对齐（防止两处手工清单静默漂移）', () => {
    expect(new Set(Object.values(SPREAD_MOVE_EN).map(toId))).toEqual(SPREAD_MOVE_IDS);
  });
});
