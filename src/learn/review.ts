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
  reviewMaxTokens?: number;
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

const REVIEW_PROMPT = `You review Pokemon Showdown VGC (doubles) battle logs. Input lines describe past battles: winner, the opponent team, and revealed opponent configurations. Extract recurring, pattern-level lessons that would help future games against these Pokemon. Respond with STRICT JSON only, no markdown fences:
{"species":{"Exact Species Name":["one short English lesson"]},"cores":{"SpeciesA+SpeciesB":["one short lesson"]}}
Only include entries with a real pattern across the provided battles; each value is an array with exactly one string.`;

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

async function collectNotesBatch(
  observations: BattleObservation[],
  opts: {model: string; apiKey: string; maxTokens: number; fetchImpl?: typeof fetch},
): Promise<ModelNotes> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    model: opts.model,
    stream: false,
    max_tokens: opts.maxTokens,
    messages: [
      {role: 'system', content: REVIEW_PROMPT},
      {role: 'user', content: observations.map(compactBattle).join('\n')},
    ],
  });
  const res = await doFetch(CHAT_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}`},
    body,
  });
  if (!res.ok) throw new Error(`review HTTP ${res.status}`);
  const raw = JSON.parse(await res.text()) as Record<string, any>;
  const content: unknown = raw?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('review 响应缺少文本');
  const jsonText = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
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
  opts: {model: string; apiKey: string; maxTokens: number; fetchImpl?: typeof fetch},
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
        maxTokens: opts.reviewMaxTokens ?? 2048, fetchImpl: opts.fetchImpl,
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
