import type {Logger} from '../log/logger.js';
import type {Answer, DecisionsUsage, Question} from './types.js';

export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export interface JevClientOptions {
  apiKey: string;
  model: string;
  transport?: 'sdk' | 'fetch';
  timeoutMs?: number;
  retry?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  loadSdk?: () => Promise<unknown>;
  logger?: Logger;
}

export interface DecideInput {
  sessionId?: string;
  state: unknown;
  questions: Record<string, Question>;
}

export interface DecideResult {
  answers: Record<string, Answer>;
  usage: DecisionsUsage;
  latencyMs: number;
  raw: unknown;
}

export interface JevClient {
  decide(input: DecideInput): Promise<DecideResult>;
}

/** SDK 未安装/缺少 alpha.decisions.create 时抛出；客户端会改用 fetch 传输（对应 spec 不确定项 3） */
export class SdkUnavailableError extends Error {}

function parseResponse(raw: unknown): {answers: Record<string, Answer>; usage: DecisionsUsage} {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const answers = obj.answers as Record<string, Answer> | undefined;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error(`decisions 响应缺少 answers: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return {answers, usage: (obj.usage as DecisionsUsage | undefined) ?? {}};
}

export function createJevClient(opts: JevClientOptions): JevClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const loadSdk = opts.loadSdk ?? (() => import('@openrouter/sdk') as Promise<unknown>);
  const url = opts.baseUrl ?? DECISIONS_URL;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxRetries = Math.max(0, opts.retry ?? 1);
  let transport = opts.transport ?? 'sdk';

  async function callSdk(body: unknown): Promise<unknown> {
    let mod: any;
    try {
      mod = await loadSdk();
    } catch (err) {
      throw new SdkUnavailableError(`@openrouter/sdk 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    const OpenRouter = mod?.OpenRouter ?? mod?.default?.OpenRouter ?? mod?.default;
    if (typeof OpenRouter !== 'function') throw new SdkUnavailableError('@openrouter/sdk 导出中没有 OpenRouter 构造器');
    const client = new OpenRouter({apiKey: opts.apiKey});
    if (!client?.alpha?.decisions?.create) throw new SdkUnavailableError('@openrouter/sdk 缺少 alpha.decisions.create');
    return client.alpha.decisions.create({decisionsRequest: body});
  }

  async function callFetch(body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}`},
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`decisions API ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async decide(input: DecideInput): Promise<DecideResult> {
      const body: Record<string, unknown> = {
        model: opts.model,
        state: input.state,
        questions: input.questions,
      };
      if (input.sessionId) body.session_id = input.sessionId;
      const started = Date.now();
      let lastError: unknown = new Error('jev 决策失败：无可用的尝试');
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0 && Date.now() - started >= timeoutMs) break; // 总预算耗尽
        try {
          let raw: unknown;
          if (transport === 'sdk') {
            try {
              raw = await callSdk(body);
            } catch (err) {
              if (err instanceof SdkUnavailableError) {
                opts.logger?.warn(`${err.message}；改用 fetch 传输`);
                transport = 'fetch';
                raw = await callFetch(body);
              } else {
                throw err;
              }
            }
          } else {
            raw = await callFetch(body);
          }
          const {answers, usage} = parseResponse(raw);
          const latencyMs = Date.now() - started;
          opts.logger?.debug(`jev 决策完成（${Object.keys(answers).length} 个答案，${latencyMs}ms）`);
          return {answers, usage, latencyMs, raw};
        } catch (err) {
          lastError = err;
          opts.logger?.warn(
            `jev 调用失败（第 ${attempt + 1}/${maxRetries + 1} 次）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      throw lastError;
    },
  };
}
