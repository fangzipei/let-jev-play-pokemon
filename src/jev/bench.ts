/**
 * 模型速度基准核心：对决策（chat 传输）与 advisor 两条链路做重复计时与聚合，
 * 供 scripts/bench-models.ts 重放真实对局样本对比候选模型。纯逻辑无网络。
 */
import type {AdvisorClient} from './advisor.js';
import type {JevClient} from './client.js';
import type {Question} from './types.js';

export interface BenchSample {
  kind: 'team-preview' | 'turn' | 'force-switch';
  state: unknown;
  questions: Record<string, Question>;
}

export interface BenchAttempt {
  model: string;
  attempt: number;
  ok: boolean;
  /** 有耗时记录的尝试（成功或空文本）才有；被拒/超时无耗时 */
  latencyMs?: number;
  error?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface BenchSummary {
  model: string;
  attempts: number;
  ok: number;
  fail: number;
  /** 延迟统计计所有有耗时的记录（含空文本失败）；无任何耗时时为 undefined */
  minMs?: number;
  avgMs?: number;
  maxMs?: number;
  costTotal: number;
}

export function summarizeBench(model: string, attempts: BenchAttempt[]): BenchSummary {
  const latencies = attempts
    .map(attempt => attempt.latencyMs)
    .filter((ms): ms is number => ms !== undefined);
  return {
    model,
    attempts: attempts.length,
    ok: attempts.filter(attempt => attempt.ok).length,
    fail: attempts.filter(attempt => !attempt.ok).length,
    minMs: latencies.length ? Math.min(...latencies) : undefined,
    avgMs: latencies.length ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length) : undefined,
    maxMs: latencies.length ? Math.max(...latencies) : undefined,
    costTotal: attempts.reduce((sum, attempt) => sum + (attempt.cost ?? 0), 0),
  };
}

export async function benchDecision(
  model: string,
  client: JevClient,
  sample: BenchSample,
  repeat: number,
): Promise<BenchAttempt[]> {
  const attempts: BenchAttempt[] = [];
  for (let attempt = 1; attempt <= repeat; attempt++) {
    try {
      const result = await client.decide({state: sample.state, questions: sample.questions}, {});
      attempts.push({
        model,
        attempt,
        ok: true,
        latencyMs: result.latencyMs,
        cost: result.usage.cost,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      });
    } catch (error) {
      attempts.push({model, attempt, ok: false, error: error instanceof Error ? error.message : String(error)});
    }
  }
  return attempts;
}

export async function benchAdvisor(
  model: string,
  client: AdvisorClient,
  sample: BenchSample,
  repeat: number,
): Promise<BenchAttempt[]> {
  const attempts: BenchAttempt[] = [];
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const result = await client.analyze({kind: sample.kind, state: sample.state, questions: sample.questions}, {});
    if (result === null) {
      attempts.push({model, attempt, ok: false, error: 'advisor 未返回分析（超时或请求失败）'});
      continue;
    }
    const usage = {
      cost: result.usage.cost,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    };
    if (!result.text) {
      attempts.push({model, attempt, ok: false, latencyMs: result.latencyMs, error: 'advisor 返回空文本（仅用量）', ...usage});
    } else {
      attempts.push({model, attempt, ok: true, latencyMs: result.latencyMs, ...usage});
    }
  }
  return attempts;
}

/** 从 decisions.jsonl 的行数组取指定索引的决策记录作为重放样本 */
export function parseBenchSample(lines: string[], index: number): BenchSample {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new RangeError(`样本索引超出范围: ${index}（共 ${lines.length} 行）`);
  }
  const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
  const kind = parsed.kind;
  if (kind !== 'team-preview' && kind !== 'turn' && kind !== 'force-switch') {
    throw new Error(`重放样本缺少有效 kind（第 ${index} 行）`);
  }
  if (!parsed.questions || typeof parsed.questions !== 'object' || Array.isArray(parsed.questions)) {
    throw new Error(`重放样本缺少 questions（第 ${index} 行）`);
  }
  return {kind, state: parsed.state, questions: parsed.questions as Record<string, Question>};
}
