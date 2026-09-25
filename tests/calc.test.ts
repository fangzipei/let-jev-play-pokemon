import {describe, expect, it} from 'vitest';
import {effectiveness, entryWeatherOf, estimateDamagePercent, hpScaledBasePower, neutralSpeedTier, normalizeTypechart, speedNote, typechartFromDamageTaken, weatherAdjustedType} from '../src/state/calc.js';
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

describe('官方属性编码', () => {
  const raw = {
    grass: {damageTaken: {Normal: 0, Fire: 1, Water: 2, psn: 3, sandstorm: 3}},
    ghost: {damageTaken: {Normal: 3}},
    flying: {damageTaken: {Ground: 3}},
    sandstorm: {damageTaken: {Fire: 1}},
  };
  it('0/1/2/3 转为 1/2/0.5/0，忽略状态和天气', () => {
    const chart = typechartFromDamageTaken(Object.entries(raw).map(([name, row]) => ({name, ...row})));
    expect(chart).toEqual({normal: {grass: 1, ghost: 0}, fire: {grass: 2}, water: {grass: 0.5}, ground: {flying: 0}});
  });
  it('线上嵌套 damageTaken 与本地 Type 数据使用相同转换', () => {
    expect(normalizeTypechart(raw)).toEqual({normal: {grass: 1, ghost: 0}, fire: {grass: 2}, water: {grass: 0.5}, ground: {flying: 0}});
  });
  it('粗估缺属性表时返回 unknown 而非中性伤害', () => {
    const dex = mkDex();
    dex.typechart = {};
    expect(estimateDamagePercent({dex, moveId: 'thunderbolt', attackerTypes: ['Electric'], defenderSpecies: 'Charizard'})).toBeNull();
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

describe('weatherAdjustedType（气象球随天气改属性）', () => {
  it.each([
    ['SunnyDay', 'Fire'],
    ['RainDance', 'Water'],
    ['Sandstorm', 'Rock'],
    ['Snow', 'Ice'],
    ['Hail', 'Ice'],
  ])('天气 %s 下气象球变为 %s', (weather, expected) => {
    expect(weatherAdjustedType('weatherball', 'Normal', weather)).toBe(expected);
  });
  it('无天气（或 none）时保持原属性', () => {
    expect(weatherAdjustedType('weatherball', 'Normal', undefined)).toBe('Normal');
    expect(weatherAdjustedType('weatherball', 'Normal', 'none')).toBe('Normal');
  });
  it('非气象球不受天气影响', () => {
    expect(weatherAdjustedType('eruption', 'Fire', 'SunnyDay')).toBe('Fire');
    expect(weatherAdjustedType('hydropump', 'Water', 'RainDance')).toBe('Water');
  });
});

describe('entryWeatherOf（入场天气特性）', () => {
  it('已知天气特性映射为天气词，其他特性为 undefined', () => {
    expect(entryWeatherOf({ability: 'drought'})).toBe('Sun');
    expect(entryWeatherOf({baseAbility: 'Drizzle'})).toBe('Rain');
    expect(entryWeatherOf({ability: 'sandstream'})).toBe('Sandstorm');
    expect(entryWeatherOf({ability: 'snowwarning'})).toBe('Snow');
    expect(entryWeatherOf({ability: 'intimidate'})).toBeUndefined();
    expect(entryWeatherOf({})).toBeUndefined();
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
  it('晴天下气象球按 100 BP 火属性结算，远超雨天与无天气', () => {
    const base = {dex, moveId: 'weatherball', attackerTypes: ['Fire'], attackerStats: {spa: 100}, defenderSpecies: 'Golisopod'};
    const sunny = estimateDamagePercent({...base, weather: 'SunnyDay'})!;
    const rainy = estimateDamagePercent({...base, weather: 'RainDance'})!;
    const bare = estimateDamagePercent(base)!;
    expect(sunny).toBeGreaterThan(rainy * 3);
    expect(sunny).toBeGreaterThan(bare * 10);
  });
  it('适应力特性把本系加成提升到 2.0x，非本系招式不受影响', () => {
    const base = {dex, moveId: 'ironhead', attackerTypes: ['Bug', 'Steel'], attackerStats: {atk: 180}, defenderSpecies: 'Metagross'};
    const normal = estimateDamagePercent(base)!;
    const adaptability = estimateDamagePercent({...base, attackerAbility: 'adaptability'})!;
    expect(adaptability).toBeGreaterThan(normal);
    expect(adaptability / normal).toBeGreaterThan(1.25);
    const offType = estimateDamagePercent({...base, moveId: 'drillrun'})!;
    expect(estimateDamagePercent({...base, moveId: 'drillrun', attackerAbility: 'adaptability'})).toBe(offType);
  });
  it('未知物种返回 null', () => {
    expect(estimateDamagePercent({dex, moveId: 'thunderbolt', attackerTypes: ['Electric'], defenderSpecies: 'Missingno'})).toBeNull();
  });
});

describe('hpScaledBasePower（喷火/喷水/龙之能量按自身血量缩放）', () => {
  const dex = mkDex();
  it('按当前血量等比缩放基础威力并向下取整', () => {
    expect(hpScaledBasePower(dex, 'eruption', 73)).toBe(109);
    expect(hpScaledBasePower(dex, 'waterspout', 50)).toBe(75);
    expect(hpScaledBasePower(dex, 'dragonenergy', 100)).toBe(150);
    expect(hpScaledBasePower(dex, 'eruption', 1)).toBe(1);
    expect(hpScaledBasePower(dex, 'eruption', 0)).toBe(0);
    expect(hpScaledBasePower(dex, 'eruption', 120)).toBe(150);
  });
  it('非缩放招式或缺招式数据返回 null', () => {
    expect(hpScaledBasePower(dex, 'heatwave', 50)).toBeNull();
    expect(hpScaledBasePower({...dex, moves: {}}, 'eruption', 50)).toBeNull();
  });
});

describe('neutralSpeedTier（中性满投资速度档位）', () => {
  it.each([
    [120, 172], [20, 72], [60, 112], [80, 132], [78, 130],
  ])('种族值 %i → %i', (base, tier) => {
    expect(neutralSpeedTier(base)).toBe(tier);
  });
});

describe('speedNote', () => {
  it('描述速度对比', () => {
    const note = speedNote(mkDex(), 'Chandelure', 100, 'Kingambit');
    expect(note).toContain('100');
    expect(note).toContain('base speed 50');
    expect(note).toContain('actual speed unknown');
    expect(note).not.toMatch(/you move first|you move second|outspeeds/i);
  });
});
