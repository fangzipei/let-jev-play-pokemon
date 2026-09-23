// tests/review.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {reviewMemories} from '../src/learn/review.js';
import {loadMemory} from '../src/learn/store.js';

const PROTOCOL = [
  '|player|p1|JevBot1234|1|1500', '|player|p2|rival|2|1500',
  '|poke|p1|Golisopod, L50, M|',
  '|poke|p2|Rillaboom, L50, M|', '|poke|p2|Sneasler, L50, F|',
  '|teampreview|4', '|start',
  '|switch|p2a: Sneasler|Sneasler, L50, F|100/100',
  '|turn|1', '|move|p2a: Sneasler|Close Combat|p1a: Golisopod',
  '|-item|p2a: Sneasler|Grassy Seed', '|win|JevBot1234',
].join('\n');

const DECISIONS = JSON.stringify({state: {sides: {ours: {preview: [{ident: 'p1: Golisopod'}]}}}}) + '\n';

async function scaffold(): Promise<{logDir: string; memoryDir: string}> {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-logs-'));
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-memory-'));
  await fs.writeFile(path.join(logDir, 'battle-aaa.protocol.log'), PROTOCOL);
  await fs.writeFile(path.join(logDir, 'battle-aaa.decisions.jsonl'), DECISIONS);
  return {logDir, memoryDir};
}

describe('reviewMemories', () => {
  it('提取新日志并入经验库；重复运行自动跳过', async () => {
    const {logDir, memoryDir} = await scaffold();
    const first = await reviewMemories({logDir, memoryDir});
    expect(first).toMatchObject({processed: 1, skipped: 0, failed: 0});
    const memory = await loadMemory(memoryDir);
    expect(memory.species.sneasler.seen).toBe(1);
    const second = await reviewMemories({logDir, memoryDir});
    expect(second).toMatchObject({processed: 0, skipped: 1});
  });
  it('--dry-run 不写库', async () => {
    const {logDir, memoryDir} = await scaffold();
    const report = await reviewMemories({logDir, memoryDir, dryRun: true});
    expect(report.processed).toBe(1);
    expect((await loadMemory(memoryDir)).species).toEqual({});
  });
  it('模型复盘可选：非空时调用并合并 notes，失败仅警告', async () => {
    const {logDir, memoryDir} = await scaffold();
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({choices: [{message: {content: JSON.stringify({
          species: {Sneasler: ['rival leads it with Fake Out pressure']},
          cores: {},
        })}}], usage: {}}),
      } as Response;
    }) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', fetchImpl: fakeFetch});
    expect(calls[0]).toContain('openrouter.ai');
    expect(report.modelNotes?.species?.Sneasler?.[0]).toContain('Fake Out');
    expect((await loadMemory(memoryDir)).species.sneasler.notes[0]).toContain('Fake Out');
  });
  it('模型关闭时不做网络调用', async () => {
    const {logDir, memoryDir} = await scaffold();
    const fakeFetch = (async () => {
      throw new Error('不应调用');
    }) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, fetchImpl: fakeFetch});
    expect(report.modelNotes).toBeNull();
  });
  it('--dry-run 不调用付费模型（预览不产生调用费用）', async () => {
    const {logDir, memoryDir} = await scaffold();
    const fakeFetch = (async () => {
      throw new Error('dry-run 不应调用模型');
    }) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, dryRun: true,
      reviewModel: 'test/model', reviewApiKey: 'sk', fetchImpl: fakeFetch});
    expect(report.modelNotes).toBeNull();
    expect(report.modelError).toBeUndefined();
  });
  it('观察数超过 20 时分批调用模型并合并结果；输入含双方队伍', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-batch-logs-'));
    const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-batch-memory-'));
    for (let i = 0; i < 25; i++) {
      const id = `battle-b${String(i).padStart(2, '0')}`;
      await fs.writeFile(path.join(logDir, `${id}.protocol.log`), PROTOCOL);
      await fs.writeFile(path.join(logDir, `${id}.decisions.jsonl`), DECISIONS);
    }
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const n = bodies.length;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({choices: [{message: {content: JSON.stringify({
          species: {Sneasler: [`batch ${n} lesson`]},
          cores: {},
        })}}]}),
      } as Response;
    }) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', fetchImpl: fakeFetch});
    expect(report.processed).toBe(25);
    expect(bodies).toHaveLength(2);
    const countBattles = (content: string): number =>
      content.split('\n').filter(line => line.startsWith('battle ')).length;
    expect(countBattles(bodies[0].messages[1].content as string)).toBe(20);
    expect(countBattles(bodies[1].messages[1].content as string)).toBe(5);
    expect(bodies[0].messages[1].content).toContain('Our team: Golisopod');
    expect(bodies[0].messages[1].content).toContain('Opponent team: Rillaboom/Sneasler');
    expect(report.modelNotes?.species.Sneasler).toEqual(['batch 1 lesson', 'batch 2 lesson']);
  });
  it('默认不发送 max_tokens（不限制输出）；显式设置时透传', async () => {
    const {logDir, memoryDir} = await scaffold();
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({choices: [{message: {content: '{"species":{},"cores":{}}'}}]}),
      } as Response;
    }) as unknown as typeof fetch;
    await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', fetchImpl: fakeFetch});
    expect(bodies[0].max_tokens).toBeUndefined();
    const second = await scaffold();
    await reviewMemories({logDir: second.logDir, memoryDir: second.memoryDir, reviewModel: 'test/model',
      reviewApiKey: 'sk', reviewMaxTokens: 777, fetchImpl: fakeFetch});
    expect(bodies[1].max_tokens).toBe(777);
  });
  it('用户消息末追加对手物种键清单，锚定模型输出键', async () => {
    const {logDir, memoryDir} = await scaffold();
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({choices: [{message: {content: '{"species":{},"cores":{}}'}}]}),
      } as Response;
    }) as unknown as typeof fetch;
    await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', fetchImpl: fakeFetch});
    const content = bodies[0].messages[1].content as string;
    expect(content).toContain('Opponent species seen (use exactly these keys): Rillaboom, Sneasler');
  });
  it('响应缺少文本时错误信息带 finish_reason 便于诊断', async () => {
    const {logDir, memoryDir} = await scaffold();
    const fakeFetch = (async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({choices: [{finish_reason: 'length', message: {reasoning: 'long'}}]}),
    } as Response)) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', retryDelayMs: 0, fetchImpl: fakeFetch});
    expect(report.modelError).toContain('finish_reason=length');
  });
  it('模型输出缺闭合括号时自动修复（长 JSON 偶发漏 ]）', async () => {
    const {logDir, memoryDir} = await scaffold();
    const bad = '{"species":{"Sneasler":["rival leads it with Fake Out pressure"}}';
    const fakeFetch = (async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({choices: [{finish_reason: 'stop', message: {content: bad}}]}),
    } as Response)) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', fetchImpl: fakeFetch});
    expect(report.modelError).toBeUndefined();
    expect(report.modelNotes?.species?.Sneasler?.[0]).toContain('Fake Out');
  });
  it('JSON 无法修复时重试，后续尝试成功则采用', async () => {
    const {logDir, memoryDir} = await scaffold();
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      const content = calls === 1 ? 'not json at all' : JSON.stringify({species: {Sneasler: ['second try lesson']}, cores: {}});
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({choices: [{finish_reason: 'stop', message: {content}}]}),
      } as Response;
    }) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', retryDelayMs: 0, fetchImpl: fakeFetch});
    expect(calls).toBe(2);
    expect(report.modelNotes?.species?.Sneasler?.[0]).toBe('second try lesson');
  });
  it('连续两次瞬时故障（空白 200 响应）后第三次成功', async () => {
    const {logDir, memoryDir} = await scaffold();
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      if (calls < 3) {
        return {ok: true, status: 200, text: async () => '\n\n         \n\n'} as Response;
      }
      const content = '{"species":{"Sneasler":["third try lesson"]},"cores":{}}';
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({choices: [{finish_reason: 'stop', message: {content}}]}),
      } as Response;
    }) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', retryDelayMs: 0, fetchImpl: fakeFetch});
    expect(calls).toBe(3);
    expect(report.modelError).toBeUndefined();
    expect(report.modelNotes?.species?.Sneasler?.[0]).toBe('third try lesson');
  });
  it('响应缺少文本时也重试（全推理无 content 场景）', async () => {
    const {logDir, memoryDir} = await scaffold();
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      const message = calls === 1 ? {reasoning: 'only thinking'} : {content: '{"species":{"Sneasler":["recovered lesson"]},"cores":{}}'};
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({choices: [{finish_reason: calls === 1 ? 'length' : 'stop', message}]}),
      } as Response;
    }) as unknown as typeof fetch;
    const report = await reviewMemories({logDir, memoryDir, reviewModel: 'test/model', reviewApiKey: 'sk', retryDelayMs: 0, fetchImpl: fakeFetch});
    expect(calls).toBe(2);
    expect(report.modelNotes?.species?.Sneasler?.[0]).toBe('recovered lesson');
  });
});
