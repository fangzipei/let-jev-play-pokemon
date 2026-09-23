import {describe, expect, it} from 'vitest';
import {speedControlOf, speedControlText} from '../src/state/speed-control.js';
import {BattleTracker} from '../src/state/tracker.js';
import {mkTracker} from './helpers.js';

/** 构造一段有双方控速 + 天气的对局状态：t1 对手顺风、t3 我方顺风/空间/沙暴，当前 t4 */
function withControls() {
  const tracker = mkTracker();
  for (const line of [
    '|-sidestart|p2: opponent|move: Tailwind',
    '|turn|3',
    '|-sidestart|p1: JevBot1234|move: Tailwind',
    '|-fieldstart|move: Trick Room|[of] p2a: Victreebel',
    '|-weather|Sandstorm|[of] p2b: Charizard',
    '|turn|4',
  ]) tracker.handleLine(line);
  return tracker;
}

describe('speedControlOf', () => {
  it('TR/双方顺风/天气的剩余回合按开始回合与时长计算', () => {
    const control = speedControlOf(withControls().state, 'p1');
    expect(control.trick_room).toEqual({started_turn: 3, turns_left: 4});
    expect(control.opponent_tailwind).toEqual({started_turn: 1, turns_left: 1});
    expect(control.our_tailwind).toEqual({started_turn: 3, turns_left: 3});
    expect(control.weather).toEqual({name: 'Sandstorm', started_turn: 3, turns_left: 4, extended: null});
    expect(control.opponent_speed_abilities).toEqual([]);
  });

  it('无激活条件时全部为 null/空', () => {
    expect(speedControlOf(mkTracker().state, 'p1')).toEqual({
      trick_room: null, our_tailwind: null, opponent_tailwind: null, weather: null, opponent_speed_abilities: [],
    });
  });

  it('岩石延长确认时天气按 8 回合计算；已确认非岩石按 5 回合', () => {
    const extended = mkTracker();
    extended.handleLine('|-item|p2b: Charizard|Smooth Rock');
    for (const line of ['|turn|2', '|-weather|Sandstorm|[of] p2b: Charizard', '|turn|4']) extended.handleLine(line);
    expect(speedControlOf(extended.state, 'p1').weather)
      .toEqual({name: 'Sandstorm', started_turn: 2, turns_left: 6, extended: true});
    const plain = mkTracker();
    plain.handleLine('|-item|p2b: Charizard|Leftovers');
    for (const line of ['|turn|2', '|-weather|Sandstorm|[of] p2b: Charizard']) plain.handleLine(line);
    expect(speedControlOf(plain.state, 'p1').weather)
      .toEqual({name: 'Sandstorm', started_turn: 2, turns_left: 5, extended: false});
    expect(speedControlText(plain.state, 'p1')).toContain('(5-turn duration)');
  });

  it('对手已揭示的天气速度特性与当前天气匹配时给出警告', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-ability|p2a: Victreebel|Chlorophyll');
    tracker.handleLine('|-weather|SunnyDay|[of] p2b: Charizard');
    const warnings = speedControlOf(tracker.state, 'p1').opponent_speed_abilities;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Victreebel/);
    expect(warnings[0]).toMatch(/Chlorophyll/);
    expect(warnings[0]).toMatch(/doubled/i);
  });

  it('特性与当前天气不匹配时不警告', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-ability|p2a: Victreebel|Chlorophyll');
    tracker.handleLine('|-weather|Sandstorm|[of] p2b: Charizard');
    expect(speedControlOf(tracker.state, 'p1').opponent_speed_abilities).toEqual([]);
  });

  it('首发天气（|turn|1 之前的 -weather）按第 1 回合起算并逐回合递减', () => {
    const tracker = new BattleTracker('battle-weather-lead', 'JevBot1234');
    for (const line of [
      '|player|p1|JevBot1234|1|1500', '|player|p2|opponent|2|1500',
      '|poke|p1|Golisopod, L50, M|', '|poke|p2|Pelipper, L50, M|',
      '|start',
      '|switch|p1a: Golisopod|Golisopod, L50, M|150/150',
      '|switch|p2a: Pelipper|Pelipper, L50, M|100/100',
      '|-weather|RainDance|[from] ability: Drizzle|[of] p2a: Pelipper',
      '|turn|1',
    ]) tracker.handleLine(line);
    expect(speedControlOf(tracker.state, 'p1').weather)
      .toEqual({name: 'RainDance', started_turn: 1, turns_left: 5, extended: null});
    tracker.handleLine('|turn|5');
    expect(speedControlOf(tracker.state, 'p1').weather?.turns_left).toBe(1);
    tracker.handleLine('|turn|6');
    expect(speedControlOf(tracker.state, 'p1').weather).toBeNull();
  });

  it('雪天 Snowscape 匹配 Icy Rock 延长与 Slush Rush 警告', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-item|p2a: Victreebel|Icy Rock');
    tracker.handleLine('|-ability|p2b: Charizard|Slush Rush');
    tracker.handleLine('|turn|2');
    tracker.handleLine('|-weather|Snowscape|[of] p2a: Victreebel');
    const control = speedControlOf(tracker.state, 'p1');
    expect(control.weather).toEqual({name: 'Snowscape', started_turn: 2, turns_left: 8, extended: true});
    expect(control.opponent_speed_abilities.join(' ')).toMatch(/Slush Rush/);
    expect(speedControlText(tracker.state, 'p1'))
      .toContain('Weather: Snowscape with 8 more turns including this one (8-turn duration from an extending rock)');
  });

  it('已阵亡对手不再输出速度特性警告', () => {
    const tracker = mkTracker();
    tracker.handleLine('|-ability|p2a: Victreebel|Chlorophyll');
    tracker.handleLine('|-weather|SunnyDay');
    tracker.handleLine('|faint|p2a: Victreebel');
    expect(speedControlOf(tracker.state, 'p1').opponent_speed_abilities).toEqual([]);
  });
});

describe('speedControlText', () => {
  it('汇总双方控速与天气剩余回合及作用说明', () => {
    const text = speedControlText(withControls().state, 'p1');
    expect(text).toContain('Speed control');
    expect(text).toContain('Trick Room is active with 4 more turns including this one');
    expect(text).toMatch(/slower Pokemon act first/);
    expect(text).toContain('Foe-side Tailwind is active with 1 more turn including this one');
    expect(text).toMatch(/foe Pokemon move at doubled Speed/);
    expect(text).toContain('Your-side Tailwind is active with 3 more turns including this one');
    expect(text).toContain('Weather: Sandstorm with 4 more turns including this one');
    expect(text).toContain('(5-turn standard; up to 8 with an extending rock)');
  });

  it('无任何控速时返回 null，不注入空话', () => {
    expect(speedControlText(mkTracker().state, 'p1')).toBeNull();
  });

  it('对手速度特性警告并入文本', () => {
    const tracker = withControls();
    tracker.handleLine('|-ability|p2a: Victreebel|Chlorophyll');
    tracker.handleLine('|-weather|SunnyDay');
    const text = speedControlText(tracker.state, 'p1');
    expect(text).toMatch(/Chlorophyll/);
    expect(text).toMatch(/SunnyDay/);
  });
});
