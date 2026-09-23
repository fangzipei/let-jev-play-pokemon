#!/usr/bin/env node
/**
 * L2 模拟对比：读取真实对局 decisions.jsonl 的全部记录（state/questions 为 advisor 注入前的 L2 快照），
 * 逐条直接调用 jev 决策链（无 advisor 注入），与记录中的 L3 实际答案逐题对比。
 * 产生真实 API 费用；密钥与默认参数从 .env 读取（DOTENV_CONFIG_PATH 可覆盖）。
 * 运行：npx tsx scripts/sim-l2-decisions.ts [--replay=<decisions.jsonl>] [--limit=N] [--only=0,1]
 *       [--model=<id>] [--timeout=25000] [--transport=sdk|fetch|chat]
 * 默认：logs 下最新 *.decisions.jsonl 的全部记录。
 */
import 'dotenv/config';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {nullLogger} from '../src/log/logger.js';
import {createJevClient} from '../src/jev/client.js';
import {parseBenchSample} from '../src/jev/bench.js';

function arg(name: string): string | undefined {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error('缺少 OPENROUTER_API_KEY（.env 或环境变量）');
  process.exit(1);
}

const model = arg('model') ?? process.env.JEV_MODEL ?? '~typesafe/jev-latest';
const timeoutMs = Math.max(1, Number(arg('timeout') ?? process.env.JEV_TIMEOUT_MS ?? 25000));
const transport = (arg('transport') ?? process.env.JEV_TRANSPORT ?? 'sdk') as 'sdk' | 'fetch' | 'chat';
const replayPath = arg('replay') ?? latestDecisionsLog();
const lines = readFileSync(replayPath, 'utf8').split(/\r?\n/).filter(line => line.trim());
const limit = arg('limit') !== undefined ? Math.min(lines.length, Math.max(1, Number(arg('limit')))) : lines.length;
const onlyArg = arg('only');
const indices = onlyArg === undefined
  ? Array.from({length: limit}, (_, i) => i)
  : onlyArg.split(',').map(part => Number(part.trim()));
for (const index of indices) {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    console.error(`--only 行号超出范围: ${index}（共 ${lines.length} 行，0 起）`);
    process.exit(1);
  }
}

console.log(`模拟: ${replayPath}（${indices.length}/${lines.length} 条记录，L2 输入直接调 jev）`);
console.log(`模型: ${model}  传输: ${transport}  超时: ${timeoutMs}ms\n`);

const client = createJevClient({apiKey, model, transport, timeoutMs, retry: 0, logger: nullLogger});
let same = 0;
let diff = 0;
let fail = 0;
let costTotal = 0;
const latencies: number[] = [];
for (const [order, i] of indices.entries()) {
  const sample = parseBenchSample(lines, i);
  const meta = JSON.parse(lines[i]) as {
    turn?: number;
    rqid?: number;
    advisor_status?: string;
    answers?: Record<string, {choice?: string; confidence?: number}>;
  };
  console.log(`[${order + 1}/${indices.length}] 行${i} kind=${sample.kind} turn=${meta.turn ?? '-'} rqid=${meta.rqid ?? '-'}（live advisor=${meta.advisor_status ?? '-'}）`);
  try {
    const result = await client.decide({state: sample.state, questions: sample.questions}, {});
    latencies.push(result.latencyMs);
    costTotal += result.usage.cost ?? 0;
    for (const [name, answer] of Object.entries(result.answers)) {
      const l2 = answer as {choice?: string; confidence?: number};
      const live = meta.answers?.[name];
      const verdict = live?.choice === l2.choice ? '一致' : '不同';
      if (verdict === '一致') same++;
      else diff++;
      console.log(`  ${name}: L2=${l2.choice}(${fmtConf(l2.confidence)})  live=${live?.choice ?? '-'}(${fmtConf(live?.confidence)})  ${verdict}`);
    }
    console.log(`  ${result.latencyMs}ms in=${result.usage.input_tokens ?? '-'} out=${result.usage.output_tokens ?? '-'} $${(result.usage.cost ?? 0).toFixed(6)}\n`);
  } catch (error) {
    fail++;
    console.log(`  ✗ 失败: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
const ms = latencies.length
  ? `${Math.min(...latencies)}/${Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)}/${Math.max(...latencies)}`
  : '-';
console.log(`汇总: 题项一致=${same} 不同=${diff} 调用失败=${fail} 费用=$${costTotal.toFixed(6)} 延迟(min/avg/max ms)=${ms}`);

function fmtConf(conf: number | undefined): string {
  return conf === undefined ? '-' : conf.toFixed(2);
}

function latestDecisionsLog(): string {
  const dir = path.join(process.cwd(), 'logs');
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.decisions.jsonl'))
    .map(f => ({f, mtime: statSync(path.join(dir, f)).mtimeMs}))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) {
    console.error('logs 下没有 *.decisions.jsonl；用 --replay=<路径> 指定');
    process.exit(1);
  }
  return path.join(dir, files[0].f);
}
