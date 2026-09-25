import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createJevClient} from '../src/jev/client.js';
import {CallCancelledError, DeadlineExceededError} from '../src/jev/deadline.js';
import {nullLogger} from '../src/log/logger.js';
import type {Answer} from '../src/jev/types.js';
import {decideChoice} from '../src/decide/policy.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试禁止真实网络'); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ANSWERS: Record<string, Answer> = {
  q1: {type: 'choice', choice: 'a', confidence: 0.9, probabilities: {a: 0.9, b: 0.1}},
};

function okFetch(): {impl: typeof fetch; calls: Array<{url: string; init?: RequestInit}>} {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({url: String(url), init});
    return new Response(
      JSON.stringify({answers: ANSWERS, usage: {cost: 0.01, input_tokens: 11, output_tokens: 3}, model: 'm'}),
      {status: 200},
    );
  }) as unknown as typeof fetch;
  return {impl, calls};
}

const questions = {q1: {type: 'choice' as const, instructions: 'pick', criteria: {a: 'A', b: 'B'}}};

describe('createJevClient / fetch 传输', () => {
  it('POST 端点、鉴权头与请求体', async () => {
    const {impl, calls} = okFetch();
    const client = createJevClient({apiKey: 'k', model: '~typesafe/jev-latest', transport: 'fetch', fetchImpl: impl});
    const res = await client.decide({sessionId: 'battle-1', state: {turn: 1}, questions});
    expect(res.answers.q1).toMatchObject({choice: 'a'});
    expect(res.usage.cost).toBe(0.01);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/alpha/decisions');
    const init = calls[0].init!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('~typesafe/jev-latest');
    expect(body.session_id).toBe('battle-1');
    expect(body.questions.q1.type).toBe('choice');
  });

  it('非 2xx 抛错（带状态码）', async () => {
    const impl = (async () => new Response('{"error":{"code":429}}', {status: 429})) as unknown as typeof fetch;
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'fetch', fetchImpl: impl, retry: 0});
    await expect(client.decide({state: {}, questions})).rejects.toThrow(/429/);
  });

  it('失败后重试一次并成功', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) throw new Error('network down');
      return new Response(JSON.stringify({answers: ANSWERS, usage: {}}), {status: 200});
    }) as unknown as typeof fetch;
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'fetch', fetchImpl: impl, retry: 1});
    const res = await client.decide({state: {}, questions});
    expect(res.answers).toEqual(ANSWERS);
    expect(n).toBe(2);
  });

  it('重试用尽后抛安全摘要而非远端错误正文', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'fetch', fetchImpl: impl, retry: 1});
    const error = await client.decide({state: {}, questions}).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('jev');
    expect(error.message).not.toContain('boom');
    expect(n).toBe(2);
  });

  it('超时中断请求', async () => {
    const impl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
      })) as unknown as typeof fetch;
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'fetch', fetchImpl: impl, retry: 0, timeoutMs: 30});
    const t0 = Date.now();
    await expect(client.decide({state: {}, questions})).rejects.toThrow(/aborted|timeout/i);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('SDK 不可用时自动回退 fetch', async () => {
    const {impl, calls} = okFetch();
    const client = createJevClient({
      apiKey: 'k', model: 'm', transport: 'sdk', fetchImpl: impl,
      loadSdk: async () => {
        throw new Error('Cannot find module');
      },
    });
    const res = await client.decide({state: {}, questions});
    expect(res.answers).toEqual(ANSWERS);
    expect(calls.length).toBe(1);
  });

  it('SDK 返回的 camelCase usage 归一化为 snake_case', async () => {
    const client = createJevClient({
      apiKey: 'k', model: 'm', transport: 'sdk',
      loadSdk: async () => ({
        OpenRouter: class {
          alpha = {
            decisions: {
              create: async () => ({
                answers: ANSWERS,
                usage: {cost: 0.002, inputTokens: 3370, outputTokens: 291},
              }),
            },
          };
        },
      }),
    });
    const res = await client.decide({state: {}, questions});
    expect(res.usage).toEqual({cost: 0.002, input_tokens: 3370, output_tokens: 291});
  });
});

function observe<T>(promise: Promise<T>) {
  const result: {settled: boolean; value?: T; error?: unknown} = {settled: false};
  void promise.then(
    value => { result.settled = true; result.value = value; },
    error => { result.settled = true; result.error = error; },
  );
  return result;
}

const never = () => new Promise<never>(() => {});
const input = {state: {turn: 1}, questions};
const sdkModule = (create: (...args: any[]) => Promise<unknown>) => ({
  OpenRouter: class { alpha = {decisions: {create}}; },
});

describe('jev 共享截止控制', () => {
  beforeEach(() => vi.useFakeTimers({now: 1000}));

  it('默认 20s 内结束等待挂起的 SDK 加载', async () => {
    const loadSdk = vi.fn(never);
    const fallback = vi.fn(never);
    const client = createJevClient({apiKey: 'k', model: 'm', loadSdk, fetchImpl: fallback});
    const outcome = observe(client.decide(input));
    await vi.advanceTimersByTimeAsync(19999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['fetch', 'body'] as const)('%s 忽略 signal 时仍硬超时且不重试', async (phase) => {
    let signal: AbortSignal | null | undefined;
    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      if (phase === 'fetch') return never();
      return {ok: true, text: never} as unknown as Response;
    });
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'fetch', fetchImpl: impl, timeoutMs: 100, retry: 2});
    const outcome = observe(client.decide(input));
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
    expect(signal?.aborted).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SDK 使用第二参数 signal、剩余预算且禁用内部重试', async () => {
    const create = vi.fn(never);
    const loadSdk = async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return sdkModule(create);
    };
    const client = createJevClient({apiKey: 'k', model: 'm', loadSdk, timeoutMs: 100});
    const outcome = observe(client.decide({...input, sessionId: 'battle-test'}));
    await vi.advanceTimersByTimeAsync(30);
    expect(create).toHaveBeenCalledWith({decisionsRequest: {
      model: 'm', ...input, sessionId: 'battle-test',
    }}, expect.objectContaining({signal: expect.any(AbortSignal), timeoutMs: 70, retries: {strategy: 'none'}}));
    await vi.advanceTimersByTimeAsync(70);
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
    expect((create.mock.calls[0] as unknown as [unknown, RequestInit])[1].signal?.aborted).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['fetch', 'sdk'] as const)('%s 重试不能重新获得完整预算', async (transport) => {
    let count = 0;
    const call = vi.fn(async () => {
      if (++count === 1) {
        await new Promise(resolve => setTimeout(resolve, 60));
        throw new Error('private failure');
      }
      return never();
    });
    const client = createJevClient({
      apiKey: 'k', model: 'm', transport, timeoutMs: 100, retry: 1,
      fetchImpl: call, loadSdk: async () => sdkModule(call),
    });
    const outcome = observe(client.decide(input));
    await vi.advanceTimersByTimeAsync(99);
    expect(call).toHaveBeenCalledTimes(2);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
  });

  it('SDK 加载失败后 fetch 回退只剩原预算余量', async () => {
    const fallback = vi.fn(never);
    const loadSdk = async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      throw new Error('private loader error');
    };
    const client = createJevClient({apiKey: 'k', model: 'm', timeoutMs: 100, loadSdk, fetchImpl: fallback});
    const outcome = observe(client.decide(input));
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it.each(['fetch', 'body', 'sdk'] as const)('外部取消 %s 会传播且不重试', async (phase) => {
    const controller = new AbortController();
    const call = vi.fn(async () => phase === 'body' ? {ok: true, text: never} as unknown as Response : never());
    const client = createJevClient({
      apiKey: 'k', model: 'm', timeoutMs: 100,
      transport: phase === 'sdk' ? 'sdk' : 'fetch', fetchImpl: call,
      loadSdk: async () => sdkModule(call), retry: 3,
    });
    const outcome = observe(client.decide(input, {signal: controller.signal}));
    await vi.advanceTimersByTimeAsync(5);
    controller.abort(new Error('private cancellation'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.error).toBeInstanceOf(CallCancelledError);
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SDK 加载期间取消后，迟到的加载失败不能触发 fetch', async () => {
    let rejectLoad!: (error: Error) => void;
    const fallback = vi.fn(never);
    const controller = new AbortController();
    const client = createJevClient({apiKey: 'k', model: 'm', fetchImpl: fallback,
      loadSdk: () => new Promise((_resolve, reject) => { rejectLoad = reject; }),
    });
    const outcome = observe(client.decide(input, {signal: controller.signal}));
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.error).toBeInstanceOf(CallCancelledError);
    rejectLoad(new Error('late load failure'));
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('已取消或已过期的请求不得启动传输', async () => {
    const call = vi.fn(never);
    const controller = new AbortController();
    controller.abort();
    const client = createJevClient({apiKey: 'k', model: 'm', loadSdk: call, fetchImpl: call});
    const cancelled = observe(client.decide(input, {signal: controller.signal}));
    const expired = observe(client.decide(input, {deadlineAt: 1000}));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled.error).toBeInstanceOf(CallCancelledError);
    expect(expired.error).toBeInstanceOf(DeadlineExceededError);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([50, 500])('外部截止 %sms 只会缩短、不延长客户端预算', async (budget) => {
    const client = createJevClient({apiKey: 'k', model: 'm', loadSdk: never, timeoutMs: 100});
    const outcome = observe(client.decide(input, {deadlineAt: 1000 + budget}));
    await vi.advanceTimersByTimeAsync(Math.min(100, budget));
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
  });

  it.each(['deadline', 'cancel'] as const)('序列化时 %s 已失效，不得再启动 fetch', async (reason) => {
    const controller = new AbortController();
    const impl = vi.fn(async () => new Response(JSON.stringify({answers: ANSWERS})));
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'fetch', fetchImpl: impl, timeoutMs: 100});
    const state = {toJSON() {
      if (reason === 'deadline') vi.setSystemTime(1200);
      else controller.abort();
      return {turn: 1};
    }};
    const outcome = observe(client.decide({state, questions}, {signal: controller.signal}));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.error).toBeInstanceOf(reason === 'deadline' ? DeadlineExceededError : CallCancelledError);
    expect(impl).not.toHaveBeenCalled();
  });

  it('直接构造客户端也拒绝非法超时和重试次数', () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2147483648]) {
      expect(() => createJevClient({apiKey: 'k', model: 'm', timeoutMs})).toThrow(/timeoutMs/);
    }
    for (const retry of [-1, NaN, Infinity, 1.5]) {
      expect(() => createJevClient({apiKey: 'k', model: 'm', retry})).toThrow(/retry/);
    }
  });
});

describe('jev SDK 离线集成与日志安全', () => {
  it.each(['sdk', 'fetch', 'chat'] as const)('%s 实际请求体保留整局上下文和各题胜利目标', {timeout: 15000}, async transport => {
    const sdk = transport === 'sdk' ? await import('@openrouter/sdk') : undefined;
    const tracker = mkTracker();
    tracker.handleLine('|move|p1a: Golisopod|Protect|p1a: Golisopod');
    tracker.handleLine('|move|p2b: Charizard|Heat Wave|p1a: Golisopod');
    tracker.handleLine('|turn|2');
    let body: any;
    const answers = {action_slot_1: {type: 'choice', choice: 'move_1_foe_a'}};
    const impl = vi.fn<typeof fetch>(async (request, init) => {
      body = request instanceof Request ? await request.json() : JSON.parse(String(init?.body));
      return new Response(JSON.stringify(transport === 'chat'
        ? {choices: [{message: {content: JSON.stringify({answers})}}]}
        : {model: 'm', answers, usage: {input_tokens: 0, output_tokens: 0}}), {headers: {'Content-Type': 'application/json'}});
    });
    const result = await decideChoice({
      dex: mkDex(), request: mkRequest(), tracker, battleId: tracker.state.id, logger: nullLogger,
      cfg: {jevMock: false, sendRqid: true, jevContextLevel: 2},
      jev: createJevClient({apiKey: 'offline', model: 'm', transport, retry: 0, fetchImpl: impl, loadSdk: async () => sdk}),
    });
    expect(result?.fallback).toBe(false);
    expect(impl).toHaveBeenCalledTimes(1);
    const input = transport === 'chat' ? JSON.parse(body.messages[1].content) : body;
    expect(input.state.battle_context).toBeDefined();
    expect(input.state.battle_context.recent_turns[0].events).toEqual([
      '|move|p1a: Golisopod|Protect|p1a: Golisopod', '|move|p2b: Charizard|Heat Wave|p1a: Golisopod',
    ]);
    expect(input.state.battle_context.turn).toBe(2);
    for (const q of Object.values(input.questions) as any[]) expect(q.instructions).toContain('win the entire battle');
  });
  it('真实 SDK 序列化耗尽截止预算后不得启动底层 fetch', async () => {
    const sdk = await import('@openrouter/sdk');
    vi.useFakeTimers({now: 1000});
    const impl = vi.fn(never);
    vi.stubGlobal('fetch', impl);
    const client = createJevClient({apiKey: 'k', model: 'm', timeoutMs: 100, loadSdk: async () => sdk, fetchImpl: impl});
    const outcome = observe(client.decide({questions, state: {toJSON() {
      vi.setSystemTime(1200);
      return {turn: 1};
    }}}));
    await vi.advanceTimersByTimeAsync(0);
    expect(impl).not.toHaveBeenCalled();
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
  });

  it('真实 SDK 编码会话信息并解析 usage，所有网络由假 fetch 接管', async () => {
    const sdk = await import('@openrouter/sdk');
    let body: unknown;
    const impl = vi.fn(async (request: RequestInfo | URL) => {
      body = await (request as Request).json();
      return new Response(JSON.stringify({model: 'm', answers: ANSWERS,
        usage: {cost: 0.001, input_tokens: 12, output_tokens: 4}}), {headers: {'Content-Type': 'application/json'}});
    });
    vi.stubGlobal('fetch', impl);
    const client = createJevClient({apiKey: 'k', model: 'm', loadSdk: async () => sdk, fetchImpl: impl});
    const result = await client.decide({...input, sessionId: 'battle-123'});
    expect(body).toMatchObject({...input, session_id: 'battle-123', model: 'm'});
    expect(result.usage).toEqual({cost: 0.001, input_tokens: 12, output_tokens: 4});
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it.each(['http', 'json', 'sdk', 'loader'] as const)('%s 失败不泄露 key/远端正文', async (source) => {
    const privateText = 'private-key remote-error-body';
    const warn = vi.fn();
    const impl = vi.fn(async () => new Response(source === 'json' ? JSON.stringify({error: privateText}) : privateText,
      {status: source === 'json' ? 200 : 429}));
    const client = createJevClient({apiKey: 'private-key', model: 'm', retry: 0,
      transport: source === 'sdk' || source === 'loader' ? 'sdk' : 'fetch', fetchImpl: impl,
      loadSdk: async () => {
        if (source === 'loader') throw new Error(privateText);
        return sdkModule(async () => { throw new Error(privateText); });
      }, logger: {...nullLogger, warn},
    });
    const error = await client.decide(input).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(warn).toHaveBeenCalled();
    const logs = JSON.stringify(warn.mock.calls) + String(error);
    expect(logs).not.toContain('private-key');
    expect(logs).not.toContain('remote-error-body');
  });

  it('真实 SDK 的 Request.signal 可中止底层 fetch，调试模式不能泄露凭据', async () => {
    const sdk = await import('@openrouter/sdk');
    vi.useFakeTimers({now: 1000});
    vi.stubEnv('OPENROUTER_DEBUG', '1');
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const groups = vi.spyOn(console, 'group').mockImplementation(() => {});
    const groupEnd = vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    const impl = vi.fn(async (request: RequestInfo | URL) => {
      signal = (request as Request).signal;
      return never();
    });
    vi.stubGlobal('fetch', impl);
    const client = createJevClient({apiKey: 'private-key', model: 'm', timeoutMs: 100,
      loadSdk: async () => sdk, fetchImpl: impl,
    });
    const outcome = observe(client.decide(input));
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.error).toBeInstanceOf(DeadlineExceededError);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(logs).not.toHaveBeenCalled();
    expect(groups).not.toHaveBeenCalled();
    expect(groupEnd).not.toHaveBeenCalled();
  });
});

function chatFetch(content: string, usage: Record<string, number> = {cost: 0.002, prompt_tokens: 21000, completion_tokens: 180}): {
  impl: typeof fetch; calls: Array<{url: string; init?: RequestInit}>;
} {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({url: String(url), init});
    return new Response(JSON.stringify({
      model: 'google/gemini-3.8-flash',
      choices: [{message: {role: 'assistant', content}}],
      usage,
    }), {status: 200});
  }) as unknown as typeof fetch;
  return {impl, calls};
}

describe('createJevClient / chat 传输（Chat Completions 决策）', () => {
  it('POST chat completions 端点，组装提示词并解析 answers/usage', async () => {
    const {impl, calls} = chatFetch(
      '{"answers":{"q1":{"type":"choice","choice":"a","confidence":0.9,"probabilities":{"a":0.9,"b":0.1}}}}',
    );
    const client = createJevClient({apiKey: 'k', model: 'google/gemini-3.8-flash', transport: 'chat', fetchImpl: impl, retry: 0});
    const res = await client.decide({sessionId: 'battle-1', state: {turn: 1}, questions});
    expect(res.answers.q1).toMatchObject({type: 'choice', choice: 'a', probabilities: {a: 0.9, b: 0.1}});
    expect(res.usage).toEqual({cost: 0.002, input_tokens: 21000, output_tokens: 180});
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const init = calls[0].init!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('google/gemini-3.8-flash');
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('"turn":1');
    expect(body.messages[1].content).toContain('"q1"');
  });

  it('容忍 markdown 代码围栏与前后杂讯', async () => {
    const {impl} = chatFetch('Here is my decision:\n```json\n{"answers":{"q1":{"type":"choice","choice":"b"}}}\n```\nDone.');
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'chat', fetchImpl: impl, retry: 0});
    const res = await client.decide({state: {}, questions});
    expect(res.answers.q1).toMatchObject({type: 'choice', choice: 'b'});
  });

  it('正文无有效 answers 时抛安全错误', async () => {
    const {impl} = chatFetch('I cannot answer that.');
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'chat', fetchImpl: impl, retry: 0});
    await expect(client.decide({state: {}, questions})).rejects.toThrow('jev');
  });

  it('noul/score 题型在 chat 传输下直接拒绝且不发起请求', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      calls.push({url: String(url), init});
      return new Response('{}', {status: 200});
    }) as unknown as typeof fetch;
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'chat', fetchImpl: impl, retry: 0});
    const noulQuestions = {q1: {type: 'noul' as const, instructions: 'x', criteria: {true: 't', false: 'f'}}};
    await expect(client.decide({state: {}, questions: noulQuestions})).rejects.toThrow('choice');
    expect(calls.length).toBe(0);
  });

  it('chat 非 2xx 错误携带响应体片段（定位限流/供应商错误）', async () => {
    const impl = (async () => new Response(
      JSON.stringify({error: {message: 'Provider returned error: rate limit exceeded', code: 400}}),
      {status: 400},
    )) as unknown as typeof fetch;
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'chat', fetchImpl: impl, retry: 0});
    const error = await client.decide({state: {}, questions}).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('400');
    expect(error.message).toContain('rate limit exceeded');
  });

  it('chat 非 JSON 错误正文不透传（安全边界同 fetch 传输）', async () => {
    const impl = (async () => new Response('private-key remote-error-body', {status: 400})) as unknown as typeof fetch;
    const client = createJevClient({apiKey: 'private-key', model: 'm', transport: 'chat', fetchImpl: impl, retry: 0});
    const error = await client.decide({state: {}, questions}).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('private-key');
    expect(String(error)).not.toContain('remote-error-body');
  });
});
