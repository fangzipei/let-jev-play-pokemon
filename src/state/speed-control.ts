import {toId} from './protocol.js';
import type {BattleState} from './tracker.js';

const TAILWIND_DURATION = 4; // moves.ts tailwind: duration 4（Persistent 变体为 6，本赛制不适用）
const TRICK_ROOM_DURATION = 5; // moves.ts trickroom: duration 5
const WEATHER_DURATION = 5;
const WEATHER_ROCK_DURATION = 8; // 岩石道具延长后的天气回合数

/** 天气下速度翻倍的特性 → 触发天气（toId 归一化） */
const WEATHER_SPEED_ABILITIES: Record<string, string[]> = {
  swiftswim: ['raindance'],
  chlorophyll: ['sunnyday'],
  sandrush: ['sandstorm'],
  slushrush: ['snowscape', 'snow', 'hail'],
};

export interface TimedCondition {
  started_turn: number;
  /** 含当前回合在内还会生效的回合数 = started_turn + duration - current_turn */
  turns_left: number;
}

export interface WeatherCondition extends TimedCondition {
  name: string;
  /** 是否被岩石道具延长（true/false 为已确认，null 为设置者道具未知） */
  extended: boolean | null;
}

export interface SpeedControl {
  trick_room: TimedCondition | null;
  our_tailwind: TimedCondition | null;
  opponent_tailwind: TimedCondition | null;
  weather: WeatherCondition | null;
  /** 对手已揭示且与当前天气联动的速度翻倍特性警告 */
  opponent_speed_abilities: string[];
}

function turnsLeft(started: number, duration: number, current: number): number {
  return Math.max(0, started + duration - current);
}

/** 该特性在当前天气下是否速度翻倍（toId 匹配） */
export function weatherDoublesSpeed(ability: string, weather: string | undefined): boolean {
  const w = toId(weather ?? '');
  return !!w && (WEATHER_SPEED_ABILITIES[toId(ability)]?.includes(w) ?? false);
}

function tailwindOf(state: BattleState, sideId: string): TimedCondition | null {
  const start = state.sides[sideId]?.sideConditionTurns['tailwind'];
  if (start === undefined) return null;
  const left = turnsLeft(start, TAILWIND_DURATION, state.turn);
  return left > 0 ? {started_turn: start, turns_left: left} : null;
}

/** 汇总双方顺风/空间/天气剩余回合与对手速度特性联动（只读派生，不修改 state） */
export function speedControlOf(state: BattleState, ourSideId?: string): SpeedControl {
  const ourId = ourSideId ?? state.ourSideId ?? 'p1';
  const oppId = ourId === 'p1' ? 'p2' : 'p1';

  const trStart = state.fieldConditionTurns['trickroom'];
  const trLeft = trStart === undefined ? 0 : turnsLeft(trStart, TRICK_ROOM_DURATION, state.turn);
  const trickRoom = trStart !== undefined && trLeft > 0 ? {started_turn: trStart, turns_left: trLeft} : null;

  let weather: WeatherCondition | null = null;
  const weatherName = state.weather;
  const weatherStart = state.weatherStartTurn;
  if (weatherName && weatherStart !== undefined) {
    const extended = state.weatherRock ?? null;
    const duration = extended === true ? WEATHER_ROCK_DURATION : WEATHER_DURATION;
    const left = turnsLeft(weatherStart, duration, state.turn);
    if (left > 0) weather = {name: weatherName, started_turn: weatherStart, turns_left: left, extended};
  }

  const opponentSpeedAbilities: string[] = [];
  if (weatherName) {
    for (const p of state.sides[oppId]?.pokemon ?? []) {
      if (!p.fainted && p.ability && weatherDoublesSpeed(p.ability, weatherName)) {
        opponentSpeedAbilities.push(
          `Foe ${p.species} has ${p.ability}: its Speed is doubled while the current ${weatherName} is up`,
        );
      }
    }
  }

  return {
    trick_room: trickRoom,
    our_tailwind: tailwindOf(state, ourId),
    opponent_tailwind: tailwindOf(state, oppId),
    weather,
    opponent_speed_abilities: opponentSpeedAbilities,
  };
}

export function turnsPhrase(n: number): string {
  return `${n} more turn${n === 1 ? '' : 's'} including this one`;
}

/** 生成注入决策提示的控速摘要；无任何控速时返回 null（不注入空话） */
export function speedControlText(state: BattleState, ourSideId?: string): string | null {
  const control = speedControlOf(state, ourSideId);
  const clauses: string[] = [];
  if (control.trick_room) {
    clauses.push(
      `Trick Room is active with ${turnsPhrase(control.trick_room.turns_left)} (slower Pokemon act first within each priority bracket)`,
    );
  }
  if (control.opponent_tailwind) {
    clauses.push(
      `Foe-side Tailwind is active with ${turnsPhrase(control.opponent_tailwind.turns_left)} (foe Pokemon move at doubled Speed)`,
    );
  }
  if (control.our_tailwind) {
    clauses.push(
      `Your-side Tailwind is active with ${turnsPhrase(control.our_tailwind.turns_left)} (your Pokemon move at doubled Speed)`,
    );
  }
  if (control.weather) {
    const w = control.weather;
    const basis = w.extended === true
      ? '8-turn duration from an extending rock'
      : w.extended === false
        ? '5-turn duration'
        : '5-turn standard; up to 8 with an extending rock';
    clauses.push(`Weather: ${w.name} with ${turnsPhrase(w.turns_left)} (${basis})`);
  }
  clauses.push(...control.opponent_speed_abilities);
  if (clauses.length === 0) return null;
  return `Speed control — ${clauses.join('. ')}.`;
}
