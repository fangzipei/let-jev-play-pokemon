import {describe, expect, it} from 'vitest';
import {
  buildStatePayload, describeMoveOption, describePreviewCandidate, describeSwitchOption, opponentActives,
} from '../src/state/serialize.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

const dex = mkDex();

describe('buildStatePayload', () => {
  it('包含双方关键信息', () => {
    const payload = buildStatePayload({state: mkTracker().state, request: mkRequest(), dex}) as any;
    expect(payload.turn).toBe(1);
    expect(payload.rules).toContain('pick 4');
    expect(payload.sides.ours.active[0].species).toBe('Golisopod');
    expect(payload.sides.ours.active[0].types).toEqual(['Bug', 'Steel']);
    expect(payload.sides.ours.bench.map((b: any) => b.species)).toEqual(['Tyranitar', 'Salamence']);
    expect(payload.sides.opponent.active.map((a: any) => a.species)).toEqual(['Victreebel', 'Charizard']);
    expect(payload.sides.opponent.active[1].hp_percent).toBe(92);
    expect(payload.sides.opponent.brought_count).toBe(4);
    expect(Array.isArray(payload.recent_log)).toBe(true);
  });
});

describe('opponentActives', () => {
  it('按参战位置排序并给出 Foe A/B 标签', () => {
    const actives = opponentActives(dex, mkTracker().state);
    expect(actives.map(a => a.label)).toEqual(['Foe A', 'Foe B']);
    expect(actives[0].species).toBe('Victreebel');
  });
});

describe('describeMoveOption', () => {
  it('单体招式描述含属性/PP/伤害估算与克制倍率', () => {
    const text = describeMoveOption({
      dex, moveId: 'ironhead', moveName: 'Iron Head', pp: 15, maxpp: 15,
      attackerTypes: ['Bug', 'Steel'], attackerStats: {atk: 180},
      target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100},
    });
    expect(text).toContain('Iron Head');
    expect(text).toContain('Steel');
    expect(text).toContain('PP 15/15');
    expect(text).toContain('Foe A');
    expect(text).toMatch(/≈\d+%/);
  });

  it('双体招式标注 spread', () => {
    const text = describeMoveOption({
      dex, moveId: 'heatwave', moveName: 'Heat Wave', pp: 10, maxpp: 10,
      attackerTypes: ['Ghost', 'Fire'], attackerStats: {spa: 190},
      target: {label: 'Foe A', species: 'Victreebel', hpPercent: 100}, hitsBoth: true,
    });
    expect(text).toContain('both foes');
    expect(text).toContain('2x');
  });

  it('状态招式标注无直接伤害', () => {
    const text = describeMoveOption({
      dex, moveId: 'trickroom', moveName: 'Trick Room', pp: 5, maxpp: 5, attackerTypes: ['Ghost'],
    });
    expect(text).toContain('status move');
  });
});

describe('describeSwitchOption', () => {
  it('含属性、HP、道具与对手已揭示招式的来袭伤害', () => {
    const request = mkRequest();
    const text = describeSwitchOption({
      dex,
      pokemon: request.side.pokemon[2], // Tyranitar
      opponentActives: opponentActives(dex, mkTracker().state),
    });
    expect(text).toContain('Tyranitar');
    expect(text).toContain('Rock/Dark');
    expect(text).toContain('175/175');
  });
});

describe('describePreviewCandidate', () => {
  it('含速度、招式与对对手的克制统计', () => {
    const request = mkRequest();
    const text = describePreviewCandidate({
      dex,
      pokemon: request.side.pokemon[0], // Golisopod
      opponentPreviewSpecies: ['Victreebel', 'Charizard', 'Kingambit', 'Whimsicott', 'Sneasler', 'Metagross'],
      megaCapable: true,
    });
    expect(text).toContain('Golisopod');
    expect(text).toContain('Bug/Steel');
    expect(text).toContain('Mega');
    expect(text).toMatch(/best:/);
  });
});
