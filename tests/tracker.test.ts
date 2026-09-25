import {describe, expect, it} from 'vitest';
import {BattleTracker} from '../src/state/tracker.js';

/** 回放协议样本：玩家名、rating 与 battle id 均为虚拟值 */
const replay = `|gametype|doubles
|player|p1|TestBot|blue|1000
|player|p2|TestFoe|red|1000
|gen|9
|tier|[Gen 9 Champions] VGC 2026 Reg M-C
|rated|
|rule|Species Clause: Limit one of each Pokémon
|rule|Item Clause: Limit 1 of each item
|clearpoke
|poke|p1|Victreebel, L50, M|
|poke|p1|Corviknight, L50, F|
|poke|p1|Sneasler, L50, M|
|poke|p1|Sableye, L50, M|
|poke|p1|Kingambit, L50, F|
|poke|p1|Raichu, L50, F|
|poke|p2|Charizard, L50, M|
|poke|p2|Basculegion, L50, M|
|poke|p2|Whimsicott, L50, F|
|poke|p2|Metagross, L50|
|poke|p2|Kingambit, L50, F|
|poke|p2|Sneasler, L50, F|
|teampreview|4
|teamsize|p1|4
|teamsize|p2|4
|start
|switch|p1a: Victreebel|Victreebel, L50, M|100/100
|switch|p1b: Sneasler|Sneasler, L50, M|100/100
|switch|p2a: Whimsicott|Whimsicott, L50, F|100/100
|switch|p2b: Sneasler|Sneasler, L50, F|100/100
|turn|1
|switch|p2b: Charizard|Charizard, L50, M|100/100
|detailschange|p1a: Victreebel|Victreebel-Mega, L50, M
|-mega|p1a: Victreebel|Victreebel|Victreebelite
|move|p1b: Sneasler|Protect|p1b: Sneasler
|-singleturn|p1b: Sneasler|Protect
|move|p2a: Whimsicott|Tailwind|p2a: Whimsicott
|-sidestart|p2: TestFoe|move: Tailwind
|move|p1a: Victreebel|Sludge Bomb|p2a: Whimsicott
|-supereffective|p2a: Whimsicott|2
|-enditem|p2a: Whimsicott|Focus Sash
|-damage|p2a: Whimsicott|1/100
|-status|p2a: Whimsicott|psn
|-damage|p2a: Whimsicott|0 fnt|[from] psn
|faint|p2a: Whimsicott
|upkeep
|switch|p2a: Sneasler|Sneasler, L50, F|100/100
|turn|2
|detailschange|p2b: Charizard|Charizard-Mega-Y, L50, M
|-mega|p2b: Charizard|Charizard|Charizardite Y
|-weather|SunnyDay|[from] ability: Drought|[of] p2b: Charizard
|move|p1a: Victreebel|Sucker Punch|p2b: Charizard
|-damage|p2b: Charizard|76/100
|move|p2a: Sneasler|Dire Claw|p1b: Sneasler
|-resisted|p1b: Sneasler|1
|-crit|p1b: Sneasler
|-damage|p1b: Sneasler|35/100
|-damage|p2a: Sneasler|90/100|[from] item: Life Orb
|move|p2b: Charizard|Heat Wave|p1b: Sneasler|[spread] p1a,p1b
|-supereffective|p1a: Victreebel|1
|-damage|p1a: Victreebel|0 fnt
|-damage|p1b: Sneasler|0 fnt
|-damage|p2b: Charizard|0 fnt|[from] ability: Innards Out|[of] p1a: Victreebel
|faint|p1a: Victreebel
|faint|p1b: Sneasler
|faint|p2b: Charizard
|-weather|SunnyDay|[upkeep]
|upkeep
|switch|p1b: Corviknight|Corviknight, L50, F|100/100
|switch|p2b: Kingambit|Kingambit, L50, F|100/100
|switch|p1a: Sableye|Sableye, L50, M|100/100
|turn|3
|move|p1a: Sableye|Encore|p2a: Sneasler
|-start|p2a: Sneasler|Encore
|move|p2a: Sneasler|Dire Claw|p1b: Corviknight
|-immune|p1b: Corviknight
|move|p2b: Kingambit|Kowtow Cleave|p1b: Corviknight
|-damage|p1b: Corviknight|67/100
|move|p1b: Corviknight|Iron Defense|p1b: Corviknight
|-boost|p1b: Corviknight|def|2
|-weather|SunnyDay|[upkeep]
|-heal|p1b: Corviknight|73/100|[from] item: Leftovers
|upkeep
|turn|4
|move|p2a: Sneasler|Dire Claw|p1a: Sableye|[miss]
|-miss|p2a: Sneasler|p1a: Sableye
|move|p2b: Kingambit|Kowtow Cleave|p1a: Sableye
|-damage|p1a: Sableye|27/100
|move|p1b: Corviknight|Iron Defense|p1b: Corviknight
|-boost|p1b: Corviknight|def|2
|move|p1a: Sableye|Foul Play|p2a: Sneasler
|-resisted|p2a: Sneasler|1
|-damage|p2a: Sneasler|50/100g
|-weather|SunnyDay|[upkeep]
|-heal|p1b: Corviknight|79/100|[from] item: Leftovers
|-sideend|p2: TestFoe|move: Tailwind
|upkeep
|turn|5
|move|p1a: Sableye|Protect|p1a: Sableye
|-singleturn|p1a: Sableye|Protect
|move|p2a: Sneasler|Dire Claw|p1a: Sableye
|-activate|p1a: Sableye|move: Protect
|move|p1b: Corviknight|Brave Bird|p2a: Sneasler
|-supereffective|p2a: Sneasler|1
|-damage|p2a: Sneasler|0 fnt
|faint|p2a: Sneasler
|-damage|p1b: Corviknight|66/100|[from] Recoil
|move|p2b: Kingambit|Kowtow Cleave|p1a: Sableye
|-activate|p1a: Sableye|move: Protect
|-weather|SunnyDay|[upkeep]
|-heal|p1b: Corviknight|72/100|[from] item: Leftovers
|upkeep
|turn|6
|-message|TestFoe forfeited.
|win|TestBot`;

function feed(replayLog: string, ourName: string): BattleTracker {
  const tracker = new BattleTracker('battle-gen9championsvgc2026regmc-1', ourName);
  for (const line of replayLog.split(/\r?\n/).filter(l => l.trim().length > 0)) tracker.handleLine(line);
  return tracker;
}

describe('BattleTracker', () => {
  it('识别我方阵营与玩家名', () => {
    const t = feed(replay, 'TestBot');
    expect(t.state.ourSideId).toBe('p1');
    expect(t.state.sides.p2.name).toBe('TestFoe');
  });

  it('preview 6 只 + teamsize 4', () => {
    const t = feed(replay, 'TestBot');
    expect(t.state.sides.p2.pokemon.length).toBeGreaterThanOrEqual(6);
    expect(t.state.sides.p2.teamSize).toBe(4);
  });

  it('Mega 进化更新形态与标记', () => {
    const t = feed(replay, 'TestBot');
    const victreebel = t.state.sides.p1.pokemon.find(p => p.name === 'Victreebel')!;
    expect(victreebel.species).toBe('Victreebel-Mega');
    expect(victreebel.mega).toBe(true);
    const charizard = t.state.sides.p2.pokemon.find(p => p.name === 'Charizard')!;
    expect(charizard.species).toBe('Charizard-Mega-Y');
    expect(t.state.sides.p2.megaUsed).toBe(true);
  });

  it('血量/状态/濒死/后缀血量', () => {
    const t = feed(replay, 'TestBot');
    const corviknight = t.state.sides.p1.pokemon.find(p => p.name === 'Corviknight')!;
    expect(corviknight.hp).toBe(72);
    expect(corviknight.hpPercent).toBe(72);
    const whimsicott = t.state.sides.p2.pokemon.find(p => p.name === 'Whimsicott')!;
    expect(whimsicott.fainted).toBe(true);
    const sneaslerP2 = t.state.sides.p2.pokemon.find(p => p.name === 'Sneasler')!;
    expect(sneaslerP2.fainted).toBe(true);
  });

  it('能力变化累计', () => {
    const t = feed(replay, 'TestBot');
    const corviknight = t.state.sides.p1.pokemon.find(p => p.name === 'Corviknight')!;
    expect(corviknight.boosts.def).toBe(4);
  });

  it('天气、场地、side condition 生命周期', () => {
    const t = feed(replay, 'TestBot');
    expect(t.state.weather).toBe('SunnyDay');
    expect(t.state.sides.p2.sideConditions).toEqual([]);
  });

  it('揭示招式与回合数、胜负', () => {
    const t = feed(replay, 'TestBot');
    const charizard = t.state.sides.p2.pokemon.find(p => p.name === 'Charizard')!;
    expect(charizard.revealedMoves).toContain('Heat Wave');
    expect(t.state.turn).toBe(6);
    expect(t.state.winner).toBe('TestBot');
    expect(t.state.ended).toBe(true);
  });

  it('|move| 记录最近招式与回合号（连续保护判定用）', () => {
    const t = feed(replay, 'TestBot');
    const sableye = t.state.sides.p1.pokemon.find(p => p.name === 'Sableye')!;
    expect(sableye.lastMoveId).toBe('Protect');
    expect(sableye.lastMoveTurn).toBe(5);
    const whimsicott = t.state.sides.p2.pokemon.find(p => p.name === 'Whimsicott')!;
    expect(whimsicott.lastMoveId).toBe('Tailwind');
    expect(whimsicott.lastMoveTurn).toBe(1);
  });

  it('场上位置随换人更新', () => {
    const t = feed(replay, 'TestBot');
    const kal = t.state.sides.p1.pokemon.find(p => p.name === 'Kingambit');
    const p1Active = t.state.sides.p1.pokemon.filter(p => p.activePos >= 0).map(p => p.name).sort();
    expect(p1Active).toEqual(['Corviknight', 'Sableye']);
    expect(kal?.activePos ?? -1).toBe(-1);
  });

  it('单回合保护（-singleturn/-activate）回合结束后不残留 volatile', () => {
    const t = new BattleTracker('battle-test', 'us');
    const lines = [
      '|player|p1|us|',
      '|player|p2|them|',
      '|switch|p1a: Excadrill|Excadrill, L50, M|187/187',
      '|switch|p2a: Whimsicott|Whimsicott, L50, F|187/187',
      '|turn|1',
      '|move|p1a: Excadrill|Protect|p1a: Excadrill',
      '|-singleturn|p1a: Excadrill|Protect',
      '|move|p2a: Whimsicott|Moonblast|p1a: Excadrill',
      '|-activate|p1a: Excadrill|move: Protect',
      '|turn|2',
    ];
    for (const line of lines) t.handleLine(line);
    const excadrill = t.state.sides.p1.pokemon.find(p => p.name === 'Excadrill')!;
    expect(excadrill.volatiles).toEqual([]);
    expect(excadrill.singleTurn).toEqual([]);
  });

  it('-activate 的 item/ability 瞬发事件不进入持久 volatile', () => {
    const t = new BattleTracker('battle-test', 'us');
    const lines = [
      '|player|p1|us|',
      '|switch|p1a: Excadrill|Excadrill, L50, M|187/187',
      '|turn|1',
      '|-activate|p1a: Excadrill|item: Focus Sash',
    ];
    for (const line of lines) t.handleLine(line);
    const excadrill = t.state.sides.p1.pokemon.find(p => p.name === 'Excadrill')!;
    expect(excadrill.volatiles).toEqual([]);
  });

  it('持久状态（-start 的 Taunt）跨回合保留，-end 后移除', () => {
    const t = new BattleTracker('battle-test', 'us');
    const lines = [
      '|player|p1|us|',
      '|switch|p1a: Excadrill|Excadrill, L50, M|187/187',
      '|turn|1',
      '|-start|p1a: Excadrill|move: Taunt',
      '|turn|2',
    ];
    for (const line of lines) t.handleLine(line);
    const excadrill = t.state.sides.p1.pokemon.find(p => p.name === 'Excadrill')!;
    expect(excadrill.volatiles).toEqual(['Taunt']);
    t.handleLine('|-end|p1a: Excadrill|move: Taunt');
    expect(excadrill.volatiles).toEqual([]);
  });

  it('side/field condition 记录激活回合，结束事件清除记录', () => {
    const mid = new BattleTracker('battle-test-mid', 'us');
    for (const line of [
      '|player|p1|us|', '|player|p2|them|',
      '|turn|1',
      '|-sidestart|p2: them|move: Tailwind',
      '|-fieldstart|move: Trick Room|[of] p1a: Chandelure',
      '|turn|2',
    ]) mid.handleLine(line);
    expect(mid.state.sides.p2.sideConditionTurns).toEqual({tailwind: 1});
    expect(mid.state.fieldConditionTurns).toEqual({trickroom: 1});
    mid.handleLine('|-sideend|p2: them|move: Tailwind');
    mid.handleLine('|-fieldend|move: Trick Room');
    expect(mid.state.sides.p2.sideConditions).toEqual([]);
    expect(mid.state.sides.p2.sideConditionTurns).toEqual({});
    expect(mid.state.fieldConditions).toEqual([]);
    expect(mid.state.fieldConditionTurns).toEqual({});
  });

  it('-swapsideconditions 同时互换激活回合记录', () => {
    const t = new BattleTracker('battle-test', 'us');
    for (const line of [
      '|player|p1|us|', '|player|p2|them|',
      '|turn|1',
      '|-sidestart|p1: us|move: Tailwind',
      '|turn|2',
      '|-swapsideconditions',
    ]) t.handleLine(line);
    expect(t.state.sides.p1.sideConditions).toEqual([]);
    expect(t.state.sides.p1.sideConditionTurns).toEqual({});
    expect(t.state.sides.p2.sideConditions).toEqual(['move: Tailwind']);
    expect(t.state.sides.p2.sideConditionTurns).toEqual({tailwind: 1});
  });

  it('天气记录激活回合与岩石延长判定；upkeep 不重置；none 清除', () => {
    const t = new BattleTracker('battle-test', 'us');
    for (const line of [
      '|player|p1|us|', '|player|p2|them|',
      '|switch|p2b: Tyranitar|Tyranitar, L50, M|100/100',
      '|-item|p2b: Tyranitar|Smooth Rock',
      '|turn|1',
      '|-weather|Sandstorm|[from] ability: Sand Stream|[of] p2b: Tyranitar',
    ]) t.handleLine(line);
    expect(t.state.weather).toBe('Sandstorm');
    expect(t.state.weatherStartTurn).toBe(1);
    expect(t.state.weatherRock).toBe(true);
    t.handleLine('|turn|2');
    t.handleLine('|-weather|Sandstorm|[upkeep]');
    expect(t.state.weatherStartTurn).toBe(1);
    t.handleLine('|turn|3');
    t.handleLine('|-weather|RainDance');
    expect(t.state.weather).toBe('RainDance');
    expect(t.state.weatherStartTurn).toBe(3);
    expect(t.state.weatherRock).toBeUndefined();
    t.handleLine('|-weather|none');
    expect(t.state.weather).toBeUndefined();
    expect(t.state.weatherStartTurn).toBeUndefined();
    expect(t.state.weatherRock).toBeUndefined();
  });

  it('岩石只延长对应天气；设置者道具未揭示时为未知', () => {
    const mismatched = new BattleTracker('battle-test-rock', 'us');
    for (const line of [
      '|player|p1|us|', '|player|p2|them|',
      '|switch|p2b: Politoed|Politoed, L50, M|100/100',
      '|-item|p2b: Politoed|Heat Rock',
      '|turn|1',
      '|-weather|RainDance|[from] ability: Drizzle|[of] p2b: Politoed',
    ]) mismatched.handleLine(line);
    expect(mismatched.state.weatherRock).toBe(false);
    const unknown = new BattleTracker('battle-test-unknown', 'us');
    for (const line of [
      '|player|p1|us|', '|player|p2|them|',
      '|turn|1',
      '|-weather|SunnyDay|[from] ability: Drought|[of] p2b: Torkoal',
    ]) unknown.handleLine(line);
    expect(unknown.state.weatherStartTurn).toBe(1);
    expect(unknown.state.weatherRock).toBeUndefined();
  });

  it('缺参数的 -sideend/-fieldend 不抛异常且不误删记录', () => {
    const t = new BattleTracker('battle-test-end', 'us');
    for (const line of [
      '|player|p1|us|', '|player|p2|them|',
      '|turn|1',
      '|-sidestart|p2: them|move: Tailwind',
    ]) t.handleLine(line);
    expect(() => t.handleLine('|-sideend|p2: them')).not.toThrow();
    expect(() => t.handleLine('|-fieldend')).not.toThrow();
    expect(t.state.sides.p2.sideConditions).toEqual(['move: Tailwind']);
    expect(t.state.sides.p2.sideConditionTurns).toEqual({tailwind: 1});
  });
});
