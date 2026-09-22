import {describe, expect, it} from 'vitest';
import {hpPercent, parseCondition, parseDetails, parseIdent, parseLine} from '../src/state/protocol.js';

describe('parseLine', () => {
  it('拆分类型与参数', () => {
    const line = parseLine('|switch|p1a: Victreebel|Victreebel, L50, M|100/100');
    expect(line).toEqual({
      type: 'switch',
      args: ['p1a: Victreebel', 'Victreebel, L50, M', '100/100'],
      raw: '|switch|p1a: Victreebel|Victreebel, L50, M|100/100',
    });
  });

  it('非协议行返回 null', () => {
    expect(parseLine('some raw text')).toBeNull();
  });

  it('空参数保留（|-weather||[upkeep] 之类）', () => {
    const line = parseLine('|-weather|SunnyDay|[upkeep]');
    expect(line?.type).toBe('-weather');
    expect(line?.args).toEqual(['SunnyDay', '[upkeep]']);
  });
});

describe('parseIdent', () => {
  it('解析 p1a / p2b', () => {
    expect(parseIdent('p1a: Victreebel')).toEqual({side: 'p1', pos: 'a', name: 'Victreebel'});
    expect(parseIdent('p2: TestFoe')).toEqual({side: 'p2', pos: 'a', name: 'TestFoe'});
    expect(parseIdent('not-an-ident')).toBeNull();
  });
});

describe('parseDetails', () => {
  it('解析形态/等级/性别', () => {
    expect(parseDetails('Salamence-Mega, L50, M')).toEqual({species: 'Salamence-Mega', level: 50, gender: 'M'});
    expect(parseDetails('Rotom-Wash, L50')).toEqual({species: 'Rotom-Wash', level: 50, gender: undefined});
  });
});

describe('parseCondition', () => {
  it('普通血量', () => {
    expect(parseCondition('100/100')).toMatchObject({hp: 100, maxhp: 100, status: null, suffix: '', fainted: false});
  });
  it('带异常状态', () => {
    expect(parseCondition('35/100 brn')).toMatchObject({hp: 35, maxhp: 100, status: 'brn', fainted: false});
  });
  it('带后缀字母（Champions 百分比显示）', () => {
    expect(parseCondition('50/100g')).toMatchObject({hp: 50, maxhp: 100, suffix: 'g', status: null});
  });
  it('濒死', () => {
    expect(parseCondition('0 fnt')).toMatchObject({hp: 0, status: 'fnt', fainted: true});
  });
});

describe('hpPercent', () => {
  it('取整并夹在 0-100', () => {
    expect(hpPercent(1, 3)).toBe(33);
    expect(hpPercent(0, 150)).toBe(0);
    expect(hpPercent(150, 150)).toBe(100);
  });
});
