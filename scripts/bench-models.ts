#!/usr/bin/env node
/**
 * 模型速度基准：重放真实对局决策样本，串行对比候选模型在 chat 决策与 advisor 两条链路的延迟/费用/合规。
 * 产生真实 API 费用；OPENROUTER_API_KEY 从 .env 读取（DOTENV_CONFIG_PATH 可覆盖）。
 * 运行：npx tsx scripts/bench-models.ts [--models=a,b,c] [--replay=<decisions.jsonl>] [--index=N]
 *       [--repeat=N] [--kind=decision|advisor|both] [--timeout=60000]
 *       [--advisor-reasoning=low|medium|high] [--advisor-max-tokens=N]
 * 默认：取 logs 下最新 *.decisions.jsonl 的最后一条 turn 记录；每模型决策+advisor 各 repeat 次。
 */
import 'dotenv/config';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {nullLogger} from '../src/log/logger.js';
import {createAdvisorClient} from '../src/jev/advisor.js';
import {createJevClient} from '../src/jev/client.js';
import {benchAdvisor, benchDecision, parseBenchSample, summarizeBench, type BenchAttempt} from '../src/jev/bench.js';

// 默认候选：本地区可用厂商的 flash 级模型 + jev 本尊（验证其 Chat Completions 可用性）
const DEFAULT_MODELS = [
  'xiaomi/mimo-v2.6-flash',
  'deepseek/deepseek-v4.1-flash',
  '~deepseek/deepseek-flash-latest',
  'deepseek/deepseek-v4-flash',
  'qwen/qwen3.8-flash',
  'qwen/qwen3.7-flash',
  '~typesafe/jev-latest',
].join(',');

function arg(name: string): string | undefined {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error('缺少 OPENROUTER_API_KEY（.env 或环境变量）');
  process.exit(1);
}

const models = (arg('models') ?? DEFAULT_MODELS).split(',').map(m => m.trim()).filter(Boolean);
const repeat = Math.max(1, Number(arg('repeat') ?? 1));
const timeoutMs = Math.max(1, Number(arg('timeout') ?? 60000));
const kind = (arg('kind') ?? 'both') as 'decision' | 'advisor' | 'both';
if (!['decision', 'advisor', 'both'].includes(kind)) {
  console.error(`--kind 仅支持 decision|advisor|both（收到 ${kind}）`);
  process.exit(1);
}
const advisorReasoning = arg('advisor-reasoning');
if (advisorReasoning !== undefined && !['low', 'medium', 'high'].includes(advisorReasoning)) {
  console.error(`--advisor-reasoning 仅支持 low|medium|high（收到 ${advisorReasoning}）`);
  process.exit(1);
}
const advisorMaxTokens = arg('advisor-max-tokens') !== undefined ? Number(arg('advisor-max-tokens')) : undefined;

const replayPath = arg('replay') ?? latestDecisionsLog();
const lines = readFileSync(replayPath, 'utf8').split(/\r?\n/).filter(line => line.trim());
const index = arg('index') !== undefined ? Number(arg('index')) : lastIndexForKind(lines, 'turn');
const sample = parseBenchSample(lines, index);
console.log(`重放样本: ${replayPath} 第 ${index} 行（kind=${sample.kind}）`);
console.log(`模型: ${models.join(', ')}`);
console.log(`角色: ${kind}  每组合 ${repeat} 次  超时 ${timeoutMs}ms\n`);

const costByRole: Record<string, number> = {决策: 0, advisor: 0};
for (const model of models) {
  if (kind !== 'advisor') {
    const client = createJevClient({apiKey, model, transport: 'chat', timeoutMs, retry: 0, logger: nullLogger});
    const attempts = await benchDecision(model, client, sample, repeat);
    printAttempts('决策', attempts);
    costByRole['决策'] += summarizeBench(model, attempts).costTotal;
  }
  if (kind !== 'decision') {
    const client = createAdvisorClient({
      apiKey,
      model,
      timeoutMs,
      logger: nullLogger,
      ...(advisorMaxTokens !== undefined ? {maxTokens: advisorMaxTokens} : {}),
      ...(advisorReasoning !== undefined ? {reasoningEffort: advisorReasoning as 'low' | 'medium' | 'high'} : {}),
    });
    const attempts = await benchAdvisor(model, client, sample, repeat);
    printAttempts('advisor', attempts);
    costByRole.advisor += summarizeBench(model, attempts).costTotal;
  }
}
const total = Object.values(costByRole).reduce((sum, v) => sum + v, 0);
console.log(`\n总费用: ${Object.entries(costByRole).map(([role, cost]) => `${role} $${cost.toFixed(6)}`).join(' + ')} = $${total.toFixed(6)}`);

function printAttempts(role: string, attempts: BenchAttempt[]): void {
  const summary = summarizeBench(attempts[0]?.model ?? '?', attempts);
  const ms = summary.minMs === undefined ? '-' : `${summary.minMs}/${summary.avgMs}/${summary.maxMs}`;
  console.log(`[${role}] ${summary.model}: ok=${summary.ok}/${summary.attempts} 延迟(min/avg/max ms)=${ms} 费用=$${summary.costTotal.toFixed(6)}`);
  for (const attempt of attempts) {
    const detail = attempt.ok
      ? `${attempt.latencyMs}ms in=${attempt.inputTokens ?? '-'} out=${attempt.outputTokens ?? '-'} $${attempt.cost ?? 0}`
      : `失败: ${attempt.error}`;
    console.log(`  #${attempt.attempt} ${detail}`);
  }
}

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

function lastIndexForKind(lines: string[], kind: string): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      if ((JSON.parse(lines[i]) as {kind?: string}).kind === kind) return i;
    } catch {
      // 跳过无法解析的行
    }
  }
  return lines.length - 1;
}
