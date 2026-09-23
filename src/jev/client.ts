import type {RequestOptions} from '@openrouter/sdk/lib/sdks.js';
import type {Logger} from '../log/logger.js';
import {CallCancelledError, DeadlineExceededError, withDeadline, type CallControl} from './deadline.js';
import type {Answer, DecisionsUsage, Question} from './types.js';

export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

// chat 传输：把 Decisions 协议翻译成 Chat Completions 的 JSON 契约（临时方案，仅支持 choice 题型）
const CHAT_DECISION_SYSTEM_PROMPT =
  'You are the decision engine of a Pokemon Showdown VGC doubles battle bot. ' +
  'The user message is JSON with "state" (the battle snapshot) and "questions" ' +
  '(each question has instructions and criteria; every criteria key is a legal option). ' +
  'For every question pick the best option given the state. ' +
  'Respond with ONLY a JSON object, no markdown fences, exactly shaped ' +
  '{"answers": {"<question_name>": {"type": "choice", "choice": "<option key>", "confidence": <0..1>, ' +
  '"probabilities": {"<option key>": <0..1>, ...}}}}. ' +
  '"choice" must be a criteria key of that question; "probabilities" must list every criteria key ' +
  'of that question and sum to about 1; "confidence" is your certainty in "choice". Answer every question.';

export interface JevClientOptions {
  apiKey: string;
  model: string;
  transport?: 'sdk' | 'fetch' | 'chat';
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
  decide(input: DecideInput, control?: CallControl): Promise<DecideResult>;
}

/** SDK 未安装/缺少 alpha.decisions.create 时抛出；客户端会改用 fetch 传输（对应 spec 不确定项 3） */
export class SdkUnavailableError extends Error {}

class DecisionsHttpError extends Error {
  /** bodySnippet：仅从 JSON 错误封套提取的白名单字段（error.message/code，截断）；非 JSON 原文不透传 */
  constructor(status: number, endpoint = 'decisions API', bodySnippet?: string) {
    super(`jev ${endpoint} HTTP ${status}${bodySnippet ? `: ${bodySnippet}` : ''}`);
  }
}

/** 白名单提取 OpenRouter 错误封套的 message/code 用于定位限流/供应商错误；
 *  非 JSON 正文、其他字段一律不透传（“远端原文不进日志”安全边界，见 tests/jev-client.test.ts） */
function errorBodySnippet(text: string): string | undefined {
  let parsed: {error?: {message?: unknown; code?: unknown}};
  try {
    parsed = JSON.parse(text) as {error?: {message?: unknown; code?: unknown}};
  } catch {
    return undefined;
  }
  const err = parsed?.error;
  if (!err || typeof err !== 'object' || Array.isArray(err)) return undefined;
  const message = typeof err.message === 'string' ? err.message.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  const code = err.code === undefined ? '' : String(err.code).slice(0, 40);
  if (message && code) return `${message}（code ${code}）`;
  return message || code || undefined;
}

// 显式禁止 SDK 通过 OPENROUTER_DEBUG 输出鉴权头与响应正文。
const silentSdkLogger = {log() {}, group() {}, groupEnd() {}};

/** SDK 返回 camelCase（inputTokens），REST 返回 snake_case（input_tokens），Chat 返回 prompt/completion_tokens；统一为 DecisionsUsage 的 snake_case */
function normalizeUsage(raw: unknown): DecisionsUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const usage: DecisionsUsage = {};
  const cost = num(u.cost);
  if (cost != null) usage.cost = cost;
  const input = num(u.input_tokens) ?? num(u.inputTokens) ?? num(u.prompt_tokens);
  if (input != null) usage.input_tokens = input;
  const output = num(u.output_tokens) ?? num(u.outputTokens) ?? num(u.completion_tokens);
  if (output != null) usage.output_tokens = output;
  return usage;
}

function parseResponse(raw: unknown): {answers: Record<string, Answer>; usage: DecisionsUsage} {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const answers = obj.answers as Record<string, Answer> | undefined;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('decisions 响应缺少有效 answers');
  }
  return {answers, usage: normalizeUsage(obj.usage)};
}

export function createJevClient(opts: JevClientOptions): JevClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const loadSdk = opts.loadSdk ?? (() => import('@openrouter/sdk') as Promise<unknown>);
  const url = opts.baseUrl ?? DECISIONS_URL;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxRetries = opts.retry ?? 1;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new RangeError('timeoutMs 必须是有效的正整数毫秒数');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError('retry 必须是非负安全整数');
  }
  let transport = opts.transport ?? 'sdk';

  function checkActive(signal: AbortSignal, deadlineAt: number): void {
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= deadlineAt) throw new DeadlineExceededError();
  }

  async function callSdk(body: Record<string, unknown>, signal: AbortSignal, deadlineAt: number): Promise<unknown> {
    checkActive(signal, deadlineAt);
    let mod: any;
    try {
      mod = await loadSdk();
    } catch {
      checkActive(signal, deadlineAt);
      throw new SdkUnavailableError('@openrouter/sdk 加载失败');
    }
    checkActive(signal, deadlineAt);
    const OpenRouter = mod?.OpenRouter ?? mod?.default?.OpenRouter ?? mod?.default;
    if (typeof OpenRouter !== 'function') throw new SdkUnavailableError('@openrouter/sdk 导出中没有 OpenRouter 构造器');
    const client = new OpenRouter({
      apiKey: opts.apiKey,
      debugLogger: silentSdkLogger,
      ...(typeof mod.HTTPClient === 'function'
        ? {httpClient: new mod.HTTPClient({fetcher: (request: RequestInfo | URL, init?: RequestInit) => {
          checkActive(signal, deadlineAt);
          return doFetch(request, init);
        }})} : {}),
    });
    if (typeof client?.alpha?.decisions?.create !== 'function') throw new SdkUnavailableError('@openrouter/sdk 缺少 alpha.decisions.create');
    const {session_id, ...sdkBody} = body;
    if (session_id) sdkBody.sessionId = session_id;
    const requestOptions: RequestOptions = {
      signal, timeoutMs: Math.max(1, deadlineAt - Date.now()), retries: {strategy: 'none'},
    };
    checkActive(signal, deadlineAt);
    return client.alpha.decisions.create({decisionsRequest: sdkBody}, requestOptions);
  }

  /** 容忍 markdown 围栏与前后杂讯，取出首个 JSON 对象并校验 answers 字段 */
  function parseChatContent(content: string): Record<string, unknown> {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('chat 响应正文不含 JSON 对象');
    const parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('chat 响应正文不是 JSON 对象');
    const answers = parsed.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('chat 响应缺少有效 answers');
    return parsed;
  }

  async function callChat(
    body: Record<string, unknown>,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<{answers: Record<string, Answer>; usage: DecisionsUsage; raw: unknown}> {
    checkActive(signal, deadlineAt);
    const serialized = JSON.stringify({
      model: opts.model,
      stream: false,
      messages: [
        {role: 'system', content: CHAT_DECISION_SYSTEM_PROMPT},
        {role: 'user', content: JSON.stringify({state: body.state, questions: body.questions})},
      ],
    });
    checkActive(signal, deadlineAt);
    const res = await doFetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}`},
      body: serialized,
      signal,
    });
    checkActive(signal, deadlineAt);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      void res.body?.cancel().catch(() => {});
      throw new DecisionsHttpError(res.status, 'chat completions', errorBodySnippet(text));
    }
    const text = await res.text();
    checkActive(signal, deadlineAt);
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    const choice = Array.isArray(raw?.choices) ? (raw.choices[0] as Record<string, unknown> | undefined) : undefined;
    const message = (choice?.message && typeof choice.message === 'object' ? choice.message : {}) as Record<string, unknown>;
    if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('chat 响应缺少 choices[0].message.content');
    const parsed = parseChatContent(message.content);
    return {answers: parsed.answers as Record<string, Answer>, usage: normalizeUsage(raw?.usage), raw: parsed};
  }

  async function callFetch(body: unknown, signal: AbortSignal, deadlineAt: number): Promise<unknown> {
    checkActive(signal, deadlineAt);
    const serialized = JSON.stringify(body);
    checkActive(signal, deadlineAt);
    const res = await doFetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}`},
      body: serialized,
      signal,
    });
    checkActive(signal, deadlineAt);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      void res.body?.cancel().catch(() => {});
      throw new DecisionsHttpError(res.status, 'decisions API', errorBodySnippet(text));
    }
    const text = await res.text();
    checkActive(signal, deadlineAt);
    return JSON.parse(text) as unknown;
  }

  return {
    async decide(input: DecideInput, control: CallControl = {}): Promise<DecideResult> {
      const started = Date.now();
      const deadlineAt = Math.min(started + timeoutMs, control.deadlineAt ?? Infinity);
      return withDeadline(async (signal) => {
        const body: Record<string, unknown> = {
          model: opts.model, state: input.state, questions: input.questions,
        };
        if (input.sessionId) body.session_id = input.sessionId; // chat 传输不携带 session_id（接口无此参数）
        if (transport === 'chat') {
          for (const question of Object.values(input.questions)) {
            if (question.type !== 'choice') throw new Error(`chat 传输暂只支持 choice 题型（收到 ${question.type}）`);
          }
        }
        let lastError: Error = new Error('jev 决策失败：无可用的尝试');
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          checkActive(signal, deadlineAt);
          try {
            if (transport === 'chat') {
              const parsed = await callChat(body, signal, deadlineAt);
              const latencyMs = Date.now() - started;
              opts.logger?.debug(`jev 决策完成（${Object.keys(parsed.answers).length} 个答案，${latencyMs}ms）`);
              return {answers: parsed.answers, usage: parsed.usage, latencyMs, raw: parsed.raw};
            }
            let raw: unknown;
            if (transport === 'sdk') {
              try {
                raw = await callSdk(body, signal, deadlineAt);
              } catch (err) {
                checkActive(signal, deadlineAt);
                if (!(err instanceof SdkUnavailableError)) throw err;
                opts.logger?.warn('jev SDK 不可用；改用 fetch 传输');
                transport = 'fetch';
                raw = await callFetch(body, signal, deadlineAt);
              }
            } else {
              raw = await callFetch(body, signal, deadlineAt);
            }
            checkActive(signal, deadlineAt);
            const {answers, usage} = parseResponse(raw);
            const latencyMs = Date.now() - started;
            opts.logger?.debug(`jev 决策完成（${Object.keys(answers).length} 个答案，${latencyMs}ms）`);
            return {answers, usage, latencyMs, raw};
          } catch (err) {
            checkActive(signal, deadlineAt);
            if (err instanceof DeadlineExceededError || err instanceof CallCancelledError) throw err;
            lastError = err instanceof DecisionsHttpError ? err : new Error('jev 调用失败（网络、SDK 或响应格式异常）');
            opts.logger?.warn(`jev 调用失败（第 ${attempt + 1}/${maxRetries + 1} 次）: ${lastError.message}`);
          }
        }
        throw lastError;
      }, {...control, deadlineAt});
    },
  };
}
