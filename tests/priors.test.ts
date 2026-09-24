import {describe, expect, it} from 'vitest';
import {priorEntryFor, type PriorEntry, type PriorMeta} from '../src/dex/priors.js';

function entry(over: Partial<PriorEntry> = {}): PriorEntry {
  return {items: [], abilities: [], moves: [], leads: [], ...over};
}

describe('priorEntryFor（来源无关的物种先验查询）', () => {
  it('按 toId 直接命中基础与连字符物种', () => {
    const meta: PriorMeta = {
      label: 'x',
      bySpecies: {
        rotomwash: entry({moves: [{name: 'Thunderbolt', percent: 33.3}]}),
        sneasler: entry(),
      },
    };
    expect(priorEntryFor(meta, 'Rotom-Wash')).toBe(meta.bySpecies.rotomwash);
    expect(priorEntryFor(meta, 'Sneasler')).toBe(meta.bySpecies.sneasler);
  });
  it('查询 Mega 形态而先验只有基础物种时去后缀回落', () => {
    const meta: PriorMeta = {
      label: 'x',
      bySpecies: {
        charizard: entry({items: [{name: 'Charizardite Y', percent: 51.2}]}),
        metagross: entry({abilities: [{name: 'Tough Claws', percent: 99}]}),
      },
    };
    expect(priorEntryFor(meta, 'Charizard-Mega-Y')?.items[0].name).toBe('Charizardite Y');
    expect(priorEntryFor(meta, 'Metagross-Mega')?.abilities[0].name).toBe('Tough Claws');
  });
  it('查询基础物种而先验只有 Mega 条目时加后缀兜底', () => {
    const meta: PriorMeta = {
      label: 'x',
      bySpecies: {metagrossmega: entry({items: [{name: 'Metagrossite', percent: 98}]})},
    };
    expect(priorEntryFor(meta, 'Metagross')?.items[0].name).toBe('Metagrossite');
  });
  it('未命中或空查询返回 null', () => {
    const meta: PriorMeta = {label: 'x', bySpecies: {sneasler: entry()}};
    expect(priorEntryFor(meta, 'Unknownmon')).toBeNull();
    expect(priorEntryFor({label: 'x', bySpecies: {}}, 'Sneasler')).toBeNull();
    expect(priorEntryFor(meta, '')).toBeNull();
  });
});
