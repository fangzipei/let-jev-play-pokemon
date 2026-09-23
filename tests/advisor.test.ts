import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CallCancelledError, DeadlineExceededError} from '../src/jev/deadline.js';
import {nullLogger} from '../src/log/logger.js';

import * as api from '../src/jev/advisor.js';
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试禁止真实网络'); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const questions = {slot1: {type: 'choice' as const, instructions: 'pick a legal action', criteria: {
  move1: 'Rock Slide vs both foes', switch3: 'Switch to Chandelure',
}}};
const state = {ours: {team: [{species: 'Tyranitar', moves: ['Rock Slide'], item: 'Choice Scarf', ability: 'Sand Stream', stats: {spe: 122}}]}, opponent: {preview: ['Charizard']}};
const input = {kind: 'turn' as const, state, questions};
const recommendation = 'OPPONENT PLAN: Fire pressure. OUR PLAN: Control speed. RECOMMEND: Use Rock Slide.';
const response = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  choices: [{message: {content: recommendation}}], ...extra,
}), {status: 200});
const never = () => new Promise<never>(() => {});
function observe<T>(promise: Promise<T>) {
  const result: {settled: boolean; value?: T; error?: unknown} = {settled: false};
  void promise.then(value => { result.settled = true; result.value = value; }, error => { result.settled = true; result.error = error; });
  return result;
}

describe('advisor 请求与结果', () => {
  it.each(['team-preview', 'turn', 'force-switch'] as const)('%s 发送完整 state 与全部合法 questions', async (kind) => {
    const impl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({
      model: 'resolved/model', usage: {cost: 0.004, prompt_tokens: 1500, completion_tokens: 300},
    }));
    const client = api.createAdvisorClient({apiKey: 'advisor-key', model: 'google/gemini-3.8-flash', fetchImpl: impl});
    const result = await client.analyze({kind, state, questions});
    expect(result).toEqual({text: recommendation, model: 'resolved/model', latencyMs: expect.any(Number),
      usage: {cost: 0.004, input_tokens: 1500, output_tokens: 300}});
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const init = impl.mock.calls[0][1]!;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer advisor-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({model: 'google/gemini-3.8-flash', stream: false, max_tokens: 2048});
    expect(body).not.toHaveProperty('reasoning');
    const system = body.messages.find((m: {role: string}) => m.role === 'system').content;
    expect(system).toContain('120 words');
    expect(system).toContain('OPPONENT PLAN:');
    expect(system).toContain('OUR PLAN:');
    expect(system).toContain('RECOMMEND:');
    expect(JSON.parse(body.messages.find((m: {role: string}) => m.role === 'user').content))
      .toEqual({kind, state, questions});
    expect(state).not.toHaveProperty('advisor_analysis');
  });

  it('没有分析文本但已返回费用时保留账单，不作为成功建议', async () => {
    const client = api.createAdvisorClient({apiKey: 'k', model: 'm', fetchImpl: async () => response({
      choices: [{message: {content: ''}, finish_reason: 'length'}],
      usage: {cost: 0.004, prompt_tokens: 500, completion_tokens: 1024},
    })});
    expect(await client.analyze(input)).toMatchObject({text: '', usage: {cost: 0.004, input_tokens: 500, output_tokens: 1024}});
  });

  it('允许显式 token 预算与低推理强度，不为任意模型默认注入 reasoning', async () => {
    const impl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response());
    const client = api.createAdvisorClient({apiKey: 'k', model: 'custom/model', fetchImpl: impl,
      maxTokens: 2048, reasoningEffort: 'low'});
    await client.analyze(input);
    expect(JSON.parse(String(impl.mock.calls[0][1]!.body))).toMatchObject({max_tokens: 2048, reasoning: {effort: 'low'}});
  });

  it('文本本地限制到 120 词且缺少 usage 不伪造费用', async () => {
    const client = api.createAdvisorClient({apiKey: 'k', model: 'configured/model',
      fetchImpl: async () => response({choices: [{message: {content: Array(140).fill('word').join(' ')}}]}),
    });
    const result = await client.analyze(input);
    expect(result?.text.split(/\s+/)).toHaveLength(120);
    expect(result?.model).toBe('configured/model');
    expect(result?.usage).toEqual({});
  });

  it('兼容 usage 命名并只接受有限非负数值', async () => {
    const impl = vi.fn().mockResolvedValueOnce(response({usage: {cost: 0, input_tokens: 17, output_tokens: 9}}))
      .mockResolvedValueOnce(response({usage: {cost: -1, prompt_tokens: '42', completion_tokens: -2}}))
      .mockResolvedValueOnce(response({usage: {cost: null, inputTokens: 8, outputTokens: 3}}));
    const client = api.createAdvisorClient({apiKey: 'k', model: 'm', fetchImpl: impl});
    expect((await client.analyze(input))?.usage).toEqual({cost: 0, input_tokens: 17, output_tokens: 9});
    expect((await client.analyze(input))?.usage).toEqual({});
    expect((await client.analyze(input))?.usage).toEqual({input_tokens: 8, output_tokens: 3});
  });

  it.each(['', ' ', '\t'])('空白 key %j 不发送请求', async (apiKey) => {
    const impl = vi.fn(never);
    const client = api.createAdvisorClient({apiKey, model: 'm', fetchImpl: impl});
    expect(await client.analyze(input)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('直接构造时拒绝非法 timeout/token 预算', () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2147483648]) {
      expect(() => api.createAdvisorClient({apiKey: 'k', model: 'm', timeoutMs})).toThrow(/timeoutMs/);
    }
    for (const maxTokens of [0, -1, NaN, Infinity, 0.5]) {
      expect(() => api.createAdvisorClient({apiKey: 'k', model: 'm', maxTokens})).toThrow(/maxTokens/);
    }
  });
});

describe('advisor 降级与取消', () => {
  it('非 2xx 不读取远端错误正文，无重试且日志脱敏', async () => {
    const text = vi.fn(async () => 'remote-error-body private-key');
    const cancel = vi.fn(async () => {});
    const impl = vi.fn(async () => ({ok: false, status: 429, text, body: {cancel}}) as unknown as Response);
    const warn = vi.fn();
    const client = api.createAdvisorClient({apiKey: 'private-key', model: 'm', fetchImpl: impl, logger: {...nullLogger, warn}});
    expect(await client.analyze(input)).toBeNull();
    expect(impl).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-key|remote-error-body/);
  });

  it.each([
    'not-json private-key', 'null', '{}', JSON.stringify({choices: []}),
    JSON.stringify({choices: [{message: {content: '   '}}]}),
    JSON.stringify({choices: [{message: {content: [{text: 'not a string'}]}}]}),
  ])('无效响应 %s 安全返回 null', async (raw) => {
    const warn = vi.fn();
    const client = api.createAdvisorClient({apiKey: 'private-key', model: 'm',
      fetchImpl: async () => new Response(raw), logger: {...nullLogger, warn}});
    expect(await client.analyze(input)).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-key');
  });

  it('自身网络失败或 AbortError 返回 null，不记录远端 error.message', async () => {
    const warn = vi.fn();
    const impl = vi.fn(async () => { throw new DOMException('private-key remote-error-body', 'AbortError'); });
    const client = api.createAdvisorClient({apiKey: 'private-key', model: 'm', fetchImpl: impl, logger: {...nullLogger, warn}});
    expect(await client.analyze(input)).toBeNull();
    expect(impl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-key|remote-error-body/);
  });

  it.each(['fetch', 'body'] as const)('%s 挂起在默认 10s 后降级并 abort', async (phase) => {
    vi.useFakeTimers({now: 1000});
    let signal: AbortSignal | null | undefined;
    const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return phase === 'fetch' ? never() : {ok: true, text: never} as unknown as Response;
    });
    const client = api.createAdvisorClient({apiKey: 'k', model: 'm', fetchImpl: impl});
    const outcome = observe(client.analyze(input));
    await vi.advanceTimersByTimeAsync(9999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['fetch', 'body'] as const)('外部取消 %s 传播而不是降级 null', async (phase) => {
    vi.useFakeTimers({now: 1000});
    const controller = new AbortController();
    let inner: AbortSignal | null | undefined;
    const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      inner = init?.signal;
      return phase === 'fetch' ? never() : {ok: true, text: never} as unknown as Response;
    });
    const client = api.createAdvisorClient({apiKey: 'k', model: 'm', fetchImpl: impl});
    const outcome = observe(client.analyze(input, {signal: controller.signal}));
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('private cancellation'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.error).toBeInstanceOf(CallCancelledError);
    expect(String(outcome.error)).not.toContain('private cancellation');
    expect(inner?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('外层绝对截止耗尽向 policy 传播 DeadlineExceededError', async () => {
    vi.useFakeTimers({now: 1000});
    const client = api.createAdvisorClient({apiKey: 'k', model: 'm', fetchImpl: never, timeoutMs: 100});
    const outcome = observe(client.analyze(input, {deadlineAt: 1020}));
    await vi.advanceTimersByTimeAsync(20);
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('外层较长截止不延长 advisor 自身 10s 预算', async () => {
    vi.useFakeTimers({now: 1000});
    const client = api.createAdvisorClient({apiKey: 'k', model: 'm', fetchImpl: never});
    const outcome = observe(client.analyze(input, {deadlineAt: 36000}));
    await vi.advanceTimersByTimeAsync(10000);
    expect(outcome.value).toBeNull();
  });

  it.each(['deadline', 'cancel'] as const)('序列化时 %s 已失效，不得启动网络调用', async (reason) => {
    vi.useFakeTimers({now: 1000});
    const controller = new AbortController();
    const impl = vi.fn(async () => response());
    const client = api.createAdvisorClient({apiKey: 'k', model: 'm', timeoutMs: 100, fetchImpl: impl});
    const outcome = observe(client.analyze({...input, state: {toJSON() {
      if (reason === 'deadline') vi.setSystemTime(1200);
      else controller.abort();
      return {turn: 1};
    }}}, {signal: controller.signal}));
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'deadline') expect(outcome.value).toBeNull();
    else expect(outcome.error).toBeInstanceOf(CallCancelledError);
    expect(impl).not.toHaveBeenCalled();
  });

  it('父超时取消保留错误类型，已取消/过期请求不发起网络', async () => {
    const impl = vi.fn(never);
    const client = api.createAdvisorClient({apiKey: 'k', model: 'm', fetchImpl: impl});
    const controller = new AbortController();
    controller.abort(new DeadlineExceededError());
    await expect(client.analyze(input, {signal: controller.signal})).rejects.toBeInstanceOf(DeadlineExceededError);
    await expect(client.analyze(input, {deadlineAt: Date.now() - 1})).rejects.toBeInstanceOf(DeadlineExceededError);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(client.analyze(input, {signal: cancelled.signal})).rejects.toBeInstanceOf(CallCancelledError);
    expect(impl).not.toHaveBeenCalled();
  });
});
