import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {extractDataDate, loadPikaMeta, parsePikaList} from '../src/dex/pikalytics.js';

export const LIST_FIXTURE = [
  {
    name: 'Sneasler', rank: '2', percent: '36.64', winPercent: '49.784',
    types: ['fighting', 'poison'], stats: {hp: 80, atk: 130, def: 60, spa: 40, spd: 80, spe: 120},
    abilities: [{ability: 'Poison Touch', percent: '47.449'}, {ability: 'Unburden', percent: '31.2'}],
    items: [{item: 'Grassy Seed', item_us: 'Grassy_Seed', percent: '31.711'}, {item: 'White Herb', percent: '19.2'}],
    moves: [{move: 'Close Combat', percent: '49.932', type: 'fighting'}, {move: 'Fake Out', percent: '30.2', type: 'normal'}],
    team: [{pokemon: 'Rillaboom', types: ['grass'], rank: '4', percent: '42.694'}],
    leads: [{pokemon: 'Sneasler', games: 230, percent: '14.259', winPercent: '44.8'}],
  },
  {
    name: 'Metagross-Mega', rank: '9', percent: '5.1', winPercent: '50',
    stats: {spe: 110}, abilities: [{ability: 'Tough Claws', percent: '99'}],
    items: [], moves: [], team: [], leads: [],
  },
];

describe('extractDataDate', () => {
  it('从 game.js 文本提取 dataDate；缺失返回 null', () => {
    expect(extractDataDate('var c={dataDate: "2026-05", defaultFormat: "x"};')).toBe('2026-05');
    expect(extractDataDate('no data here')).toBeNull();
  });
});

describe('parsePikaList', () => {
  it('裁剪字段并保留数值与顺序', () => {
    const meta = parsePikaList(LIST_FIXTURE, '2026-05', 'gen9championsvgc2026regmc');
    expect(meta.dataDate).toBe('2026-05');
    const sneasler = meta.bySpecies.sneasler;
    expect(sneasler).toMatchObject({
      name: 'Sneasler', rank: 2, usagePercent: 36.64, winPercent: 49.784, baseSpeed: 120,
    });
    expect(sneasler.items[0]).toEqual({name: 'Grassy Seed', percent: 31.711});
    expect(sneasler.abilities[1]).toEqual({name: 'Unburden', percent: 31.2});
    expect(sneasler.moves[1]).toEqual({name: 'Fake Out', percent: 30.2});
    expect(sneasler.teammates[0]).toEqual({name: 'Rillaboom', percent: 42.694});
    expect(sneasler.leads[0]).toEqual({name: 'Sneasler', percent: 14.259});
  });
  it('Mega 形态是独立 key；缺 stats 时 baseSpeed 为 null', () => {
    const meta = parsePikaList(LIST_FIXTURE, '2026-05', 'f');
    expect(meta.bySpecies.metagrossmega.name).toBe('Metagross-Mega');
    expect(meta.bySpecies.metagrossmega.baseSpeed).toBe(110);
    expect(meta.bySpecies.sneasler.baseSpeed).toBe(120);
    const noStats = parsePikaList([{name: 'X', stats: {}}], '2026-05', 'f');
    expect(noStats.bySpecies.x.baseSpeed).toBeNull();
  });
  it('非法输入返回空表，不抛错', () => {
    for (const bad of [null, undefined, {}, 'nope', [42, null, {name: ''}]]) {
      expect(parsePikaList(bad, '2026-05', 'f').bySpecies).toEqual({});
    }
  });
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pika-test-'));
}

function mkFetch(routes: Record<string, string | number>, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    const body: string | number | undefined = routes[String(url)];
    if (body === undefined) return {ok: false, status: 404} as Response;
    if (typeof body === 'number') return {ok: true, status: body} as Response;
    return {ok: true, status: 200, text: async () => body} as Response;
  }) as unknown as typeof fetch;
}

const GAME_JS = 'x={dataDate: "2026-05", defaultFormat: "gen9championsvgc2026regmc"};';
const LIST_URL = 'https://www.pikalytics.com/api/l/2026-05/gen9championsvgc2026regmc-1760';

describe('loadPikaMeta', () => {
  it('拉取 game.js + 列表并写入缓存；第二次命中缓存不再下载列表', async () => {
    const dir = await tmpDir();
    const calls1: string[] = [];
    const meta1 = await loadPikaMeta({format: 'gen9championsvgc2026regmc', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({'https://cdn.pikalytics.com/scripts/game.js': GAME_JS, [LIST_URL]: JSON.stringify(LIST_FIXTURE)}, calls1)});
    expect(meta1?.bySpecies.sneasler.name).toBe('Sneasler');
    expect(calls1).toEqual(['https://cdn.pikalytics.com/scripts/game.js', LIST_URL]);
    const calls2: string[] = [];
    const meta2 = await loadPikaMeta({format: 'gen9championsvgc2026regmc', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({'https://cdn.pikalytics.com/scripts/game.js': GAME_JS}, calls2)});
    expect(meta2?.dataDate).toBe('2026-05');
    expect(calls2).toEqual(['https://cdn.pikalytics.com/scripts/game.js']);
  });
  it('game.js 失败时回退到本地缓存', async () => {
    const dir = await tmpDir();
    await loadPikaMeta({format: 'f', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({'https://cdn.pikalytics.com/scripts/game.js': GAME_JS, [LIST_URL]: JSON.stringify(LIST_FIXTURE)})});
    const meta = await loadPikaMeta({format: 'f', cutoff: 1760, cacheDir: dir, fetchImpl: mkFetch({})});
    expect(meta?.bySpecies.sneasler).toBeDefined();
  });
  it('全部失败返回 null，不抛错', async () => {
    const dir = await tmpDir();
    const meta = await loadPikaMeta({format: 'f', cutoff: 1760, cacheDir: dir, fetchImpl: mkFetch({})});
    expect(meta).toBeNull();
  });
  it('列表为空数组视为无先验', async () => {
    const dir = await tmpDir();
    const meta = await loadPikaMeta({format: 'f', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({'https://cdn.pikalytics.com/scripts/game.js': GAME_JS, [LIST_URL]: '[]'})});
    expect(meta).toBeNull();
  });
  it('缓存命中校验赛制：格式不符时重新拉取而不是沿用旧先验', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'meta-2026-05.json'),
      JSON.stringify(parsePikaList(LIST_FIXTURE, '2026-05', 'gen9vgc2025regh')));
    const calls: string[] = [];
    const meta = await loadPikaMeta({format: 'gen9championsvgc2026regmc', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({'https://cdn.pikalytics.com/scripts/game.js': GAME_JS, [LIST_URL]: JSON.stringify(LIST_FIXTURE)}, calls)});
    expect(meta?.format).toBe('gen9championsvgc2026regmc');
    expect(calls).toContain(LIST_URL);
  });
  it('回退本地缓存时优先匹配赛制，无匹配才退回最新', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'meta-2026-04.json'),
      JSON.stringify(parsePikaList(LIST_FIXTURE, '2026-04', 'wantformat')));
    await fs.writeFile(path.join(dir, 'meta-2026-05.json'),
      JSON.stringify(parsePikaList(LIST_FIXTURE, '2026-05', 'otherformat')));
    const meta = await loadPikaMeta({format: 'wantformat', cutoff: 1760, cacheDir: dir, fetchImpl: mkFetch({})});
    expect(meta?.format).toBe('wantformat');
    expect(meta?.dataDate).toBe('2026-04');
  });
  it('某格式列表为空时继续尝试回退格式', async () => {
    const dir = await tmpDir();
    const calls: string[] = [];
    const meta = await loadPikaMeta({format: 'otherformat', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({
        'https://cdn.pikalytics.com/scripts/game.js': GAME_JS,
        'https://www.pikalytics.com/api/l/2026-05/otherformat-1760': '[]',
        [LIST_URL]: JSON.stringify(LIST_FIXTURE),
      }, calls)});
    expect(meta?.format).toBe('gen9championsvgc2026regmc');
    expect(calls).toEqual([
      'https://cdn.pikalytics.com/scripts/game.js',
      'https://www.pikalytics.com/api/l/2026-05/otherformat-1760',
      LIST_URL,
    ]);
  });
});

// 列表 API 只给概要（除首条外详情为空），详情需逐个拉 /api/p/{date}/{format}-{cutoff}/{species}
const EMPTY_TORKOAL = {
  name: 'Torkoal', rank: '24', percent: '7.04', winPercent: '53.147',
  types: ['fire'], stats: {hp: 70, atk: 85, def: 140, spa: 85, spd: 70, spe: 20},
  abilities: [], items: [], moves: [], team: [], leads: [],
};
const LIST_WITH_EMPTY = [...LIST_FIXTURE, EMPTY_TORKOAL];
const DETAIL_URL = 'https://www.pikalytics.com/api/p/2026-05/gen9championsvgc2026regmc-1760/Torkoal';
const TORKOAL_DETAIL = {
  name: 'Torkoal', percent: 7, winPercent: '53.147',
  stats: {hp: 70, atk: 85, def: 140, spa: 85, spd: 70, spe: 20},
  abilities: [{ability: 'Drought', percent: '99'}, {ability: 'White Smoke', percent: '2'}],
  items: [{item: 'Charcoal', percent: '40'}, {item: 'Sitrus Berry', percent: '22'}],
  moves: [{move: 'Eruption', percent: '80'}, {move: 'Earth Power', percent: '45'}],
  team: [{pokemon: 'Indeedee-F', percent: '30'}],
  leads: [{pokemon: 'Torkoal', percent: '12'}],
};

describe('loadPikaMeta 详情补全', () => {
  it('对缺详情的物种拉取详情并合并；概要字段保留且不过度请求', async () => {
    const dir = await tmpDir();
    const calls: string[] = [];
    const meta = await loadPikaMeta({format: 'gen9championsvgc2026regmc', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({
        'https://cdn.pikalytics.com/scripts/game.js': GAME_JS,
        [LIST_URL]: JSON.stringify(LIST_WITH_EMPTY),
        [DETAIL_URL]: JSON.stringify(TORKOAL_DETAIL),
      }, calls)});
    const t = meta?.bySpecies.torkoal;
    expect(t?.items[0]).toEqual({name: 'Charcoal', percent: 40});
    expect(t?.abilities[0]).toEqual({name: 'Drought', percent: 99});
    expect(t?.moves[0]).toEqual({name: 'Eruption', percent: 80});
    expect(t?.teammates[0]).toEqual({name: 'Indeedee-F', percent: 30});
    expect(t?.leads[0]).toEqual({name: 'Torkoal', percent: 12});
    expect(t?.rank).toBe(24);
    expect(t?.usagePercent).toBe(7.04);
    expect(t?.baseSpeed).toBe(20);
    expect(calls.filter(u => u.includes('/api/p/'))).toEqual([DETAIL_URL]);
  });
  it('详情拉取失败时静默降级：保留概要，不抛错', async () => {
    const dir = await tmpDir();
    const meta = await loadPikaMeta({format: 'gen9championsvgc2026regmc', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({
        'https://cdn.pikalytics.com/scripts/game.js': GAME_JS,
        [LIST_URL]: JSON.stringify(LIST_WITH_EMPTY),
      })});
    expect(meta?.bySpecies.torkoal.items).toEqual([]);
    expect(meta?.bySpecies.torkoal.rank).toBe(24);
    expect(meta?.bySpecies.sneasler.name).toBe('Sneasler');
  });
  it('补全结果写回缓存：下次启动命中缓存且不再请求详情', async () => {
    const dir = await tmpDir();
    await loadPikaMeta({format: 'gen9championsvgc2026regmc', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({
        'https://cdn.pikalytics.com/scripts/game.js': GAME_JS,
        [LIST_URL]: JSON.stringify(LIST_WITH_EMPTY),
        [DETAIL_URL]: JSON.stringify(TORKOAL_DETAIL),
      })});
    const calls2: string[] = [];
    const meta2 = await loadPikaMeta({format: 'gen9championsvgc2026regmc', cutoff: 1760, cacheDir: dir,
      fetchImpl: mkFetch({'https://cdn.pikalytics.com/scripts/game.js': GAME_JS}, calls2)});
    expect(meta2?.bySpecies.torkoal.items[0]).toEqual({name: 'Charcoal', percent: 40});
    expect(calls2).toEqual(['https://cdn.pikalytics.com/scripts/game.js']);
  });
  it('详情请求 429 时限流退避并重试，成功后合并', async () => {
    const dir = await tmpDir();
    let detailCalls = 0;
    const base = mkFetch({
      'https://cdn.pikalytics.com/scripts/game.js': GAME_JS,
      [LIST_URL]: JSON.stringify(LIST_WITH_EMPTY),
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/p/')) {
        detailCalls++;
        if (detailCalls === 1) return {ok: false, status: 429} as Response;
        return {ok: true, status: 200, text: async () => JSON.stringify(TORKOAL_DETAIL)} as Response;
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    const meta = await loadPikaMeta({format: 'gen9championsvgc2026regmc', cutoff: 1760, cacheDir: dir,
      fetchImpl, detailPaceMs: 0});
    expect(detailCalls).toBe(2);
    expect(meta?.bySpecies.torkoal.items[0]).toEqual({name: 'Charcoal', percent: 40});
  });
});
