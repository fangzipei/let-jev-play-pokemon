#!/usr/bin/env node
/**
 * L3 本地重放：读取真实对局 decisions.jsonl 的全部决策记录，逐条调用 advisor 并打印建议全文。
 * 输入与 L3 生产链路一致：advisor 收到的是注入前的 state/questions 快照（L2 与 L3 快照构建相同）。
 * 产生真实 API 费用；密钥与默认参数从 .env 读取（DOTENV_CONFIG_PATH 可覆盖）。
 * 运行：npx tsx scripts/replay-advisor.ts [--replay=<decisions.jsonl>] [--limit=N] [--only=0,1,7]
 *       [--model=<id>] [--timeout=13000] [--max-tokens=2048] [--reasoning=low|medium|high]
 * 默认：logs 下最新 *.decisions.jsonl 的全部记录；--only 指定行号（0 起）时忽略 --limit。
 * --reasoning 缺省时取 JEV_ADVISOR_REASONING；留空则不发送推理参数。
 */
import 'dotenv/config';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {nullLogger} from '../src/log/logger.js';
import {createAdvisorClient} from '../src/jev/advisor.js';
import {parseBenchSample} from '../src/jev/bench.js';

function arg(name: string): string | undefined {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
}

const apiKey = process.env.JEV_ADVISOR_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error('缺少 JEV_ADVISOR_API_KEY / OPENROUTER_API_KEY（.env 或环境变量）');
  process.exit(1);
}

const model = arg('model') ?? process.env.JEV_ADVISOR_MODEL ?? 'google/gemini-3.8-flash';
const timeoutMs = Math.max(1, Number(arg('timeout') ?? process.env.JEV_ADVISOR_TIMEOUT_MS ?? 10000));
const maxTokens = Math.max(1, Number(arg('max-tokens') ?? process.env.JEV_ADVISOR_MAX_TOKENS ?? 2048));
const reasoning = arg('reasoning') ?? process.env.JEV_ADVISOR_REASONING;
if (reasoning !== undefined && !['low', 'medium', 'high'].includes(reasoning)) {
  console.error(`--reasoning 或 JEV_ADVISOR_REASONING 仅支持 low|medium|high（收到 ${reasoning}）`);
  process.exit(1);
}
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

console.log(`重放: ${replayPath}（${indices.length}/${lines.length} 条记录）`);
console.log(`advisor 模型: ${model}  超时: ${timeoutMs}ms  max_tokens: ${maxTokens}${reasoning ? `  reasoning_effort: ${reasoning}` : ''}\n`);

const client = createAdvisorClient({
  apiKey, model, timeoutMs, maxTokens, logger: nullLogger,
  ...(reasoning !== undefined ? {reasoningEffort: reasoning as 'low' | 'medium' | 'high'} : {}),
});
let ok = 0;
let fail = 0;
let costTotal = 0;
const latencies: number[] = [];
for (const [order, i] of indices.entries()) {
  const sample = parseBenchSample(lines, i);
  const meta = JSON.parse(lines[i]) as {turn?: number; rqid?: number};
  console.log(`[${order + 1}/${indices.length}] 行${i} kind=${sample.kind} turn=${meta.turn ?? '-'} rqid=${meta.rqid ?? '-'}`);
  const result = await client.analyze({kind: sample.kind, state: sample.state, questions: sample.questions}, {});
  if (result === null) {
    fail++;
    console.log('  ✗ 未返回分析（超时或请求失败）\n');
    continue;
  }
  costTotal += result.usage.cost ?? 0;
  latencies.push(result.latencyMs);
  const text = result.text.trim();
  if (!text) {
    fail++;
    console.log(`  ✗ 空文本（${result.latencyMs}ms in=${result.usage.input_tokens ?? '-'} out=${result.usage.output_tokens ?? '-'} $${(result.usage.cost ?? 0).toFixed(6)}）\n`);
    continue;
  }
  ok++;
  console.log(`  ${result.latencyMs}ms  in=${result.usage.input_tokens ?? '-'} out=${result.usage.output_tokens ?? '-'}  $${(result.usage.cost ?? 0).toFixed(6)}`);
  console.log('  ─── 建议 ───');
  console.log(text.split(/\r?\n/).map(line => `  ${line}`).join('\n'));
  console.log('  ────────────\n');
}
const ms = latencies.length
  ? `${Math.min(...latencies)}/${Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)}/${Math.max(...latencies)}`
  : '-';
console.log(`汇总: ok=${ok}/${indices.length} 失败=${fail} 费用=$${costTotal.toFixed(6)} 延迟(min/avg/max ms)=${ms}`);

function latestDecisionsLog(): string {
  const dir = path.join(process.cwd(), 'logs');
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.decisions.jsonl'))
    .map(f => ({f, mtime: statSync(path.join(dir, f)).mtimeMs}))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) {
    console.error('logs 下没有 *.decisions.jsonl；用 --replay=<路径> 指定重放样本');
    process.exit(1);
  }
  return path.join(dir, files[0].f);
}
