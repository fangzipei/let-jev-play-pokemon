// src/learn/review.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import {extractObservation, type BattleObservation} from './extract.js';
import {applyModelNotes, coreKey, emptyModelApplication, loadMemory, mergeObservation, saveMemory,
  type ModelNoteApplication, type ModelNoteScope} from './store.js';

export interface ReviewOptions {
  logDir: string;
  memoryDir: string;
  dryRun?: boolean;
  /** 显式重新提炼全部可读取日志，包括旧库和已完成的模型复盘；不重加规则统计。 */
  retryModel?: boolean;
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
  modelReviewed: number;
  modelPending: number;
  modelApplication: ModelNoteApplication;
}

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

const REVIEW_PROMPT = `You are the coach of OUR Pokemon Showdown VGC (doubles) team, reviewing our recent ladder battles. Each input line is one battle: the battle id, whether we won or lost, our team, the opponent team, and every opponent Pokemon whose item, ability, moves or lead position was revealed.

Think through all battles carefully before answering: look for repeating opponent habits (leads, move choices, items, abilities, and how the battles ended for us) and turn the ones that would change our future play into short lessons. Then respond with STRICT JSON only, no markdown fences, no commentary:
{"species":{"Exact Species Name":["one short English lesson"]},"cores":{"SpeciesA+SpeciesB":["one short lesson"]}}

Rules:
- Species keys must be copied exactly from the "Opponent species seen" list at the end of the input; never invent names.
- Core keys must be copied from the "Opponent cores seen" list, formatted "SpeciesA+SpeciesB".
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

/** 输出键来自当前批次真实日志，不从历史昵称或模型猜测扩充。 */
function noteScope(observations: BattleObservation[]): ModelNoteScope {
  const species = new Set(observations.flatMap(o => [...o.opponentSpecies, ...o.revealed.map(r => r.species)]));
  const cores = new Map<string, string>();
  for (const obs of observations) {
    const team = [...new Set(obs.opponentSpecies)];
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        cores.set(coreKey(team[i], team[j]), [team[i], team[j]].sort().join('+'));
      }
    }
  }
  return {species: [...species].sort(), cores: [...cores.values()].sort()};
}

/** 合法空结果与格式错误分开；格式错误可重试，不能静默丢成 0 条。 */
function parseModelNotes(parsed: unknown): ModelNotes {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(parsed) || (!('species' in parsed) && !('cores' in parsed))) {
    throw new SyntaxError('review 响应格式错误：需要 species/cores 对象');
  }
  const result: ModelNotes = {species: {}, cores: {}};
  for (const section of ['species', 'cores'] as const) {
    if (!(section in parsed)) continue;
    const value = parsed[section];
    if (!isRecord(value)) throw new SyntaxError(`review 响应格式错误：${section} 必须为对象`);
    for (const [key, notes] of Object.entries(value)) {
      if (!key.trim() || !Array.isArray(notes) || notes.length !== 1 || typeof notes[0] !== 'string' || !notes[0].trim()) {
        throw new SyntaxError(`review 响应格式错误：${section} 每项必须为一个非空字符串的数组`);
      }
      Object.defineProperty(result[section], key, {value: [notes[0].trim()], enumerable: true, configurable: true, writable: true});
    }
  }
  return result;
}

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
  const scope = noteScope(observations);
  const userContent = [
    observations.map(compactBattle).join('\n'),
    `Opponent species seen (use exactly these keys): ${scope.species.join(', ')}`,
    `Opponent cores seen (use exactly these keys): ${scope.cores.join(', ')}`,
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
    if (finish === 'length') throw new SyntaxError('review 响应被截断（finish_reason=length），不能作为完整经验保存');
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
    return parseModelNotes(parsed);
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
      const existing = Object.hasOwn(target[section], key) ? target[section][key] : [];
      Object.defineProperty(target[section], key, {value: [...existing, ...list.filter(n => !existing.includes(n))],
        enumerable: true, configurable: true, writable: true});
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
  if (opts.retryModel && !opts.dryRun && (!opts.reviewModel || !opts.reviewApiKey)) {
    throw new Error('--retry-model 需要配置复盘模型和 API key；可先使用 --dry-run 预览');
  }
  let memory = await loadMemory(opts.memoryDir);
  const files = (await fs.readdir(opts.logDir).catch(() => [] as string[]))
    .filter(f => f.endsWith('.protocol.log'))
    .sort();
  const report: ReviewReport = {processed: 0, skipped: 0, failed: 0, observations: [], modelNotes: null,
    modelReviewed: 0, modelPending: 0, modelApplication: emptyModelApplication()};
  const pending: BattleObservation[] = [];
  let legacySkipped = 0;
  for (const file of files) {
    const battleId = file.replace(/\.protocol\.log$/, '');
    const processed = !!memory.processed[battleId];
    if (processed) {
      report.skipped++;
      if (!opts.retryModel && memory.modelReviews[battleId] !== 'pending') {
        if (!memory.modelReviews[battleId]) legacySkipped++;
        continue;
      }
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
    if (!processed) {
      mergeObservation(memory, observation);
      report.observations.push(observation);
      report.processed++;
    }
    memory.modelReviews[battleId] = 'pending';
    pending.push(observation);
  }
  report.modelPending = Object.values(memory.modelReviews).filter(status => status === 'pending').length;
  if (legacySkipped) log(`旧库 ${legacySkipped} 局缺少模型进度；如需重新提炼，使用 --retry-model（会产生模型调用费用）`);
  if (opts.retryModel) log(`重新提炼 ${pending.length} 局；不重复累计战绩，预计 ${Math.ceil(pending.length / BATCH_SIZE)} 批模型请求（不含故障重试）`);
  if (!opts.dryRun) await saveMemory(opts.memoryDir, memory);
  if (opts.dryRun) {
    log(`dry-run：待模型复盘 ${report.modelPending} 局，不写库、不调用模型`);
    return report;
  }
  if (!opts.reviewModel || !opts.reviewApiKey) {
    log(`模型复盘未启用或缺少 API key；待复盘 ${report.modelPending} 局，规则统计已保存`);
    return report;
  }
  // 每批独立落盘；后批失败不丢前批经验，下次只补 pending。
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    try {
      const notes = await collectNotesBatch(batch, {
        model: opts.reviewModel, apiKey: opts.reviewApiKey,
        maxTokens: opts.reviewMaxTokens, retryDelayMs: opts.retryDelayMs, fetchImpl: opts.fetchImpl,
      });
      const next = structuredClone(memory);
      const applied = applyModelNotes(next, notes, noteScope(batch));
      if (applied.unmatched === 0) {
        for (const obs of batch) next.modelReviews[obs.battleId] = applied.received === 0 ? 'empty' : 'complete';
      }
      await saveMemory(opts.memoryDir, next);
      memory = next;
      if (applied.unmatched === 0) report.modelReviewed += batch.length;
      report.modelNotes ??= {species: {}, cores: {}};
      mergeNotes(report.modelNotes, notes);
      for (const key of ['received', 'added', 'duplicates', 'unmatched', 'discarded'] as const) {
        report.modelApplication[key] += applied[key];
      }
      report.modelApplication.unmatchedKeys.push(...applied.unmatchedKeys);
      log(`模型复盘第 ${Math.floor(i / BATCH_SIZE) + 1} 批：返回 ${applied.received} 条，新增 ${applied.added}，重复 ${applied.duplicates}，未匹配 ${applied.unmatched}，超限/空白丢弃 ${applied.discarded}（已保存）`);
      if (applied.received === 0) log('模型未发现可重复模式；已记录空结果，可用 --retry-model 重新提炼');
      if (applied.unmatched) {
        log(`未匹配键：${applied.unmatchedKeys.join(', ')}`);
        throw new Error('模型返回未匹配键，本批保持待补跑；已匹配经验已保存');
      }
    } catch (error) {
      report.modelError = error instanceof Error ? error.message : String(error);
      log(`模型复盘未完成（规则统计及此前已保存经验保留）：${report.modelError}`);
      break;
    }
  }
  report.modelPending = Object.values(memory.modelReviews).filter(status => status === 'pending').length;
  log(`模型复盘完成 ${report.modelReviewed} 局，待复盘 ${report.modelPending} 局`);
  return report;
}
