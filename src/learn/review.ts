// src/learn/review.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import {extractObservation, type BattleObservation} from './extract.js';
import {applyModelNotes, loadMemory, mergeObservation, saveMemory} from './store.js';

export interface ReviewOptions {
  logDir: string;
  memoryDir: string;
  dryRun?: boolean;
  reviewModel?: string;
  reviewApiKey?: string;
  /** 未设置 = 不发送 max_tokens（不限制输出，含推理 token）；显式设置时必须为正整数。 */
  reviewMaxTokens?: number;
  /** 解析类瞬时故障重试前的等待毫秒数；默认 2000，0 = 立即重试（测试用）。 */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface ReviewReport {
  processed: number;
  skipped: number;
  failed: number;
  observations: BattleObservation[];
  modelNotes: {species: Record<string, string[]>; cores: Record<string, string[]>} | null;
  modelError?: string;
}

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

const REVIEW_PROMPT = `You are the coach of OUR Pokemon Showdown VGC (doubles) team, reviewing our recent ladder battles. Each input line is one battle: the battle id, whether we won or lost, our team, the opponent team, and every opponent Pokemon whose item, ability, moves or lead position was revealed.

Think through all battles carefully before answering: look for repeating opponent habits (leads, move choices, items, abilities, and how the battles ended for us) and turn the ones that would change our future play into short lessons. Then respond with STRICT JSON only, no markdown fences, no commentary:
{"species":{"Exact Species Name":["one short English lesson"]},"cores":{"SpeciesA+SpeciesB":["one short lesson"]}}

Rules:
- Species keys must be copied exactly from the "Opponent species seen" list at the end of the input; never invent names.
- Core keys are two species seen in the same battles, formatted "SpeciesA+SpeciesB".
- Each value is an array with exactly one short, concrete, actionable English lesson (one sentence) grounded in the battles above.
- Include an entry only when a real pattern repeats across the battles; when unsure, leave the section empty.`;

function compactBattle(obs: BattleObservation): string {
  const our = obs.ourSpecies.length ? obs.ourSpecies.join('/') : 'unknown';
  const team = obs.opponentSpecies.join('/');
  const revealed = obs.revealed.map(r => {
    const bits = [r.species];
    if (r.item) bits.push(`item ${r.item}`);
    if (r.ability) bits.push(`ability ${r.ability}`);
    if (r.moves.length) bits.push(`moves ${r.moves.join('/')}`);
    if (r.led) bits.push('led');
    return bits.join(' ');
  }).join('; ');
  return `battle ${obs.battleId}: ${obs.won ? 'we won' : 'we lost'}. Our team: ${our}. Opponent team: ${team}. Revealed: ${revealed || 'none'}.`;
}

interface ModelNotes {species: Record<string, string[]>; cores: Record<string, string[]>}

/** 单次请求的观察局数上限（控制请求体量与单次延迟）。 */
const BATCH_SIZE = 20;

/** 宽容补全模型偶发漏掉的闭合括号（字符串感知，不改动字符串内容）。 */
function repairJson(text: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
      out.push(ch);
    } else if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '[';
      while (stack.length && stack[stack.length - 1] !== want) {
        out.push(stack.pop() === '{' ? '}' : ']');
      }
      if (stack.length) stack.pop();
      out.push(ch);
    } else {
      out.push(ch);
    }
  }
  if (inString) out.push('"');
  while (stack.length) out.push(stack.pop() === '{' ? '}' : ']');
  return out.join('');
}

async function collectNotesBatch(
  observations: BattleObservation[],
  opts: {model: string; apiKey: string; maxTokens?: number; retryDelayMs?: number; fetchImpl?: typeof fetch},
): Promise<ModelNotes> {
  const doFetch = opts.fetchImpl ?? fetch;
  const speciesKeys = [...new Set(observations.flatMap(o => o.opponentSpecies))].sort();
  const userContent = [
    observations.map(compactBattle).join('\n'),
    `Opponent species seen (use exactly these keys): ${speciesKeys.join(', ')}`,
  ].join('\n\n');
  const body = JSON.stringify({
    model: opts.model,
    stream: false,
    ...(opts.maxTokens !== undefined ? {max_tokens: opts.maxTokens} : {}),
    messages: [
      {role: 'system', content: REVIEW_PROMPT},
      {role: 'user', content: userContent},
    ],
  });
  const attempt = async (): Promise<ModelNotes> => {
    const res = await doFetch(CHAT_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}`},
      body,
    });
    if (!res.ok) throw new Error(`review HTTP ${res.status}`);
    const raw = JSON.parse(await res.text()) as Record<string, any>;
    const content: unknown = raw?.choices?.[0]?.message?.content;
    const finish: unknown = raw?.choices?.[0]?.finish_reason;
    if (typeof content !== 'string') {
      throw new Error(`review 响应缺少文本${typeof finish === 'string' ? `（finish_reason=${finish}）` : ''}`);
    }
    const jsonText = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      // 模型长 JSON 偶发漏掉闭合符号：先容错补全再解析
      parsed = JSON.parse(repairJson(jsonText)) as Record<string, unknown>;
    }
    const pick = (value: unknown): Record<string, string[]> => {
      if (!value || typeof value !== 'object') return {};
      const out: Record<string, string[]> = {};
      for (const [key, notes] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(notes)) {
          const clean = notes.filter((n): n is string => typeof n === 'string' && !!n.trim()).slice(0, 1);
          if (clean.length) out[key] = clean;
        }
      }
      return out;
    };
    return {species: pick(parsed.species), cores: pick(parsed.cores)};
  };
  // 解析类错误多为模型输出随机性或上游瞬时返空（如 200 + 空响应）：重试至多两次（共三次尝试）
  const retryable = (error: unknown): boolean =>
    error instanceof SyntaxError || (error instanceof Error && error.message.startsWith('review 响应缺少文本'));
  const delayMs = opts.retryDelayMs ?? 2000;
  let lastError: unknown;
  for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!retryable(error)) throw error;
      if (attemptNo < 2 && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function mergeNotes(target: ModelNotes, part: ModelNotes): void {
  for (const section of ['species', 'cores'] as const) {
    for (const [key, list] of Object.entries(part[section])) {
      const existing = target[section][key] ?? [];
      target[section][key] = [...existing, ...list.filter(n => !existing.includes(n))];
    }
  }
}

export async function collectModelNotes(
  observations: BattleObservation[],
  opts: {model: string; apiKey: string; maxTokens?: number; retryDelayMs?: number; fetchImpl?: typeof fetch},
): Promise<ModelNotes | null> {
  const merged: ModelNotes = {species: {}, cores: {}};
  const batches: BattleObservation[][] = [];
  for (let i = 0; i < observations.length; i += BATCH_SIZE) batches.push(observations.slice(i, i + BATCH_SIZE));
  for (const batch of batches) {
    mergeNotes(merged, await collectNotesBatch(batch, opts));
  }
  return merged;
}

/** 扫描本地日志增量入经验库；模型复盘仅在配置 reviewModel 时追加。不自动执行。 */
export async function reviewMemories(opts: ReviewOptions): Promise<ReviewReport> {
  const log = opts.log ?? (() => {});
  const memory = await loadMemory(opts.memoryDir);
  const files = (await fs.readdir(opts.logDir).catch(() => [] as string[]))
    .filter(f => f.endsWith('.protocol.log'))
    .sort();
  const report: ReviewReport = {processed: 0, skipped: 0, failed: 0, observations: [], modelNotes: null};
  for (const file of files) {
    const battleId = file.replace(/\.protocol\.log$/, '');
    if (memory.processed[battleId]) {
      report.skipped++;
      continue;
    }
    const protocolLog = await fs.readFile(path.join(opts.logDir, file), 'utf8').catch(() => null);
    const decisionsJsonl = await fs.readFile(path.join(opts.logDir, `${battleId}.decisions.jsonl`), 'utf8').catch(() => '');
    if (protocolLog === null) {
      report.failed++;
      log(`跳过 ${battleId}：无法读取 protocol.log`);
      continue;
    }
    const observation = extractObservation(protocolLog, decisionsJsonl, {battleId});
    if (!observation) {
      report.failed++;
      log(`跳过 ${battleId}：无法判定我方 side 或缺少胜负行`);
      continue;
    }
    mergeObservation(memory, observation);
    report.observations.push(observation);
    report.processed++;
  }
  if (!opts.dryRun) {
    await saveMemory(opts.memoryDir, memory);
  }
  if (opts.dryRun && opts.reviewModel) {
    log('dry-run：跳过模型复盘（不产生调用费用）');
  }
  if (!opts.dryRun && opts.reviewModel && opts.reviewApiKey && report.observations.length) {
    try {
      report.modelNotes = await collectModelNotes(report.observations, {
        model: opts.reviewModel, apiKey: opts.reviewApiKey,
        maxTokens: opts.reviewMaxTokens, retryDelayMs: opts.retryDelayMs, fetchImpl: opts.fetchImpl,
      });
      if (report.modelNotes && !opts.dryRun) {
        const applied = applyModelNotes(memory, report.modelNotes);
        log(`模型复盘写入 ${applied} 条经验`);
        await saveMemory(opts.memoryDir, memory);
      }
    } catch (error) {
      report.modelError = error instanceof Error ? error.message : String(error);
      log(`模型复盘失败（仅保留规则提取）：${report.modelError}`);
    }
  }
  return report;
}
