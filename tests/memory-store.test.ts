// tests/memory-store.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {coreKey, emptyMemory, loadMemory, mergeObservation, queryForOpponent, saveMemory} from '../src/learn/store.js';
import type {BattleObservation} from '../src/learn/extract.js';

function obs(partial: Partial<BattleObservation> = {}): BattleObservation {
  return {
    battleId: 'battle-1', won: true,
    ourSpecies: ['Golisopod', 'Tyranitar'],
    opponentSpecies: ['Rillaboom', 'Sneasler', 'Incineroar', 'Charizard', 'Whimsicott', 'Metagross'],
    opponentMegaSpecies: [],
    revealed: [
      {species: 'Sneasler', item: 'Grassy Seed', ability: 'Unburden', moves: ['Close Combat', 'Fake Out'], itemConsumed: false, led: true},
      {species: 'Rillaboom', moves: ['Grassy Glide'], itemConsumed: false, led: false},
    ],
    ...partial,
  };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
}

describe('mergeObservation', () => {
  it('按物种/配队关系累加计数并记录 processed', () => {
    const data = emptyMemory();
    mergeObservation(data, obs());
    const s = data.species.sneasler;
    expect(s).toMatchObject({name: 'Sneasler', seen: 1, wins: 1, losses: 0, leads: 1});
    expect(s.items['Grassy Seed']).toBe(1);
    expect(s.abilities.Unburden).toBe(1);
    expect(s.moves['Close Combat']).toBe(1);
    expect(data.species.rillaboom.items.unknown).toBe(1);
    expect(data.cores[coreKey('Rillaboom', 'Sneasler')]).toMatchObject({seen: 1, wins: 1, losses: 0});
    expect(Object.keys(data.cores)).toHaveLength(15);
    expect(data.processed['battle-1']).toBeTruthy();
  });
  it('同一 battleId 幂等，不重复累加', () => {
    const data = emptyMemory();
    mergeObservation(data, obs());
    const before = JSON.stringify(data.species);
    mergeObservation(data, obs());
    expect(JSON.stringify(data.species)).toBe(before);
  });
});

describe('queryForOpponent', () => {
  it('物种条摘要 top 道具/特性与观测数；组合条给胜负', () => {
    const data = emptyMemory();
    mergeObservation(data, obs());
    mergeObservation(data, obs({battleId: 'battle-2', won: false}));
    const q = queryForOpponent(data, ['Sneasler', 'Rillaboom', 'Unknownmon']);
    const lines = q.bySpecies.sneasler.join(' | ');
    expect(lines).toContain('Sneasler (2 battles seen)');
    expect(lines).toContain('Grassy Seed');
    expect(lines).toContain('Unburden');
    expect(q.bySpecies.unknownmon).toBeUndefined();
    expect(q.cores[0].key).toBe('rillaboom+sneasler');
    expect(q.cores.map(c => c.text).join(' ')).toContain('2 battles');
    expect(q.cores.map(c => c.text).join(' ')).toContain('1W-1L');
  });
  it('空库与 null 返回空结果；上限生效', () => {
    expect(queryForOpponent(null, ['Sneasler'])).toEqual({bySpecies: {}, cores: []});
    expect(queryForOpponent(emptyMemory(), ['Sneasler'])).toEqual({bySpecies: {}, cores: []});
  });
});

describe('loadMemory / saveMemory', () => {
  it('往返一致；损坏文件回退空库', async () => {
    const dir = await tmpDir();
    expect(await loadMemory(dir)).toEqual(emptyMemory());
    const data = emptyMemory();
    mergeObservation(data, obs());
    await saveMemory(dir, data);
    expect((await loadMemory(dir)).species.sneasler.seen).toBe(1);
    await fs.writeFile(path.join(dir, 'memory.json'), '{broken');
    expect(await loadMemory(dir)).toEqual(emptyMemory());
  });
});
