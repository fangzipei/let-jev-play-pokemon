import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {BattleTracker} from '../src/state/tracker.js';

function feed(fixture: string, ourName: string): BattleTracker {
  const tracker = new BattleTracker('battle-gen9championsvgc2026regmc-1', ourName);
  for (const line of fixture.split(/\r?\n/).filter(l => l.trim().length > 0)) tracker.handleLine(line);
  return tracker;
}

const fixture = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'champions-mc-replay.log'),
  'utf8',
);

describe('BattleTracker', () => {
  it('识别我方阵营与玩家名', () => {
    const t = feed(fixture, 'TestBot');
    expect(t.state.ourSideId).toBe('p1');
    expect(t.state.sides.p2.name).toBe('TestFoe');
  });

  it('preview 6 只 + teamsize 4', () => {
    const t = feed(fixture, 'TestBot');
    expect(t.state.sides.p2.pokemon.length).toBeGreaterThanOrEqual(6);
    expect(t.state.sides.p2.teamSize).toBe(4);
  });

  it('Mega 进化更新形态与标记', () => {
    const t = feed(fixture, 'TestBot');
    const victreebel = t.state.sides.p1.pokemon.find(p => p.name === 'Victreebel')!;
    expect(victreebel.species).toBe('Victreebel-Mega');
    expect(victreebel.mega).toBe(true);
    const charizard = t.state.sides.p2.pokemon.find(p => p.name === 'Charizard')!;
    expect(charizard.species).toBe('Charizard-Mega-Y');
    expect(t.state.sides.p2.megaUsed).toBe(true);
  });

  it('血量/状态/濒死/后缀血量', () => {
    const t = feed(fixture, 'TestBot');
    const corviknight = t.state.sides.p1.pokemon.find(p => p.name === 'Corviknight')!;
    expect(corviknight.hp).toBe(72);
    expect(corviknight.hpPercent).toBe(72);
    const whimsicott = t.state.sides.p2.pokemon.find(p => p.name === 'Whimsicott')!;
    expect(whimsicott.fainted).toBe(true);
    const sneaslerP2 = t.state.sides.p2.pokemon.find(p => p.name === 'Sneasler')!;
    expect(sneaslerP2.fainted).toBe(true);
  });

  it('能力变化累计', () => {
    const t = feed(fixture, 'TestBot');
    const corviknight = t.state.sides.p1.pokemon.find(p => p.name === 'Corviknight')!;
    expect(corviknight.boosts.def).toBe(4);
  });

  it('天气、场地、side condition 生命周期', () => {
    const t = feed(fixture, 'TestBot');
    expect(t.state.weather).toBe('SunnyDay');
    expect(t.state.sides.p2.sideConditions).toEqual([]);
  });

  it('揭示招式与回合数、胜负', () => {
    const t = feed(fixture, 'TestBot');
    const charizard = t.state.sides.p2.pokemon.find(p => p.name === 'Charizard')!;
    expect(charizard.revealedMoves).toContain('Heat Wave');
    expect(t.state.turn).toBe(6);
    expect(t.state.winner).toBe('TestBot');
    expect(t.state.ended).toBe(true);
  });

  it('场上位置随换人更新', () => {
    const t = feed(fixture, 'TestBot');
    const kal = t.state.sides.p1.pokemon.find(p => p.name === 'Kingambit');
    const p1Active = t.state.sides.p1.pokemon.filter(p => p.activePos >= 0).map(p => p.name).sort();
    expect(p1Active).toEqual(['Corviknight', 'Sableye']);
    expect(kal?.activePos ?? -1).toBe(-1);
  });
});
