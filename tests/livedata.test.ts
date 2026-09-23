import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {fetchDataFile, parseDataJs} from '../src/dex/livedata.js';

const dirs: string[] = [];
const moves = {tackle: {name: 'Tackle', type: 'Normal', basePower: 40, category: 'Physical', target: 'normal', priority: 0}};
const js = `exports.BattleMovedex = ${JSON.stringify(moves)};`;
const official = 'https://play.pokemonshowdown.com/data';
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psdata-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

describe('parseDataJs', () => {
  it('解析 exports.BattleXxx 形式', () => {
    const data = parseDataJs('exports.BattlePokedex = {"bulbasaur":{"name":"Bulbasaur"}};');
    expect((data as any).bulbasaur.name).toBe('Bulbasaur');
  });
  it('解析裸对象字面量', () => {
    const data = parseDataJs('{"fire":{"grass":2}}');
    expect((data as any).fire.grass).toBe(2);
  });
  it('解析官方未加引号的键、单引号、注释、数字键和尾逗号', () => {
    expect(parseDataJs(`/* 数据 */ exports.BattleMovedex = {tackle: {name: 'Tackle', priority: -1, flags: {0: true}, desc: "引号\\\"",},}; // 尾注释`))
      .toEqual({tackle: {name: 'Tackle', priority: -1, flags: {'0': true}, desc: '引号"'}});
  });
  it.each([
    'exports.Unexpected = {ok: 1};',
    'exports.BattleMoves = {ok: (() => 1)()};',
    'exports.BattleMoves = {get ok() {return 1}};',
    'exports.BattleMoves = {}; exports.BattlePokedex = {};',
    'exports.BattleMoves = {}; globalThis.__dexSideEffect = true;',
    'exports.BattleMoves = {__proto__: {polluted: true}};',
    'exports.BattleMoves = {ok: NaN};',
    String.raw`exports.BattleMoves = {name: "\uQQQQ"};`,
    String.raw`exports.BattleMoves = {name: "\xZZ"};`,
  ])('拒绝可执行代码或非白名单语法：%s', src => {
    expect(() => parseDataJs(src)).toThrow();
    expect((globalThis as any).__dexSideEffect).toBeUndefined();
  });
});

describe('fetchDataFile', () => {
  it('首次拉取并写缓存，第二次走缓存', async () => {
    const cacheDir = tempDir();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(js);
    }) as unknown as typeof fetch;
    const first = await fetchDataFile('moves', {cacheDir, fetchImpl});
    expect((first as any).tackle.name).toBe('Tackle');
    const second = await fetchDataFile('moves', {cacheDir, fetchImpl});
    expect((second as any).tackle.name).toBe('Tackle');
    expect(calls).toBe(1);
    const cache = JSON.parse(fs.readFileSync(path.join(cacheDir, 'moves.json'), 'utf8'));
    expect(cache).toMatchObject({version: 1, name: 'moves', sourceUrl: `${official}/moves.js`, raw: js});
    expect(typeof cache.fetchedAt).toBe('number');
  });

  it.each([503, 404, '坏脚本', '错误导出', '无有效条目'])('JS 失败 %s 时回退官方 JSON', async failure => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).endsWith('.json')) return new Response(JSON.stringify(moves));
      if (typeof failure === 'number') return new Response('', {status: failure});
      return new Response(failure === '错误导出' ? `exports.BattlePokedex = ${JSON.stringify(moves)};` : failure === '无有效条目' ? 'exports.BattleMovedex = {bad: null};' : '<html>错误</html>');
    }) as typeof fetch;
    expect(await fetchDataFile('moves', {cacheDir: tempDir(), base: 'https://mirror.invalid/data', fetchImpl})).toEqual(moves);
    expect(urls).toEqual(['https://mirror.invalid/data/moves.js', `${official}/moves.json`]);
  });

  it('pokedex 使用官方 JSON 回退且 typechart 不猜测 JSON 路径', async () => {
    const species = {pikachu: {name: 'Pikachu', types: ['Electric'], baseStats: {spe: 90}}};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('pokedex.json')
      ? new Response(JSON.stringify(species)) : new Response('', {status: 404})) as typeof fetch;
    expect(await fetchDataFile('pokedex', {cacheDir: tempDir(), fetchImpl})).toEqual(species);
    await expect(fetchDataFile('typechart', {cacheDir: tempDir(), fetchImpl})).rejects.toThrow();
    expect(vi.mocked(fetchImpl).mock.calls.map(call => String(call[0])))
      .toEqual([`${official}/pokedex.js`, `${official}/pokedex.json`, `${official}/typechart.js`]);
  });

  it('schema 过滤无效条目与字段，保留可补缺字段', async () => {
    const data = {...moves, bad: null, nonsense: {type: 123, basePower: '40'}, partial: {type: 'Water', priority: 'fast', category: ['Physical']}};
    const fetchImpl = vi.fn(async () => new Response(`exports.BattleMovedex = ${JSON.stringify(data)};`)) as typeof fetch;
    expect(await fetchDataFile('moves', {cacheDir: tempDir(), fetchImpl})).toEqual({...moves, partial: {type: 'Water'}});
  });

  it('属性表保留官方编码，由 calc 负责转换', async () => {
    const raw = {fire: {damageTaken: {Water: 1, Grass: 2, brn: 3}}, invalid: null};
    const fetchImpl = vi.fn(async () => new Response(`exports.BattleTypeChart = ${JSON.stringify(raw)};`)) as typeof fetch;
    expect(await fetchDataFile('typechart', {cacheDir: tempDir(), fetchImpl})).toEqual({fire: raw.fire});
  });

  it.each(['坏 JSON', '旧版缓存', '过期', '错误 schema', '错误来源', '未来时间'])('缓存%s 时重新获取', async kind => {
    const cacheDir = tempDir();
    const cache = {version: 1, name: 'moves', sourceUrl: `${official}/moves.js`, fetchedAt: Date.now(), raw: js};
    if (kind === '过期') cache.fetchedAt -= 24 * 60 * 60 * 1000 + 1;
    if (kind === '未来时间') cache.fetchedAt += 60_000;
    if (kind === '错误来源') cache.sourceUrl = 'https://untrusted.invalid/moves.js';
    if (kind === '错误 schema') cache.raw = 'exports.BattleMovedex = {bad: null};';
    fs.writeFileSync(path.join(cacheDir, 'moves.json'), kind === '坏 JSON' ? '{bad' : JSON.stringify(kind === '旧版缓存' ? moves : cache));
    const fetchImpl = vi.fn(async () => new Response(js)) as typeof fetch;
    expect(await fetchDataFile('moves', {cacheDir, fetchImpl})).toEqual(moves);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('过期缓存且网络不可用时不把旧数据当作新数据', async () => {
    const cacheDir = tempDir();
    fs.writeFileSync(path.join(cacheDir, 'moves.json'), JSON.stringify({version: 1, name: 'moves', sourceUrl: `${official}/moves.js`, fetchedAt: 1, raw: js}));
    const fetchImpl = vi.fn(async () => {throw new Error('离线');}) as typeof fetch;
    await expect(fetchDataFile('moves', {cacheDir, fetchImpl})).rejects.toThrow();
  });

  it('缓存目录不可写也返回已验证的线上结果', async () => {
    const cacheDir = path.join(tempDir(), 'not-a-directory');
    fs.writeFileSync(cacheDir, '占位');
    const fetchImpl = vi.fn(async () => new Response(js)) as typeof fetch;
    expect(await fetchDataFile('moves', {cacheDir, fetchImpl})).toEqual(moves);
  });

  it.each(['fetch', 'body'])('%s 无视 signal 挂起时仍硬超时并 abort', async stage => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => {started = resolve;});
    let signal: AbortSignal | undefined;
    const never = new Promise<Response>(() => {});
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      if (stage === 'fetch') {started(); return never;}
      return {ok: true, text: () => {started(); return new Promise<string>(() => {});}} as Response;
    }) as typeof fetch;
    const opts = {cacheDir: tempDir(), fetchImpl, timeoutMs: 100};
    const result = fetchDataFile('moves', opts);
    const assertion = expect(result).rejects.toThrow(/超时|timeout/i);
    await ready;
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('JS 与 JSON 回退及 body 共享总预算', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => {started = resolve;});
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      if (String(input).endsWith('.js')) {
        started();
        await new Promise(resolve => setTimeout(resolve, 60));
        return new Response('', {status: 503});
      }
      return {ok: true, text: () => new Promise<string>(() => {})} as Response;
    }) as typeof fetch;
    const opts = {cacheDir: tempDir(), fetchImpl, timeoutMs: 100};
    const result = fetchDataFile('moves', opts);
    const assertion = expect(result).rejects.toThrow(/超时|timeout/i);
    await ready;
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('外部取消结束挂起请求且不尝试回退', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => {started = resolve;});
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      started();
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const result = fetchDataFile('moves', {cacheDir: tempDir(), fetchImpl, ...{signal: controller.signal, timeoutMs: 100}});
    const assertion = expect(result).rejects.toThrow('用户取消');
    await ready;
    controller.abort(new Error('用户取消'));
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('倍率表过滤非属性行列', async () => {
    const fetchImpl = vi.fn(async () => new Response('exports.BattleTypeChart = {fire: {grass: 2, psn: 1}, fake: {water: 2}};')) as typeof fetch;
    expect(await fetchDataFile('typechart', {cacheDir: tempDir(), fetchImpl})).toEqual({fire: {grass: 2}});
  });

  it('JSON 回退原文与来源一起缓存，之后不再请求', async () => {
    const cacheDir = tempDir();
    const raw = JSON.stringify(moves);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('.js')
      ? new Response('', {status: 503}) : new Response(raw)) as typeof fetch;
    expect(await fetchDataFile('moves', {cacheDir, fetchImpl})).toEqual(moves);
    expect(await fetchDataFile('moves', {cacheDir, fetchImpl})).toEqual(moves);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(path.join(cacheDir, 'moves.json'), 'utf8')))
      .toMatchObject({sourceUrl: `${official}/moves.json`, raw});
  });

  it('JS 响应体读取异常也能回退 JSON', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('.js')
      ? {ok: true, text: async () => {throw new Error('读取失败');}} as unknown as Response : new Response(JSON.stringify(moves))) as typeof fetch;
    expect(await fetchDataFile('moves', {cacheDir: tempDir(), fetchImpl})).toEqual(moves);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('超时后的迟到响应不写缓存也不继续请求', async () => {
    vi.useFakeTimers();
    const cacheDir = tempDir();
    let started!: () => void;
    const ready = new Promise<void>(resolve => {started = resolve;});
    let finish!: (text: string) => void;
    const body = new Promise<string>(resolve => {finish = resolve;});
    const fetchImpl = vi.fn(async () => ({ok: true, text: () => {started(); return body;}} as Response)) as typeof fetch;
    const result = fetchDataFile('moves', {cacheDir, fetchImpl, timeoutMs: 100}).then(value => value, error => error);
    await ready;
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeInstanceOf(Error);
    finish(js);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(cacheDir, 'moves.json'))).toBe(false);
  });

  it('已有取消信号时不联网，过期绝对截止时间也不联网', async () => {
    const fetchImpl = vi.fn(async () => new Response(js)) as typeof fetch;
    const controller = new AbortController();
    controller.abort(new Error('已取消'));
    await expect(fetchDataFile('moves', {cacheDir: tempDir(), fetchImpl, signal: controller.signal})).rejects.toThrow('已取消');
    await expect(fetchDataFile('moves', {cacheDir: tempDir(), fetchImpl, deadlineAt: Date.now() - 1})).rejects.toThrow('超时');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([0, -1, Infinity, NaN])('非法预算 %s 不发起请求', async timeoutMs => {
    const fetchImpl = vi.fn(async () => new Response(js)) as typeof fetch;
    await expect(fetchDataFile('moves', {cacheDir: tempDir(), fetchImpl, timeoutMs})).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('拒绝任意文件名以防路径穿越', async () => {
    const fetchImpl = vi.fn(async () => new Response(js)) as typeof fetch;
    await expect(fetchDataFile('../moves', {cacheDir: tempDir(), fetchImpl})).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
