import type {Answer} from '../jev/types.js';

export interface ResolvedChoice {
  key: string;
  confidence: number;
  /** 是否因为原答案非法而改用 probabilities 中的次优项 */
  adjusted: boolean;
}

/**
 * 把 jev 的 choice 答案映射到合法选项 key。
 * - 原答案合法 → 直接返回
 * - 原答案非法 → 从 probabilities 里取概率最高的合法项（adjusted=true）
 * - 没有可用信息 → null（调用方用本地启发式补齐）
 */
export function resolveKey(answer: Answer | undefined, validKeys: string[]): ResolvedChoice | null {
  if (!answer || answer.type !== 'choice') return null;
  if (typeof answer.choice === 'string' && validKeys.includes(answer.choice)) {
    return {key: answer.choice, confidence: answer.confidence ?? 1, adjusted: false};
  }
  const probabilities = answer.probabilities ?? {};
  const ranked = Object.entries(probabilities)
    .filter(([key]) => validKeys.includes(key))
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  return {key: ranked[0][0], confidence: answer.confidence ?? 0, adjusted: true};
}
