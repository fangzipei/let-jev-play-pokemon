import {describe, expect, it, vi} from 'vitest';
import {
  benchAdvisor,
  benchDecision,
  parseBenchSample,
  summarizeBench,
  type BenchAttempt,
  type BenchSample,
} from '../src/jev/bench.js';
import type {AdvisorClient, AdvisorResult} from '../src/jev/advisor.js';
import type {JevClient} from '../src/jev/client.js';

const sample: BenchSample = {
  kind: 'turn',
  state: {turn: 1},
  questions: {q: {type: 'choice', instructions: 'i', criteria: {a: '描述 a', b: '描述 b'}}},
};

describe('summarizeBench', () => {
  it('聚合成功与失败尝试：延迟统计计所有有耗时的记录，成本合计全部', () => {
    const attempts: BenchAttempt[] = [
      {model: 'm', attempt: 1, ok: true, latencyMs: 100, cost: 0.001, inputTokens: 1000, outputTokens: 100},
      {model: 'm', attempt: 2, ok: false, error: 'jev chat completions HTTP 403'},
      {model: 'm', attempt: 3, ok: true, latencyMs: 300, cost: 0.002, inputTokens: 1000, outputTokens: 200},
      {model: 'm', attempt: 4, ok: false, latencyMs: 400, cost: 0.001, error: 'advisor 返回空文本（仅用量）'},
    ];
    const summary = summarizeBench('m', attempts);
    expect(summary).toEqual({
      model: 'm',
      attempts: 4,
      ok: 2,
      fail: 2,
      minMs: 100,
      avgMs: 267,
      maxMs: 400,
      costTotal: 0.004,
    });
  });

  it('全部失败且无耗时记录时不产出延迟统计（undefined，不伪装成 0ms）', () => {
    const attempts: BenchAttempt[] = [
      {model: 'm', attempt: 1, ok: false, error: 'x'},
      {model: 'm', attempt: 2, ok: false, error: 'y'},
    ];
    const summary = summarizeBench('m', attempts);
    expect(summary.ok).toBe(0);
    expect(summary.fail).toBe(2);
    expect(summary.minMs).toBeUndefined();
    expect(summary.avgMs).toBeUndefined();
    expect(summary.maxMs).toBeUndefined();
    expect(summary.costTotal).toBe(0);
  });
});

describe('benchDecision', () => {
  it('成功与抛错的尝试各记一条，成功带延迟与用量、失败带错误消息', async () => {
    const client: JevClient = {
      decide: vi.fn()
        .mockResolvedValueOnce({answers: {}, usage: {cost: 0.001, input_tokens: 10, output_tokens: 5}, latencyMs: 1234, raw: {}})
        .mockRejectedValueOnce(new Error('boom')),
    };
    const attempts = await benchDecision('m', client, sample, 2);
    expect(client.decide).toHaveBeenCalledWith({state: sample.state, questions: sample.questions}, {});
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual({model: 'm', attempt: 1, ok: true, latencyMs: 1234, cost: 0.001, inputTokens: 10, outputTokens: 5});
    expect(attempts[1]).toEqual({model: 'm', attempt: 2, ok: false, error: 'boom'});
  });
});

describe('benchAdvisor', () => {
  it('analyze 返回 null 记失败、返回结果记成功，均保留耗时与用量', async () => {
    const emptyResult: AdvisorResult = {text: '', model: 'm', latencyMs: 4000, usage: {cost: 0.001, input_tokens: 20, output_tokens: 2}};
    const goodResult: AdvisorResult = {text: 'advice', model: 'm', latencyMs: 5678, usage: {cost: 0.002, input_tokens: 100, output_tokens: 50}};
    const client: AdvisorClient = {
      analyze: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(goodResult)
        .mockResolvedValueOnce(emptyResult),
    };
    const attempts = await benchAdvisor('m', client, sample, 3);
    expect(client.analyze).toHaveBeenCalledWith({kind: sample.kind, state: sample.state, questions: sample.questions}, {});
    expect(attempts[0]).toEqual({model: 'm', attempt: 1, ok: false, error: 'advisor 未返回分析（超时或请求失败）'});
    expect(attempts[1]).toEqual({model: 'm', attempt: 2, ok: true, latencyMs: 5678, cost: 0.002, inputTokens: 100, outputTokens: 50});
    expect(attempts[2]).toEqual({
      model: 'm', attempt: 3, ok: false, latencyMs: 4000, cost: 0.001,
      error: 'advisor 返回空文本（仅用量）', inputTokens: 20, outputTokens: 2,
    });
  });
});

describe('parseBenchSample', () => {
  it('从 JSONL 行数组解析指定索引的重放样本', () => {
    const turnLine = JSON.stringify({kind: 'turn', state: {turn: 1}, questions: sample.questions});
    const parsed = parseBenchSample([JSON.stringify({kind: 'team-preview', state: {}, questions: {}}), turnLine], 1);
    expect(parsed.kind).toBe('turn');
    expect(parsed.state).toEqual({turn: 1});
    expect(parsed.questions).toEqual(sample.questions);
  });

  it('索引越界或缺少 kind/questions 的行抛错', () => {
    expect(() => parseBenchSample([JSON.stringify({kind: 'turn', state: {}, questions: {}})], 3)).toThrow('索引');
    expect(() => parseBenchSample([JSON.stringify({state: {}, questions: {}})], 0)).toThrow('kind');
    expect(() => parseBenchSample([JSON.stringify({kind: 'turn', state: {}})], 0)).toThrow('questions');
  });
});
