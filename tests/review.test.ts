// tests/review.test.ts
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {reviewMemories} from '../src/learn/review.js';
import {emptyMemory, loadMemory, saveMemory} from '../src/learn/store.js';

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

function modelResponse(content: unknown): Response {
  return {ok: true, status: 200,
    text: async () => JSON.stringify({choices: [{message: {content: JSON.stringify(content)}}]}),
  } as Response;
}

const LESSON = {species: {Sneasler: ['Fake Out pressure']}, cores: {}};
const MODEL = {reviewModel: 'test/model', reviewApiKey: 'test-key', retryDelayMs: 0};

describe('reviewMemories', () => {
  it('规则入库后再开启模型可补跑，模型成功后不重复调用或累计战绩', async () => {
    const dirs = await scaffold();
    await reviewMemories(dirs);
    let calls = 0;
    const fetchImpl = (async () => { calls++; return modelResponse(LESSON); }) as typeof fetch;
    const report = await reviewMemories({...dirs, ...MODEL, fetchImpl});
    expect(report).toMatchObject({processed: 0, skipped: 1, modelReviewed: 1, modelPending: 0,
      modelApplication: {received: 1, added: 1, duplicates: 0, unmatched: 0}});
    const memory = await loadMemory(dirs.memoryDir);
    expect(memory.modelReviews['battle-aaa']).toBe('complete');
    expect(memory.species.sneasler.seen).toBe(1);
    expect(memory.cores['rillaboom+sneasler'].seen).toBe(1);
    await reviewMemories({...dirs, ...MODEL, fetchImpl});
    expect(calls).toBe(1);
  });

  it('CLI --retry-model --dry-run 接线有效，不读真实环境或写库', async () => {
    const dirs = await scaffold();
    await reviewMemories(dirs);
    const data = await loadMemory(dirs.memoryDir);
    data.modelReviews['battle-aaa'] = 'complete';
    await saveMemory(dirs.memoryDir, data);
    const before = await fs.readFile(path.join(dirs.memoryDir, 'memory.json'), 'utf8');
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'review', '--retry-model', '--dry-run'], {
      encoding: 'utf8', timeout: 15000,
      env: {...process.env, DOTENV_CONFIG_PATH: path.join(dirs.logDir, 'nonexistent.env'),
        LOG_DIR: dirs.logDir, JEV_MEMORY_DIR: dirs.memoryDir, JEV_REVIEW_MODEL: '', JEV_REVIEW_API_KEY: '',
        OPENROUTER_API_KEY: '', JEV_MOCK: '1'},
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('重新提炼 1 局');
    expect(child.stdout).toContain('待模型复盘 1 局');
    expect(await fs.readFile(path.join(dirs.memoryDir, 'memory.json'), 'utf8')).toBe(before);
  }, 20000);

  it('模型输出被截断时不把补全后的部分 JSON 标记成功', async () => {
    const dirs = await scaffold();
    const report = await reviewMemories({...dirs, ...MODEL, fetchImpl: (async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({choices: [{finish_reason: 'length', message: {content: '{"species":{"Sneasler":["partial'}}]}),
    } as Response)) as typeof fetch});
    expect(report.modelError).toContain('finish_reason=length');
    expect(report.modelPending).toBe(1);
    expect((await loadMemory(dirs.memoryDir)).species.sneasler.notes).toEqual([]);
  });

  it('模型产物保存失败不报告写入成功，也不持久化完成标记', async () => {
    const dirs = await scaffold();
    const messages: string[] = [];
    const rename = fs.rename.bind(fs);
    let saves = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (++saves === 2) throw new Error('test disk failure');
      return rename(...args);
    });
    try {
      const report = await reviewMemories({...dirs, ...MODEL, log: m => messages.push(m),
        fetchImpl: (async () => modelResponse(LESSON)) as typeof fetch});
      expect(report.modelError).toContain('test disk failure');
      expect(report).toMatchObject({modelReviewed: 0, modelPending: 1, modelApplication: {added: 0}});
      expect(messages.join('\n')).not.toContain('（已保存）');
      const saved = await loadMemory(dirs.memoryDir);
      expect(saved.modelReviews['battle-aaa']).toBe('pending');
      expect(saved.species.sneasler.notes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const retry = await reviewMemories({...dirs, ...MODEL, fetchImpl: (async () => modelResponse(LESSON)) as typeof fetch});
    expect(retry.modelReviewed).toBe(1);
    expect((await loadMemory(dirs.memoryDir)).species.sneasler.seen).toBe(1);
  });

  it('模型失败后下次仅补模型，不重加规则统计', async () => {
    const dirs = await scaffold();
    const failed = await reviewMemories({...dirs, ...MODEL, fetchImpl: (async () => {
      return {ok: false, status: 503} as Response;
    }) as typeof fetch});
    expect(failed.modelError).toContain('503');
    expect(failed.modelPending).toBe(1);
    const recovered = await reviewMemories({...dirs, ...MODEL,
      fetchImpl: (async () => modelResponse(LESSON)) as typeof fetch});
    expect(recovered.modelReviewed).toBe(1);
    expect((await loadMemory(dirs.memoryDir)).species.sneasler.seen).toBe(1);
  });

  it('合法空结果明确解释并记录 empty，普通重跑不重复付费', async () => {
    const dirs = await scaffold();
    const messages: string[] = [];
    let calls = 0;
    const fetchImpl = (async () => { calls++; return modelResponse({species: {}, cores: {}}); }) as typeof fetch;
    const report = await reviewMemories({...dirs, ...MODEL, fetchImpl, log: m => messages.push(m)});
    expect(report.modelApplication).toMatchObject({received: 0, added: 0, unmatched: 0});
    expect(messages.join('\n')).toContain('未发现可重复模式');
    expect((await loadMemory(dirs.memoryDir)).modelReviews['battle-aaa']).toBe('empty');
    await reviewMemories({...dirs, ...MODEL, fetchImpl});
    expect(calls).toBe(1);
  });

  it.each([{}, [], null, {species: {Sneasler: 'wrong'}}, {species: {Sneasler: [' ']}}, {cores: []}].map(content => [content]))(
    '格式错误不冒充空经验成功：%j', async content => {
      const dirs = await scaffold();
      const report = await reviewMemories({...dirs, ...MODEL,
        fetchImpl: (async () => modelResponse(content)) as typeof fetch});
      expect(report.modelError).toContain('响应格式错误');
      expect(report.modelPending).toBe(1);
      expect((await loadMemory(dirs.memoryDir)).modelReviews['battle-aaa']).toBe('pending');
    },
  );

  it('未匹配键明确报告且保持待补跑，不标记模型成功', async () => {
    const dirs = await scaffold();
    const messages: string[] = [];
    const report = await reviewMemories({...dirs, ...MODEL, log: m => messages.push(m),
      fetchImpl: (async () => modelResponse({species: {Invented: ['lesson']}, cores: {}})) as typeof fetch});
    expect(report.modelApplication).toMatchObject({received: 1, added: 0, unmatched: 1, unmatchedKeys: ['species:Invented']});
    expect(report).toMatchObject({modelPending: 1, modelReviewed: 0});
    expect(messages.join('\n')).toContain('未匹配键：species:Invented');
    expect((await loadMemory(dirs.memoryDir)).modelReviews['battle-aaa']).toBe('pending');
  });

  it('旧库不静默重跑付费模型；显式 retryModel 可补写正确物种，不污染历史计数', async () => {
    const dirs = await scaffold();
    const protocol = PROTOCOL.replaceAll('Sneasler, L50, F', 'Indeedee-F, L50, F').replaceAll('p2a: Sneasler', 'p2a: Indeedee');
    await fs.writeFile(path.join(dirs.logDir, 'battle-aaa.protocol.log'), protocol);
    const legacy = emptyMemory();
    legacy.processed['battle-aaa'] = 'old-time';
    legacy.species.indeedee = {name: 'Indeedee', seen: 2, wins: 1, losses: 1, leads: 2,
      items: {}, abilities: {}, moves: {}, notes: ['legacy note']};
    await saveMemory(dirs.memoryDir, legacy);
    let calls = 0;
    const fetchImpl = (async () => { calls++; return modelResponse({species: {'Indeedee-F': ['Follow Me pattern']}, cores: {}}); }) as typeof fetch;
    const messages: string[] = [];
    await reviewMemories({...dirs, ...MODEL, fetchImpl, log: m => messages.push(m)});
    expect(calls).toBe(0);
    expect(messages.join('\n')).toContain('--retry-model');
    const report = await reviewMemories({...dirs, ...MODEL, fetchImpl, retryModel: true});
    expect(calls).toBe(1);
    expect(report).toMatchObject({processed: 0, modelReviewed: 1, modelApplication: {added: 1}});
    const after = await loadMemory(dirs.memoryDir);
    expect(after.species.indeedee).toEqual(legacy.species.indeedee);
    expect(after.species.indeedeef.notes).toEqual(['Follow Me pattern']);
    expect(after.processed).toEqual(legacy.processed);
  });

  it('retryModel 可重新提炼已成功对局，重复经验不虚报新增', async () => {
    const dirs = await scaffold();
    const fetchImpl = (async () => modelResponse(LESSON)) as typeof fetch;
    await reviewMemories({...dirs, ...MODEL, fetchImpl});
    const messages: string[] = [];
    const report = await reviewMemories({...dirs, ...MODEL, fetchImpl, retryModel: true, log: m => messages.push(m)});
    expect(report.modelApplication).toMatchObject({received: 1, added: 0, duplicates: 1});
    expect(messages.join('\n')).toContain('新增 0');
    expect((await loadMemory(dirs.memoryDir)).species.sneasler.seen).toBe(1);
  });

  it('retryModel 的 dry-run 不写库、不请求模型，列出待复盘数量', async () => {
    const dirs = await scaffold();
    await reviewMemories(dirs);
    const before = await fs.readFile(path.join(dirs.memoryDir, 'memory.json'), 'utf8');
    let calls = 0;
    const report = await reviewMemories({...dirs, ...MODEL, retryModel: true, dryRun: true,
      fetchImpl: (async () => { calls++; return modelResponse(LESSON); }) as typeof fetch});
    expect(calls).toBe(0);
    expect(report.modelPending).toBe(1);
    expect(await fs.readFile(path.join(dirs.memoryDir, 'memory.json'), 'utf8')).toBe(before);
  });

  it('多批复盘第二批失败时保留第一批，下次只补失败批次', async () => {
    const dirs = await scaffold();
    for (let i = 0; i < 20; i++) {
      const id = `battle-extra-${String(i).padStart(2, '0')}`;
      await fs.writeFile(path.join(dirs.logDir, `${id}.protocol.log`), PROTOCOL);
      await fs.writeFile(path.join(dirs.logDir, `${id}.decisions.jsonl`), DECISIONS);
    }
    let calls = 0;
    const first = await reviewMemories({...dirs, ...MODEL, fetchImpl: (async () => {
      calls++;
      return calls === 1 ? modelResponse(LESSON) : {ok: false, status: 503} as Response;
    }) as typeof fetch});
    expect(first).toMatchObject({modelReviewed: 20, modelPending: 1});
    expect((await loadMemory(dirs.memoryDir)).species.sneasler.notes).toEqual(LESSON.species.Sneasler);
    const bodies: string[] = [];
    const second = await reviewMemories({...dirs, ...MODEL, fetchImpl: (async (_url, init) => {
      bodies.push(String(init?.body)); return modelResponse(LESSON);
    }) as typeof fetch});
    expect(second).toMatchObject({processed: 0, modelReviewed: 1, modelPending: 0});
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).messages[1].content.split('\n').filter((line: string) => line.startsWith('battle '))).toHaveLength(1);
    expect((await loadMemory(dirs.memoryDir)).species.sneasler.seen).toBe(21);
  });

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
