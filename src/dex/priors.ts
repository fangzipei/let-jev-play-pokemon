/**
 * 统计先验的统一内部表示：pokechamdb 本地缓存与 Pikalytics 适配器产出同构数据，
 * 决策链路（opponent-notes）只消费 PriorMeta，不感知具体来源。
 */
import {toId} from '../state/protocol.js';

export interface PriorPair {
  name: string;
  percent: number;
  /** 英文效果说明（pokechamdb notes 提供；Pikalytics 无）。渲染在名称与占比后的方括号内。 */
  gloss?: string;
  /** 道具说明含 Mega Evolve 措辞时打标：日文名 Mega 石无法用英文 requiredItem 直接匹配。 */
  mega?: boolean;
}

export interface PriorEntry {
  items: PriorPair[];
  abilities: PriorPair[];
  moves: PriorPair[];
  leads: PriorPair[];
}

export interface PriorMeta {
  /** 来源与数据日期标签，如 `pokechamdb M-6 double 2026-09-24`；注解显示为 `(prior: <label>)`。 */
  label: string;
  bySpecies: Record<string, PriorEntry>;
}

/** 物种键匹配：原名 → 去 Mega 后缀 → 加 Mega 后缀（先验与查询双方 Mega 写法互为兜底）。 */
export function priorEntryFor(meta: PriorMeta, species: string): PriorEntry | null {
  const key = toId(species);
  const candidates = [key, key.replace(/mega[xy]?$/, ''), `${key}mega`];
  for (const candidate of candidates) {
    if (candidate && meta.bySpecies[candidate]) return meta.bySpecies[candidate];
  }
  return null;
}
