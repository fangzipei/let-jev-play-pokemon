import {megaFormsOf, type DexData} from '../dex/index.js';
import {toId} from './protocol.js';

const TYPE_ORDER = 'normal fire water electric grass ice fighting poison ground flying psychic bug rock ghost dragon dark steel fairy stellar'.split(' ');
const TYPE_IDS = new Set(TYPE_ORDER);

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

/** 该属性克制（≥2x）的防守属性列表，按属性表顺序；行数据缺失时返回空数组，不猜。 */
export function superEffectiveTypes(dex: DexData, moveType: string): string[] {
  const row = dex.typechart[toId(moveType)];
  if (!row || !Object.keys(row).length || !TYPE_IDS.has(toId(moveType))) return [];
  return TYPE_ORDER.filter(t => t !== 'stellar' && effectiveness(dex, moveType, [t]) >= 2)
    .map(t => t[0]!.toUpperCase() + t.slice(1));
}

/** 克制列表的可读短语（"Grass, Fighting and Bug"）；无数据时 null。 */
export function superEffectivePhrase(dex: DexData, moveType: string): string | null {
  const list = superEffectiveTypes(dex, moveType);
  if (!list.length) return null;
  return list.length === 1 ? list[0]! : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
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

/** -ate 皮肤特性：一般系招式转指定属性，威力 1.2x（PS onModifyType + onBasePower） */
const SKIN_TYPES: Record<string, string> = {
  aerilate: 'Flying', pixilate: 'Fairy', refrigerate: 'Ice', galvanize: 'Electric',
};

/**
 * 估算用招式属性与威力修正：气象球随天气改属性并翻倍（50 → 100），
 * -ate 特性把仍为一般系的招式转为其皮肤属性并给 1.2x 威力；两者不叠加。
 */
export function estimatedMove(moveId: string, moveType: string, weather: string | undefined,
  ability: string | undefined): {type: string; powerMultiplier: number} {
  const weatherType = weatherAdjustedType(moveId, moveType, weather);
  const multiplier = weatherType !== moveType ? 2 : 1;
  const skin = SKIN_TYPES[toId(ability ?? '')];
  if (skin && toId(weatherType) === 'normal') return {type: skin, powerMultiplier: multiplier * 1.2};
  return {type: weatherType, powerMultiplier: multiplier};
}

/** Mega 形态的 -ate 皮肤特性（Aerilate/Pixilate 等）；无 Mega 石、形态不匹配或特性数据缺失时 null */
export function megaSkinAbility(dex: DexData, species: string, item?: string): string | null {
  if (!item) return null;
  for (const form of megaFormsOf(dex, species)) {
    if (toId(form.requiredItem ?? '') !== toId(item)) continue;
    const skin = Object.values(form.abilities).map(toId).find(a => SKIN_TYPES[a]);
    if (skin) return skin;
  }
  return null;
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
  /** 攻击方当前特性：Adaptability 把本系加成提到 2.0x；-ate 皮肤（Aerilate 等）转换一般系招式属性并加 1.2x 威力 */
  attackerAbility?: string;
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
  // 气象球随天气改属性翻倍；-ate 皮肤把一般系招式转属性并加 1.2x 威力
  const {type: moveType, powerMultiplier} = estimatedMove(input.moveId, move.type, input.weather, input.attackerAbility);
  const power = basePower * powerMultiplier;
  const eff = knownEffectiveness(input.dex, moveType, def.types);
  if (eff === null) return null;
  if (eff === 0) return 0;
  const stab = input.attackerTypes.some(t => toId(t) === toId(moveType))
    ? (toId(input.attackerAbility ?? '') === 'adaptability' ? 2 : 1.5)
    : 1;
  const offStat = (move.category === 'Physical' ? input.attackerStats?.atk : input.attackerStats?.spa) ?? 150;
  const defStat = (move.category === 'Physical' ? def.baseStats.def : def.baseStats.spd) ?? 100;
  const spread = input.isSpread ? 0.75 : 1;
  const weather = weatherModifier(input.weather, moveType);
  const raw = power * (offStat / 150) * eff * stab * spread * weather;
  const pct = (raw * 100) / (defStat * 2 + 80);
  return Math.max(1, Math.min(150, Math.round(pct)));
}

/** 按出手时自身血量缩放威力的招式（PS basePowerCallback: power × hp / maxhp） */
const HP_SCALED_MOVES = new Set(['eruption', 'waterspout', 'dragonenergy']);

/**
 * 喷火/喷水/龙之能量在出手时的真实基础威力：floor(basePower × HP%)。
 * 表外招式或缺招式数据返回 null（调用方不应改写这些招式的威力）。
 */
export function hpScaledBasePower(dex: DexData, moveId: string, hpPercent: number): number | null {
  const id = toId(moveId);
  if (!HP_SCALED_MOVES.has(id)) return null;
  const move = dex.moves[id];
  if (!move || !move.basePower) return null;
  const hp = Math.min(100, Math.max(0, hpPercent));
  return Math.floor((move.basePower * hp) / 100);
}

/** 满投资中性性格速度档位（L50）：floor(floor((2*base+94)*0.5)+5)，与 speedtiers 实测一致 */
export function neutralSpeedTier(baseSpeed: number): number {
  return Math.floor((2 * baseSpeed + 94) / 2) + 5;
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
