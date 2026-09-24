import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  chamdbVariantOf,
  fetchChamdbNotes,
  isChamdbMetaFresh,
  readChamdbMeta,
  readChamdbRankings,
  readChamdbSpecies,
  syncChamdb,
  type ChamdbMeta,
} from '../src/dex/pokechamdb.js';

const BASE = 'https://pokechamdb.com';
const RANKINGS_URL = `${BASE}/snapshots/rankings/M-6/double.json`;
const speciesUrl = (slug: string) => `${BASE}/snapshots/pokemon/${slug}.json`;
const UPDATED = '2026-09-24T00:43:26.072+00:00';
const NEWER = '2026-09-25T00:40:00.000+00:00';
const T0 = 1_000_000;

function rankingsJson(updatedAt = UPDATED): string {
  return JSON.stringify({
    seasonId: 'M-6', format: 'double', updatedAt,
    entries: [
      {rank: 1, pokemonJa: 'ゴリランダー', pokemonSlug: 'rillaboom'},
      {rank: 2, pokemonJa: 'オオニューラ', pokemonSlug: 'sneasler'},
      {rank: 3, pokemonJa: 'ボーマンダ', pokemonSlug: 'salamence'},
    ],
    abilityNamesBySlug: {},
  });
}

function speciesJson(slug: string, updatedAt = UPDATED): string {
  return JSON.stringify({
    slug,
    variants: {
      'M-6:double': {
        seasonId: 'M-6', format: 'double', rank: 1, pokemonJa: '日本語名', pokemonSlug: slug, dexNo: 1,
        moves: [{rank: 1, percentage: 93.7, name: 'ふんか'}],
        items: [], abilities: [], natures: [], evs: [], partners: [],
        updatedAt,
      },
    },
  });
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'chamdb-test-'));
}

function mkFetch(routes: Record<string, string>, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return {ok: false, status: 404} as Response;
    return {ok: true, status: 200, text: async () => body} as Response;
  }) as unknown as typeof fetch;
}

/** 造一份“已同步过”的缓存：榜单 + 前 2 名物种（updatedAt 同为 UPDATED）。 */
async function seed(dir: string): Promise<void> {
  await syncChamdb({
    cacheDir: dir, limit: 2, paceMs: 0, now: () => T0,
    fetchImpl: mkFetch({
      [RANKINGS_URL]: rankingsJson(),
      [speciesUrl('rillaboom')]: speciesJson('rillaboom'),
      [speciesUrl('sneasler')]: speciesJson('sneasler'),
    }),
  });
}

describe('syncChamdb', () => {
  it('首次同步：下载榜单与前 limit 名物种，写入缓存与 meta', async () => {
    const dir = await tmpDir();
    const calls: string[] = [];
    const res = await syncChamdb({
      cacheDir: dir, limit: 2, paceMs: 0, now: () => T0,
      fetchImpl: mkFetch({
        [RANKINGS_URL]: rankingsJson(),
        [speciesUrl('rillaboom')]: speciesJson('rillaboom'),
        [speciesUrl('sneasler')]: speciesJson('sneasler'),
      }, calls),
    });
    expect(res.source).toBe('network');
    expect(res.rankingsFetched).toBe(true);
    expect(res.meta).toMatchObject({
      season: 'M-6', format: 'double', limit: 2,
      fetchedAt: new Date(T0).toISOString(), rankingsUpdatedAt: UPDATED,
      speciesCount: 2, fetched: ['rillaboom', 'sneasler'], skipped: [], failures: [],
    });
    expect(calls).toEqual([RANKINGS_URL, speciesUrl('rillaboom'), speciesUrl('sneasler')]);
    expect((await readChamdbRankings(dir, 'M-6', 'double'))?.entries).toHaveLength(3);
    const file = await readChamdbSpecies(dir, 'rillaboom');
    expect(chamdbVariantOf(file, 'M-6', 'double')?.moves[0]).toEqual({rank: 1, percentage: 93.7, name: 'ふんか'});
    expect(await readChamdbSpecies(dir, 'salamence')).toBeNull();
  });

  it('meta 在 TTL 内：不再访问网站，直接读本地缓存；force 才重新拉榜单', async () => {
    const dir = await tmpDir();
    await seed(dir);
    const calls2: string[] = [];
    const res = await syncChamdb({
      cacheDir: dir, limit: 2, paceMs: 0, now: () => T0 + 60_000, ttlMs: 3_600_000,
      fetchImpl: mkFetch({}, calls2),
    });
    expect(res.source).toBe('cache');
    expect(res.rankingsFetched).toBe(false);
    expect(calls2).toEqual([]);
    expect(res.meta.fetched).toEqual(['rillaboom', 'sneasler']);
    const calls3: string[] = [];
    const forced = await syncChamdb({
      cacheDir: dir, limit: 2, paceMs: 0, now: () => T0 + 60_000, ttlMs: 3_600_000, force: true,
      fetchImpl: mkFetch({[RANKINGS_URL]: rankingsJson()}, calls3),
    });
    expect(forced.source).toBe('network');
    expect(calls3).toEqual([RANKINGS_URL]);
  });

  it('TTL 过期：重拉榜单；updatedAt 未变的物种跳过下载并刷新 fetchedAt', async () => {
    const dir = await tmpDir();
    await seed(dir);
    const calls: string[] = [];
    const res = await syncChamdb({
      cacheDir: dir, limit: 2, paceMs: 0, now: () => T0 + 7_200_000, ttlMs: 3_600_000,
      fetchImpl: mkFetch({[RANKINGS_URL]: rankingsJson()}, calls),
    });
    expect(res.source).toBe('network');
    expect(calls).toEqual([RANKINGS_URL]);
    expect(res.meta.fetched).toEqual([]);
    expect(res.meta.skipped).toEqual(['rillaboom', 'sneasler']);
    expect(res.meta.speciesCount).toBe(2);
    expect(res.meta.fetchedAt).toBe(new Date(T0 + 7_200_000).toISOString());
  });

  it('榜单更新后：只下载 updatedAt 前进的物种；失败物种记入 failures 且保留旧文件', async () => {
    const dir = await tmpDir();
    await seed(dir);
    const res = await syncChamdb({
      cacheDir: dir, limit: 2, paceMs: 0, now: () => T0 + 7_200_000, ttlMs: 3_600_000,
      fetchImpl: mkFetch({
        [RANKINGS_URL]: rankingsJson(NEWER),
        [speciesUrl('rillaboom')]: speciesJson('rillaboom', NEWER),
      }),
    });
    expect(res.meta.fetched).toEqual(['rillaboom']);
    expect(res.meta.skipped).toEqual([]);
    expect(res.meta.failures).toEqual(['sneasler']);
    expect(res.meta.rankingsUpdatedAt).toBe(NEWER);
    expect(res.meta.speciesCount).toBe(2);
    expect(chamdbVariantOf(await readChamdbSpecies(dir, 'rillaboom'), 'M-6', 'double')?.updatedAt).toBe(NEWER);
    expect(chamdbVariantOf(await readChamdbSpecies(dir, 'sneasler'), 'M-6', 'double')?.updatedAt).toBe(UPDATED);
  });

  it('榜单拉取失败：有旧缓存时降级读缓存；无缓存时抛错', async () => {
    const dir = await tmpDir();
    await seed(dir);
    const res = await syncChamdb({
      cacheDir: dir, limit: 2, paceMs: 0, now: () => T0 + 7_200_000, ttlMs: 3_600_000,
      fetchImpl: mkFetch({}),
    });
    expect(res.source).toBe('cache');
    expect(res.rankingsFetched).toBe(false);
    expect(res.meta.rankingsUpdatedAt).toBe(UPDATED);
    const empty = await tmpDir();
    await expect(syncChamdb({cacheDir: empty, limit: 2, paceMs: 0, fetchImpl: mkFetch({})}))
      .rejects.toThrow(/Pokechamdb/);
  });

  it('榜单为空视为拉取失败：无缓存抛错，有缓存降级', async () => {
    const empty = await tmpDir();
    const emptyRankings = JSON.stringify({seasonId: 'M-6', format: 'double', updatedAt: UPDATED, entries: []});
    await expect(syncChamdb({
      cacheDir: empty, limit: 2, paceMs: 0, fetchImpl: mkFetch({[RANKINGS_URL]: emptyRankings}),
    })).rejects.toThrow(/Pokechamdb/);
    const dir = await tmpDir();
    await seed(dir);
    const res = await syncChamdb({
      cacheDir: dir, limit: 2, paceMs: 0, now: () => T0 + 7_200_000, ttlMs: 3_600_000,
      fetchImpl: mkFetch({[RANKINGS_URL]: emptyRankings}),
    });
    expect(res.source).toBe('cache');
    expect(res.rankingsFetched).toBe(false);
  });

  it('非法 slug 的条目不下载、不可读（防路径穿越）', async () => {
    const dir = await tmpDir();
    const badRankings = JSON.stringify({
      seasonId: 'M-6', format: 'double', updatedAt: UPDATED,
      entries: [
        {rank: 1, pokemonJa: 'x', pokemonSlug: '../evil'},
        {rank: 2, pokemonJa: 'y', pokemonSlug: 'ok-slug'},
      ],
    });
    const calls: string[] = [];
    const res = await syncChamdb({
      cacheDir: dir, limit: 5, paceMs: 0,
      fetchImpl: mkFetch({[RANKINGS_URL]: badRankings, [speciesUrl('ok-slug')]: speciesJson('ok-slug')}, calls),
    });
    expect(calls).toEqual([RANKINGS_URL, speciesUrl('ok-slug')]);
    expect(res.meta.fetched).toEqual(['ok-slug']);
    expect(await readChamdbSpecies(dir, '../evil')).toBeNull();
    expect(await fs.readdir(path.join(dir, '..')).then(files => files.includes('evil.json'))).toBe(false);
  });

  it('读接口：缺失或损坏一律返回 null；非法 season 拒绝同步', async () => {
    const dir = await tmpDir();
    expect(await readChamdbMeta(dir)).toBeNull();
    expect(await readChamdbRankings(dir, 'M-6', 'double')).toBeNull();
    expect(await readChamdbSpecies(dir, 'nope')).toBeNull();
    expect(await readChamdbRankings(dir, '../x', 'double')).toBeNull();
    await fs.writeFile(path.join(dir, 'meta.json'), '{broken');
    expect(await readChamdbMeta(dir)).toBeNull();
    await expect(syncChamdb({cacheDir: dir, season: '../x', paceMs: 0, fetchImpl: mkFetch({})}))
      .rejects.toThrow(/season/i);
  });
});

describe('isChamdbMetaFresh', () => {
  it('按 fetchedAt 与 ttlMs 判断；无 meta 一律不新鲜', () => {
    const meta = {fetchedAt: new Date(T0).toISOString()} as ChamdbMeta;
    expect(isChamdbMetaFresh(meta, 3_600_000, () => T0 + 60_000)).toBe(true);
    expect(isChamdbMetaFresh(meta, 3_600_000, () => T0 + 3_600_000)).toBe(false);
    expect(isChamdbMetaFresh(null, 3_600_000, () => T0)).toBe(false);
  });
});

describe('fetchChamdbNotes', () => {
  const notesUrl = (file: string) => `${BASE}/${file}`;

  it('首次下载三个说明文件并写入缓存；再次运行全部跳过且零请求', async () => {
    const dir = await tmpDir();
    const calls: string[] = [];
    const res = await fetchChamdbNotes({
      cacheDir: dir,
      fetchImpl: mkFetch({
        [notesUrl('item-notes-en.json')]: '{"リザードナイトX":"Mega Evolves X into Mega Y."}',
        [notesUrl('ability-notes-en.json')]: '{"すいすい":"Doubles Speed in rain."}',
        [notesUrl('learnset-move-notes-en.json')]: '{"おいかぜ":"Doubles allies Speed."}',
      }, calls),
    });
    expect(res.fetched).toEqual(['item-notes-en.json', 'ability-notes-en.json', 'learnset-move-notes-en.json']);
    expect(res.skipped).toEqual([]);
    expect(res.failures).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'learnset-move-notes-en.json'), 'utf8')))
      .toEqual({'おいかぜ': 'Doubles allies Speed.'});
    // 二次运行：文件已存在，全部跳过且不发起请求
    const calls2: string[] = [];
    const again = await fetchChamdbNotes({cacheDir: dir, fetchImpl: mkFetch({}, calls2)});
    expect(again.fetched).toEqual([]);
    expect(again.skipped).toHaveLength(3);
    expect(calls2).toEqual([]);
  });

  it('单文件失败或内容非法记入 failures；force 时即使已存在也重下', async () => {
    const dir = await tmpDir();
    const res = await fetchChamdbNotes({
      cacheDir: dir,
      fetchImpl: mkFetch({[notesUrl('item-notes-en.json')]: '{"a":"b"}'}),
    });
    expect(res.fetched).toEqual(['item-notes-en.json']);
    expect(res.failures).toEqual(['ability-notes-en.json', 'learnset-move-notes-en.json']);
    // 内容非法（数组）同样视为失败，不落盘
    const dir2 = await tmpDir();
    const res2 = await fetchChamdbNotes({
      cacheDir: dir2,
      fetchImpl: mkFetch({[notesUrl('item-notes-en.json')]: '[]'}),
    });
    expect(res2.failures).toContain('item-notes-en.json');
    // force：重下已存在的文件并覆盖内容
    const calls: string[] = [];
    const forced = await fetchChamdbNotes({
      cacheDir: dir, force: true,
      fetchImpl: mkFetch({[notesUrl('item-notes-en.json')]: '{"a2":"b2"}'}, calls),
    });
    expect(forced.fetched).toEqual(['item-notes-en.json']);
    expect(calls).toContain(notesUrl('item-notes-en.json'));
    expect(JSON.parse(await fs.readFile(path.join(dir, 'item-notes-en.json'), 'utf8'))).toEqual({a2: 'b2'});
  });
});
