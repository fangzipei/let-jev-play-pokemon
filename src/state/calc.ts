import type {DexData} from '../dex/index.js';
import {toId} from './protocol.js';

const TYPE_IDS = new Set('normal fire water electric grass ice fighting poison ground flying psychic bug rock ghost dragon dark steel fairy stellar'.split(' '));

/** 把任意视角的 typechart 归一化为 [攻击属性][防守属性] = 倍率 */
export function normalizeTypechart(raw: Record<string, unknown>): Record<string, Record<string, number>> {
  const encoded = Object.entries(raw).filter(([, row]) => row && typeof row === 'object' && 'damageTaken' in row);
  if (encoded.length) {
    return typechartFromDamageTaken(encoded.map(([name, row]) => ({
      name, damageTaken: (row as {damageTaken?: Record<string, number>}).damageTaken,
    })));
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [atk, row] of Object.entries(raw)) {
    if (!row || typeof row !== 'object') continue;
    out[toId(atk)] = {};
    for (const [def, v] of Object.entries(row as Record<string, unknown>)) {
      if (typeof v === 'number') out[toId(atk)][toId(def)] = v;
    }
  }
  if (out['fire']?.['grass'] === 2) return out;
  if (out['grass']?.['fire'] === 2) {
    const flipped: Record<string, Record<string, number>> = {};
    for (const [defType, row] of Object.entries(out)) {
      for (const [atkType, v] of Object.entries(row)) {
        (flipped[atkType] ??= {})[defType] = v;
      }
    }
    return flipped;
  }
  return out;
}

/** 官方防守方编码：0 普通、1 弱、2 抗、3 免疫；非属性键（如 psn）不参与克制。 */
export function typechartFromDamageTaken(types: Array<{name: string; damageTaken?: Record<string, number>}>): Record<string, Record<string, number>> {
  const chart: Record<string, Record<string, number>> = {};
  const multipliers = [1, 2, 0.5, 0];
  for (const def of types) {
    if (!TYPE_IDS.has(toId(def.name))) continue;
    for (const [atk, code] of Object.entries(def.damageTaken ?? {})) {
      if (!TYPE_IDS.has(toId(atk)) || !Number.isInteger(code) || code < 0 || code > 3) continue;
      (chart[toId(atk)] ??= {})[toId(def.name)] = multipliers[code];
    }
  }
  return chart;
}

export function effectiveness(dex: DexData, moveType: string, defenderTypes: string[]): number {
  const row = dex.typechart[toId(moveType)];
  if (!row) return 1;
  let mult = 1;
  for (const t of defenderTypes) {
    const v = row[toId(t)];
    if (v !== undefined) mult *= v;
  }
  return mult;
}

/** 稀疏倍率表的缺省项是中性；整行或物种属性缺失则不能推断。 */
export function knownEffectiveness(dex: DexData, moveType: string, defenderTypes: string[]): number | null {
  const row = dex.typechart[toId(moveType)];
  if (!row || !Object.keys(row).length || !defenderTypes.length ||
      !TYPE_IDS.has(toId(moveType)) || defenderTypes.some(t => !TYPE_IDS.has(toId(t)))) return null;
  return effectiveness(dex, moveType, defenderTypes);
}

/**
 * 气象球的有效属性：晴天 Fire、雨天 Water、沙暴 Rock、雪/冰雹 Ice。
 * 无天气或其他招式时返回原属性；天气下的威力翻倍由 estimateDamagePercent 处理。
 */
export function weatherAdjustedType(moveId: string, moveType: string, weather: string | undefined): string {
  if (toId(moveId) !== 'weatherball' || !weather) return moveType;
  if (/sun/i.test(weather)) return 'Fire';
  if (/rain/i.test(weather)) return 'Water';
  if (/sand/i.test(weather)) return 'Rock';
  if (/snow|hail/i.test(weather)) return 'Ice';
  return moveType;
}

/** 入场即造天气的特性 → 天气词；用于预览/对位时推定该宝可梦自造天气下的气象球属性 */
const ENTRY_WEATHER: Record<string, string> = {
  drought: 'Sun', drizzle: 'Rain', sandstream: 'Sandstorm', snowwarning: 'Snow',
};

export function entryWeatherOf(pokemon: {ability?: string; baseAbility?: string}): string | undefined {
  return ENTRY_WEATHER[toId(pokemon.ability ?? '')] ?? ENTRY_WEATHER[toId(pokemon.baseAbility ?? '')];
}

export interface DamageEstimateInput {
  dex: DexData;
  moveId: string;
  attackerTypes: string[];
  attackerStats?: Record<string, number>;
  defenderSpecies: string;
  isSpread?: boolean;
  weather?: string;
  /** 覆盖招式基础威力（如 Last Respects 按已阵亡队友数成长） */
  powerOverride?: number;
}

/**
 * 粗估伤害（绝对数值不保证精确，只用于相对比较）。
 * 简单公式：BP × 攻方系数 × 克制 × STAB × spread × 天气，再按守方种族值换算成 HP 百分比。
 */
export function estimateDamagePercent(input: DamageEstimateInput): number | null {
  const move = input.dex.moves[toId(input.moveId)];
  const def = input.dex.species[toId(input.defenderSpecies)];
  if (!move || !def) return null;
  const basePower = input.powerOverride ?? move.basePower;
  if (!basePower || basePower <= 0) return null;
  // 气象球随天气改属性并在有天气时威力翻倍（50 → 100）
  const moveType = weatherAdjustedType(input.moveId, move.type, input.weather);
  const power = moveType === move.type ? basePower : basePower * 2;
  const eff = knownEffectiveness(input.dex, moveType, def.types);
  if (eff === null) return null;
  if (eff === 0) return 0;
  const stab = input.attackerTypes.some(t => toId(t) === toId(moveType)) ? 1.5 : 1;
  const offStat = (move.category === 'Physical' ? input.attackerStats?.atk : input.attackerStats?.spa) ?? 150;
  const defStat = (move.category === 'Physical' ? def.baseStats.def : def.baseStats.spd) ?? 100;
  const spread = input.isSpread ? 0.75 : 1;
  const weather = weatherModifier(input.weather, moveType);
  const raw = power * (offStat / 150) * eff * stab * spread * weather;
  const pct = (raw * 100) / (defStat * 2 + 80);
  return Math.max(1, Math.min(150, Math.round(pct)));
}

function weatherModifier(weather: string | undefined, moveType: string): number {
  if (!weather) return 1;
  if (/sun/i.test(weather)) {
    if (moveType === 'Fire') return 1.5;
    if (moveType === 'Water') return 0.5;
  }
  if (/rain/i.test(weather)) {
    if (moveType === 'Water') return 1.5;
    if (moveType === 'Fire') return 0.5;
  }
  return 1;
}

export function speedNote(dex: DexData, ourSpecies: string, ourSpeed: number | undefined, oppSpecies: string): string {
  const oppBase = dex.species[toId(oppSpecies)]?.baseStats.spe;
  if (ourSpeed == null || !Number.isFinite(ourSpeed) || oppBase == null || !Number.isFinite(oppBase)) return '';
  return `${ourSpecies} estimated speed ${ourSpeed}; ${oppSpecies} base speed ${oppBase}, actual speed unknown; move order unknown`;
}
