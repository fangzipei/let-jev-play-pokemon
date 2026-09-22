import type {DexData} from '../dex/index.js';
import {toId} from './protocol.js';

/** 把任意视角的 typechart 归一化为 [攻击属性][防守属性] = 倍率 */
export function normalizeTypechart(raw: Record<string, unknown>): Record<string, Record<string, number>> {
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

/** 从 PS Type.damageTaken（防守方视角：0 免疫 / 0.5 抗 / 1 普通 / 2 弱）构造攻击方视角表 */
export function typechartFromDamageTaken(types: Array<{name: string; damageTaken?: Record<string, number>}>): Record<string, Record<string, number>> {
  const chart: Record<string, Record<string, number>> = {};
  for (const def of types) {
    for (const [atk, v] of Object.entries(def.damageTaken ?? {})) {
      (chart[toId(atk)] ??= {})[toId(def.name)] = v;
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

export interface DamageEstimateInput {
  dex: DexData;
  moveId: string;
  attackerTypes: string[];
  attackerStats?: Record<string, number>;
  defenderSpecies: string;
  isSpread?: boolean;
  weather?: string;
}

/**
 * 粗估伤害（绝对数值不保证精确，只用于相对比较）。
 * 简单公式：BP × 攻方系数 × 克制 × STAB × spread × 天气，再按守方种族值换算成 HP 百分比。
 */
export function estimateDamagePercent(input: DamageEstimateInput): number | null {
  const move = input.dex.moves[toId(input.moveId)];
  const def = input.dex.species[toId(input.defenderSpecies)];
  if (!move || !def) return null;
  if (!move.basePower || move.basePower <= 0) return null;
  const eff = effectiveness(input.dex, move.type, def.types);
  if (eff === 0) return 0;
  const stab = input.attackerTypes.some(t => toId(t) === toId(move.type)) ? 1.5 : 1;
  const offStat = (move.category === 'Physical' ? input.attackerStats?.atk : input.attackerStats?.spa) ?? 150;
  const defStat = (move.category === 'Physical' ? def.baseStats.def : def.baseStats.spd) ?? 100;
  const spread = input.isSpread ? 0.75 : 1;
  const weather = weatherModifier(input.weather, move.type);
  const raw = move.basePower * (offStat / 150) * eff * stab * spread * weather;
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
  if (ourSpeed == null || oppBase == null) return '';
  return `speed ${ourSpeed} vs ${oppSpecies} ≈${oppBase}; ${ourSpeed > oppBase ? 'you move first' : 'you move second'}`;
}
