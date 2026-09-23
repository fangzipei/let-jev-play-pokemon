import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {canMegaWith, EMPTY_DEX, getMove, loadDex, normalizeMoves, normalizeSpecies, speciesTypes} from '../src/dex/index.js';

const stats = {hp: 45, atk: 49, def: 49, spa: 65, spd: 65, spe: 45};
const bulbasaur = {name: 'Bulbasaur', types: ['Grass', 'Poison'], baseStats: stats, abilities: {'0': 'Overgrow'}};
const tackle = {name: 'Tackle', type: 'Normal', basePower: 40, category: 'Physical', target: 'normal', priority: 0};
const local = {species: {bulbasaur}, moves: {tackle}, typechart: {fire: {grass: 2, water: 0.5}, water: {fire: 2}}};
const dirs: string[] = [];
function options(tables: Record<string, unknown>, localData = local) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-test-'));
  dirs.push(cacheDir);
  const exports: Record<string, string> = {pokedex: 'BattlePokedex', moves: 'BattleMovedex', typechart: 'BattleTypeChart'};
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const match = String(input).match(/\/(pokedex|moves|typechart)\.(js|json)$/)!;
    const data = tables[match[1]!];
    if (!data) return new Response('', {status: 503});
    return new Response(match[2] === 'js' ? `exports.${exports[match[1]!]} = ${JSON.stringify(data)};` : JSON.stringify(data));
  }) as typeof fetch;
  return {cacheDir, fetchImpl, localLoader: vi.fn(async () => localData)};
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

describe('loadDex 独立表回退', () => {
  it('线上单表失败不丢弃其他成功表，并从本地补充 ID', async () => {
    const opts = options({pokedex: {bulbasaur: {...bulbasaur, baseStats: {...stats, spe: 99}}, newmon: {...bulbasaur, name: 'Newmon'}}});
    const dex = await loadDex(opts);
    expect(dex.species.bulbasaur?.baseStats.spe).toBe(99);
    expect(dex.species.newmon?.name).toBe('Newmon');
    expect(dex.moves).toEqual(local.moves);
    expect(dex.typechart).toEqual(local.typechart);
    expect(dex.source).toBe('live-data');
    expect(opts.localLoader).toHaveBeenCalledOnce();
  });

  it('线上只有招式表可用也保留新数据', async () => {
    const opts = options({moves: {tackle: {...tackle, basePower: 55}}});
    const dex = await loadDex(opts);
    expect(dex.moves.tackle?.basePower).toBe(55);
    expect(dex.species).toEqual(local.species);
    expect(dex.source).toBe('live-data');
  });

  it('线上完整时仍补充本地独有条目，不覆盖线上值', async () => {
    const opts = options({pokedex: {newmon: {...bulbasaur, name: 'Newmon'}}, moves: {newmove: {...tackle, name: 'New Move'}}, typechart: {fire: {grass: 2}}});
    const dex = await loadDex(opts);
    expect(Object.keys(dex.species).sort()).toEqual(['bulbasaur', 'newmon']);
    expect(Object.keys(dex.moves).sort()).toEqual(['newmove', 'tackle']);
    expect(dex.typechart.water?.fire).toBe(2);
  });

  it('同 ID 按字段补齐，种族值和特性逐项合并', async () => {
    const opts = options({
      pokedex: {bulbasaur: {name: 'Bulbasaur', types: ['Grass'], baseStats: {spe: 80}, abilities: {H: 'Chlorophyll'}}},
      moves: {tackle: {name: 'Tackle', type: 'Normal', basePower: 0}},
    });
    const dex = await loadDex(opts);
    expect(dex.species.bulbasaur).toEqual({...bulbasaur, types: ['Grass'], baseStats: {...stats, spe: 80}, abilities: {'0': 'Overgrow', H: 'Chlorophyll'}});
    expect(dex.moves.tackle).toEqual({...tackle, basePower: 0});
  });

  it('损坏线上字段不能覆盖本地有效字段', async () => {
    const opts = options({pokedex: {bulbasaur: {types: [42], baseStats: {spe: '快', atk: 60}}}, moves: {tackle: {type: 'Normal', basePower: '强', category: null}}});
    const dex = await loadDex(opts);
    expect(dex.species.bulbasaur).toEqual({...bulbasaur, baseStats: {...stats, atk: 60}});
    expect(dex.moves.tackle).toEqual(tackle);
  });

  it('官方编码直接交给修正版转换函数，按倍率单元补本地缺口', async () => {
    const dex = await loadDex(options({typechart: {grass: {damageTaken: {Fire: 1, Water: 2, psn: 3}}, ground: {damageTaken: {Electric: 3}}}}));
    expect(dex.typechart.fire?.grass).toBe(2);
    expect(dex.typechart.water?.grass).toBe(0.5);
    expect(dex.typechart.electric?.ground).toBe(0);
    expect(dex.typechart.fire?.water).toBe(0.5);
    expect(dex.typechart.psn).toBeUndefined();
  });

  it('本地加载失败仍返回可用线上表，缺失 Mega 不借用基础形态', async () => {
    const opts = options({pokedex: {bulbasaur}, moves: {tackle}});
    opts.localLoader.mockRejectedValue(new Error('本地不可用'));
    const dex = await loadDex(opts);
    expect(dex.species.bulbasaur).toMatchObject(bulbasaur);
    expect(speciesTypes(dex, 'Bulbasaur-Mega')).toEqual([]);
    expect(getMove(dex, 'Unknown Move')).toBeNull();
    expect(canMegaWith(dex, 'Bulbasaur', 'Fake Stone')).toBe(false);
    expect(dex.typechart).toEqual({});
  });

  it('有效 Mega 精确匹配，不从基础形态复制数据', async () => {
    const mega = {...bulbasaur, name: 'Bulbasaur-Mega', baseSpecies: 'Bulbasaur', requiredItem: 'Test Stone', types: ['Grass']};
    const dex = await loadDex(options({pokedex: {bulbasaurmega: mega}}));
    expect(speciesTypes(dex, 'Bulbasaur-Mega')).toEqual(['Grass']);
    expect(canMegaWith(dex, 'Bulbasaur', 'Test Stone')).toBe(true);
    expect(speciesTypes(dex, 'Bulbasaur-Mega-X')).toEqual([]);
  });

  it('全部网络失败时使用注入的本地数据，不访问真实包', async () => {
    const opts = options({});
    const dex = await loadDex(opts);
    expect(dex).toMatchObject({...local, source: 'pokemon-showdown'});
    expect(opts.localLoader).toHaveBeenCalledOnce();
  });

  it('所有来源失效时保持空降级', async () => {
    const opts = options({});
    opts.localLoader.mockRejectedValue(new Error('缺包'));
    expect(await loadDex(opts)).toEqual(EMPTY_DEX);
  });

  it('线上稀缺且本地也缺字段时保留 unknown，不伪造种族值或招式类别', async () => {
    const opts = options({pokedex: {unknownmega: {types: ['Fire'], baseStats: {spe: 50}}}, moves: {unknownmove: {type: 'Fire', basePower: 50}}});
    opts.localLoader.mockRejectedValue(new Error('缺包'));
    const dex = await loadDex(opts);
    expect(speciesTypes(dex, 'Unknown-Mega')).toEqual([]);
    expect(getMove(dex, 'Unknown Move')).toBeNull();
  });
});

describe('dex schema', () => {
  it('未知招式不能命中对象原型属性', () => {
    expect(getMove(EMPTY_DEX, 'constructor')).toBeNull();
  });

  it('未知目标类型不进入招式表', () => {
    expect(normalizeMoves({badtarget: {...tackle, target: 'not-a-target'}})).toEqual({});
  });

  it('以表 ID 为主键，不以显示名称覆盖其他条目', () => {
    const result = normalizeSpecies({bulbasaurmega: {...bulbasaur, name: 'Bulbasaur'}});
    expect(result.bulbasaurmega?.name).toBe('Bulbasaur');
    expect(result.bulbasaur).toBeUndefined();
    expect(normalizeMoves({newmove: {...tackle, name: 'Tackle'}}).newmove?.basePower).toBe(40);
  });

  it('保留没有显示名但具有合法 ID 的招式', () => {
    const {name: _name, ...data} = tackle;
    expect(normalizeMoves({tackle: data}).tackle?.name).toBe('tackle');
  });

  it('拒绝数组、非法属性、非有限数字和不完整种族值', () => {
    expect(normalizeSpecies({bad: {name: 'Bad', types: 'Grass', baseStats: stats}, incomplete: {...bulbasaur, baseStats: {spe: 10}}, inf: {...bulbasaur, baseStats: {...stats, spe: Infinity}}})).toEqual({});
    expect(normalizeMoves({bad: {...tackle, basePower: NaN}, badtype: {...tackle, type: 'Fake'}, badcategory: {...tackle, category: 'Fake'}, array: []})).toEqual({});
  });
});
