import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {fetchDataFile, parseDataJs} from '../src/dex/livedata.js';

describe('parseDataJs', () => {
  it('解析 exports.BattleXxx 形式', () => {
    const data = parseDataJs('exports.BattlePokedex = {"bulbasaur":{"name":"Bulbasaur"}};');
    expect((data as any).bulbasaur.name).toBe('Bulbasaur');
  });
  it('解析裸对象字面量', () => {
    const data = parseDataJs('{"fire":{"grass":2}}');
    expect((data as any).fire.grass).toBe(2);
  });
});

describe('fetchDataFile', () => {
  it('首次拉取并写缓存，第二次走缓存', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psdata-'));
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('exports.BattleMoves = {"tackle":{"name":"Tackle","type":"Normal"}};', {status: 200});
    }) as unknown as typeof fetch;
    const first = await fetchDataFile('moves', {cacheDir, fetchImpl});
    expect((first as any).tackle.name).toBe('Tackle');
    const second = await fetchDataFile('moves', {cacheDir, fetchImpl});
    expect((second as any).tackle.name).toBe('Tackle');
    expect(calls).toBe(1);
  });
});
