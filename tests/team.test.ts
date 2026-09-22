import {describe, expect, it} from 'vitest';
import {loadTeamPaste, packTeam, stripMegaSuffix, unpackSpeciesIds} from '../src/ps/team.js';

const paste = loadTeamPaste('team.txt');

describe('packTeam', () => {
  it('打包出 6 只并以 golisopodmega||Golisopite 开头', () => {
    const {packed, hasMegaFormSpecies} = packTeam(paste);
    expect(hasMegaFormSpecies).toBe(true);
    expect(packed.split(']').length).toBe(6);
    // 本地包 Dex 不认识 Champions 专属的 Golisopod-Mega/Golisopite：物种段被归一化为 id 形式
    // （第二段 speciesId 为空、回退首段），道具段保留原文。最终线上合法性由 Task 18 validate-team 验证。
    expect(packed.startsWith('golisopodmega||Golisopite|')).toBe(true);
  });

  it('物种顺序与 paste 一致', () => {
    const {packed} = packTeam(paste);
    expect(unpackSpeciesIds(packed)).toEqual([
      'golisopodmega', 'tyranitar', 'chandelure', 'excadrill', 'salamencemega', 'rotomwash',
    ]);
  });

  it('空 paste 抛错', () => {
    expect(() => packTeam('')).toThrow();
  });
});

describe('stripMegaSuffix', () => {
  it('把 -Mega 物种回退成基础形态并保留道具', () => {
    const stripped = stripMegaSuffix(paste);
    expect(stripped).toContain('Golisopod @ Golisopite');
    expect(stripped).toContain('Salamence @ Salamencite');
    expect(stripped).not.toContain('-Mega');
  });
});
