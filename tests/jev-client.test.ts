import {describe, expect, it} from 'vitest';
import {createJevClient} from '../src/jev/client.js';
import type {Answer} from '../src/jev/types.js';

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

  it('重试用尽后抛最后错误', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const client = createJevClient({apiKey: 'k', model: 'm', transport: 'fetch', fetchImpl: impl, retry: 1});
    await expect(client.decide({state: {}, questions})).rejects.toThrow('boom');
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
});
