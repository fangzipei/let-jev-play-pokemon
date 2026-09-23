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
  const power = input.powerOverride ?? move.basePower;
  if (!power || power <= 0) return null;
  const eff = knownEffectiveness(input.dex, move.type, def.types);
  if (eff === null) return null;
  if (eff === 0) return 0;
  const stab = input.attackerTypes.some(t => toId(t) === toId(move.type)) ? 1.5 : 1;
  const offStat = (move.category === 'Physical' ? input.attackerStats?.atk : input.attackerStats?.spa) ?? 150;
  const defStat = (move.category === 'Physical' ? def.baseStats.def : def.baseStats.spd) ?? 100;
  const spread = input.isSpread ? 0.75 : 1;
  const weather = weatherModifier(input.weather, move.type);
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
