import {describe, expect, it} from 'vitest';
import {effectiveness, estimateDamagePercent, normalizeTypechart, speedNote} from '../src/state/calc.js';
import {mkDex} from './helpers.js';

describe('normalizeTypechart', () => {
  it('识别进攻方视角', () => {
    const chart = normalizeTypechart({fire: {grass: 2, water: 0.5}});
    expect(chart.fire.grass).toBe(2);
  });
  it('识别防守方视角并转置', () => {
    const chart = normalizeTypechart({grass: {fire: 2}, water: {fire: 0.5}});
    expect(chart.fire.grass).toBe(2);
    expect(chart.fire.water).toBe(0.5);
  });
});

describe('effectiveness', () => {
  const dex = mkDex();
  it('双属性相乘', () => {
    expect(effectiveness(dex, 'Fire', ['Grass', 'Flying'])).toBe(2);
    expect(effectiveness(dex, 'Electric', ['Water', 'Flying'])).toBe(4);
  });
  it('免疫为 0', () => {
    expect(effectiveness(dex, 'Normal', ['Ghost'])).toBe(0);
    expect(effectiveness(dex, 'Electric', ['Ground'])).toBe(0);
  });
});

describe('estimateDamagePercent', () => {
  const dex = mkDex();
  it('克制伤害远高于被抵抗伤害', () => {
    const strong = estimateDamagePercent({
      dex, moveId: 'thunderbolt', attackerTypes: ['Electric'], attackerStats: {spa: 170},
      defenderSpecies: 'Gyarados',
    })!;
    const weak = estimateDamagePercent({
      dex, moveId: 'thunderbolt', attackerTypes: ['Electric'], attackerStats: {spa: 170},
      defenderSpecies: 'Excadrill',
    })!;
    expect(weak).toBe(0); // 电对地面免疫
    const neutral = estimateDamagePercent({
      dex, moveId: 'thunderbolt', attackerTypes: ['Electric'], attackerStats: {spa: 170},
      defenderSpecies: 'Charizard',
    })!;
    expect(strong).toBeGreaterThan(neutral); // 水/飞行 4x vs 火/飞行 2x
  });
  it('状态招式返回 null', () => {
    expect(estimateDamagePercent({dex, moveId: 'protect', attackerTypes: ['Fire'], defenderSpecies: 'Charizard'})).toBeNull();
  });
  it('未知物种返回 null', () => {
    expect(estimateDamagePercent({dex, moveId: 'thunderbolt', attackerTypes: ['Electric'], defenderSpecies: 'Missingno'})).toBeNull();
  });
});

describe('speedNote', () => {
  it('描述速度对比', () => {
    const note = speedNote(mkDex(), 'Chandelure', 100, 'Kingambit');
    expect(note).toContain('100');
    expect(note).toMatch(/first|second/);
  });
});
