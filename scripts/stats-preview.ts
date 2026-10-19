/**
 * team preview 决策回归统计（默认最近 50 场）：
 *  raw 四题重复率 / resolver 修复（重复改 probabilities、缺答案补位）/ 零 Mega 带入率（H11 触发）/
 *  bring_4 概率边距 / 预测对手首发命中（top1·any·both，带均匀基线）/ 硬指令触发（H1/H6/H11）。
 * 口径约定：
 *  - 预览决策取 decisions.jsonl 中 kind=team-preview 的最后一条（同局重试去重）；
 *  - raw 答案只取 answers 四题的 choice 字段（不看 probabilities）；非法值与缺失单列；
 *  - 零 Mega 判定：chosen 带入前 4 位与 criteria 中带 "can Mega Evolve" 的槽位无交集（队伍本身无 Mega 手时不适用）；
 *  - 预测命中：briefing 的 "Most probable foe leads" 段 vs protocol.log 对手侧首个 |switch|（details 取物种、
 *    按 side+pos 去重、遇首个 |turn| 截止）；我方阵营由 |player| 名称含 Jev 识别，与 stats-battles 同源；
 *  - 均匀基线：预测 k 名中，top1 命中 2/6；any 命中 1-C(6-k,2)/C(6,2)；both 命中 C(k,2)/C(6,2)。
 * 运行：npx tsx scripts/stats-preview.ts [--last=50] [--detail]
 */
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

const argv = process.argv.slice(2);
const lastN = Number(argv.find(a => a.startsWith('--last='))?.split('=')[1] ?? 50);
const detail = argv.includes('--detail');
if (!Number.isSafeInteger(lastN) || lastN <= 0) throw new Error('--last 需为正整数');
const dir = join(process.cwd(), 'logs');

const QUESTION_NAMES = ['lead_1', 'lead_2', 'bring_3', 'bring_4'] as const;
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const slotOf = (value: unknown): number | null => {
  const m = /^slot_(\d)$/.exec(String(value ?? ''));
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 6 ? n : null;
};

interface PreviewRecord {
  /** 四题 raw choice 对应的槽位（null=缺失或非法） */
  rawChoices: (number | null)[];
  adjusted: string[];
  /** chosen[0].order（6 位带入顺序） */
  order: number[] | null;
  /** criteria 中含 "can Mega Evolve" 的槽位 */
  megaSlots: number[];
  briefing: string;
  contextLevel: number | null;
  /** bring_4 的 probabilities（slot_N → 概率），无则 null */
  bring4Probabilities: Record<string, number> | null;
}

function parsePreviewRecord(text: string): PreviewRecord | null {
  let rec: Record<string, unknown> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.kind === 'team-preview') rec = o; // 同局重试：后写覆盖
    } catch { /* 跳过坏行 */ }
  }
  if (!rec) return null;
  const answers = (rec.answers ?? {}) as Record<string, {type?: string; choice?: string; probabilities?: Record<string, number>} | undefined>;
  const rawChoices = QUESTION_NAMES.map(name => {
    const answer = answers[name];
    return answer && answer.type === 'choice' ? slotOf(answer.choice) : null;
  });
  const chosen = Array.isArray(rec.chosen) ? rec.chosen : [];
  const team = chosen.find(c => (c as {kind?: string}).kind === 'team') as {order?: unknown[]} | undefined;
  const order = Array.isArray(team?.order) && team!.order.every(n => typeof n === 'number')
    ? (team!.order as number[])
    : null;
  const questions = (rec.questions ?? {}) as Record<string, {criteria?: Record<string, unknown>} | undefined>;
  const criteria = questions.lead_1?.criteria ?? {};
  const megaSlots = Object.entries(criteria)
    .filter(([, text]) => String(text).includes('can Mega Evolve'))
    .map(([key]) => slotOf(key))
    .filter((n): n is number => n !== null);
  const rawProbs = answers.bring_4?.probabilities ?? null;
  const bring4Probabilities = rawProbs
    ? Object.fromEntries(Object.entries(rawProbs).filter(([key]) => slotOf(key) !== null))
    : null;
  const state = (rec.state ?? {}) as {briefing?: string};
  return {
    rawChoices,
    adjusted: Array.isArray(rec.adjusted) ? rec.adjusted.map(String) : [],
    order,
    megaSlots,
    briefing: String(state.briefing ?? ''),
    contextLevel: typeof rec.context_level === 'number' ? rec.context_level : null,
    bring4Probabilities: bring4Probabilities && Object.keys(bring4Probabilities).length ? bring4Probabilities : null,
  };
}

/** 对手实际首发（物种名）：首个 |turn| 前的 |switch| 行，按 side+pos 去重；无法识别时 null */
function parseFoeLeads(protocolText: string): {species: string[]; ourSide: string | null} {
  const players: Record<string, string> = {};
  for (const line of protocolText.split(/\r?\n/)) {
    const m = /^\|player\|p(\d)\|([^|]+)\|/.exec(line);
    if (m) players[m[1]] = m[2];
  }
  let ourSide: string | null = null;
  for (const [side, name] of Object.entries(players)) if (/Jev/i.test(name)) ourSide = side;
  const foeSide = ourSide === null ? null : (ourSide === '1' ? '2' : '1');
  const seen = new Set<string>();
  const leads: string[] = [];
  for (const line of protocolText.split(/\r?\n/)) {
    if (line.startsWith('|turn|')) break;
    const m = /^\|switch\|p(\d)(a|b): [^|]*\|([^|]*)\|/.exec(line);
    if (!m) continue;
    const key = m[1] + m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    if (foeSide !== null && m[1] === foeSide) leads.push(norm((m[3] ?? '').split(',')[0]));
  }
  return {species: leads, ourSide};
}

function width(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return w;
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - width(s)));
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map(r => width(r[i] ?? ''))));
  console.log(headers.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(row.map((c, i) => pad(c ?? '', widths[i])).join('  '));
}

const pct = (a: number, b: number): string => b > 0 ? `${(100 * a / b).toFixed(1)}%` : '-';
const choose2 = (n: number): number => n < 2 ? 0 : (n * (n - 1)) / 2;

const all = readdirSync(dir)
  .filter(name => name.endsWith('.decisions.jsonl'))
  .map(name => ({name, mtime: statSync(join(dir, name)).mtimeMs}))
  .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
  .slice(0, lastN);
if (all.length === 0) throw new Error(`${dir} 下没有 *.decisions.jsonl`);

const agg = {
  previews: 0, skippedNoPreview: 0,
  rawComplete: 0, rawInvalid: 0,
  dupDecisions: 0, dupInstances: 0, repairDist: new Map<number, number>(),
  repairsTotal: 0, missingTotal: 0,
  megaEligible: 0, zeroMega: 0, h11Fired: 0,
  withProb: 0, marginSum: 0, marginDist: new Map<string, number>(), selfConsistent: {n: 0, hit: 0},
  withPred: 0, predSizes: new Map<number, number>(),
  matched: 0, noLeads: 0, noOurSide: 0,
  top1: 0, any: 0, both: 0, top1Base: 0, anyBase: 0, bothBase: 0,
  hard: {rotate: 0, weather: 0, mega: 0},
};
const bump = (map: Map<number, number>, key: number): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};
const zeroMegaCases: string[] = [];
const missSamples: string[] = [];

for (const {name} of all) {
  const rec = parsePreviewRecord(readFileSync(join(dir, name), 'utf8'));
  if (!rec) { agg.skippedNoPreview++; continue; }
  agg.previews++;
  const id = name.replace(/\.decisions\.jsonl$/, '');
  const valid = rec.rawChoices.filter((n): n is number => n !== null);
  if (valid.length === QUESTION_NAMES.length) agg.rawComplete++;
  if (valid.length !== QUESTION_NAMES.length) agg.rawInvalid++;
  const dupCount = valid.length - new Set(valid).size;
  if (dupCount > 0) agg.dupDecisions++;
  agg.dupInstances += dupCount;
  const repairs = rec.adjusted.filter(a => /^(lead_1|lead_2|bring_3|bring_4): slot_[1-6]$/.test(a)).length;
  const missing = rec.adjusted.filter(a => /^missing:(lead_1|lead_2|bring_3|bring_4)$/.test(a)).length;
  agg.repairsTotal += repairs;
  agg.missingTotal += missing;
  bump(agg.repairDist, Math.min(repairs + missing, 4));
  for (const [key, hit] of [['rotate', 'hard:lead-rotate'], ['weather', 'hard:weather-bring'], ['mega', 'hard:mega-required']] as const) {
    if (rec.adjusted.some(a => a.startsWith(hit))) agg.hard[key]++;
  }
  // 零 Mega：队伍有 Mega 手（criteria 标记）而带入前 4 位不含任何 Mega 手
  const first4 = rec.order?.slice(0, 4) ?? null;
  let zeroMega = false;
  if (rec.megaSlots.length > 0) {
    agg.megaEligible++;
    if (first4 && !first4.some(slot => rec.megaSlots.includes(slot))) {
      zeroMega = true;
      agg.zeroMega++;
      if (zeroMegaCases.length < 8) zeroMegaCases.push(`${id.slice(-10)} 带入=[${first4.join(',')}] mega槽=[${rec.megaSlots.join(',')}]`);
    }
  }
  if (rec.adjusted.some(a => a.startsWith('hard:mega-required'))) agg.h11Fired++;
  // bring_4 概率边距
  if (rec.bring4Probabilities) {
    const values = Object.values(rec.bring4Probabilities).sort((a, b) => b - a);
    if (values.length >= 2) {
      agg.withProb++;
      const margin = values[0] - values[1];
      agg.marginSum += margin;
      const bin = margin < 0.1 ? '<0.10' : margin < 0.2 ? '0.10-0.20' : '>=0.20';
      agg.marginDist.set(bin, (agg.marginDist.get(bin) ?? 0) + 1);
      const argmax = Number(Object.entries(rec.bring4Probabilities).sort((a, b) => b[1] - a[1])[0][0].replace('slot_', ''));
      const rawBring4 = rec.rawChoices[3];
      if (rawBring4 !== null) {
        agg.selfConsistent.n++;
        if (rawBring4 === argmax) agg.selfConsistent.hit++;
      }
    }
  }
  // 预测命中
  const pred = /Most probable foe leads: (.+?)\. (?:Your recorded results:|Use each slot's)/.exec(rec.briefing);
  if (!pred) continue;
  agg.withPred++;
  const predicted = pred[1].split(';').map(x => x.trim().split(' (')[0].trim()).filter(Boolean);
  bump(agg.predSizes, predicted.length);
  const protoPath = join(dir, id + '.protocol.log');
  if (!existsSync(protoPath)) continue;
  const {species: foeLeads, ourSide} = parseFoeLeads(readFileSync(protoPath, 'utf8'));
  if (ourSide === null) { agg.noOurSide++; continue; }
  if (foeLeads.length !== 2) { agg.noLeads++; continue; }
  agg.matched++;
  const pn = predicted.map(norm);
  const top1 = foeLeads.includes(pn[0]!);
  const any = pn.some(x => foeLeads.includes(x));
  const both = foeLeads.every(x => pn.includes(x));
  if (top1) agg.top1++;
  if (any) agg.any++;
  if (both) agg.both++;
  const k = Math.min(predicted.length, 6);
  agg.top1Base += 2 / 6;
  agg.anyBase += 1 - (choose2(6 - k) / choose2(6));
  agg.bothBase += choose2(k) / choose2(6);
  if (detail) {
    console.log(`${id.slice(-12)}  L${rec.contextLevel ?? '?'}  raw=[${rec.rawChoices.map(n => n ?? 'x').join(',')}]  修复=${repairs + missing}  带入=[${first4?.join('') ?? '?'}]${zeroMega ? '  零Mega!' : ''}  pred=[${predicted.join(' | ')}]  实际=[${foeLeads.join(' | ')}]  ${top1 ? 'T1✓' : 'T1✗'}${any ? ' A✓' : ' A✗'}${both ? ' B✓' : ' B✗'}`);
  }
  if (!any && missSamples.length < 6) missSamples.push(`${id.slice(-10)}  pred=[${predicted.join(' | ')}]  foe=[${foeLeads.join(' | ')}]`);
}

console.log(`\n统计目录 ${dir}`);
console.log(`取最近 ${all.length} 场 decisions 日志：预览决策 ${agg.previews}${agg.skippedNoPreview ? `（跳过无预览 ${agg.skippedNoPreview}）` : ''}`);

console.log('\n== raw 答案与 resolver 修复（目标：重复率下降、修复 <0.5 槽/局）==');
{
  console.log(`四题齐全 ${agg.rawComplete}/${agg.previews}（缺失/非法 ${agg.rawInvalid}）· 含重复答案的局 ${agg.dupDecisions}（${pct(agg.dupDecisions, agg.previews)}）· 重复实例 ${agg.dupInstances} 个（平均每局 ${(agg.dupInstances / Math.max(1, agg.previews)).toFixed(2)}）`);
  console.log(`resolver 修复 ${agg.repairsTotal} 槽（平均每局 ${(agg.repairsTotal / Math.max(1, agg.previews)).toFixed(2)}）· 缺答案补位 ${agg.missingTotal}`);
  printTable(['修复槽位数/局', '局数', '占比'], [...agg.repairDist.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, c]) => [k >= 4 ? '4' : String(k), String(c), pct(c, agg.previews)]));
}

console.log('\n== 零 Mega 带入（目标：0；H11 触发应为结构兜底）==');
{
  console.log(`含 Mega 可进化手的局 ${agg.megaEligible} · 零 Mega 带入 ${agg.zeroMega}（${pct(agg.zeroMega, agg.megaEligible)}）· hard:mega-required 触发 ${agg.h11Fired}`);
  for (const line of zeroMegaCases) console.log(`  零 Mega：${line}`);
}

console.log('\n== bring_4 概率边距与自洽 ==');
{
  const avg = agg.withProb > 0 ? (agg.marginSum / agg.withProb).toFixed(3) : '-';
  console.log(`带 probabilities 的局 ${agg.withProb}/${agg.previews} · 平均 top1-top2 边距 ${avg} · raw 答案与自身 argmax 一致 ${agg.selfConsistent.hit}/${agg.selfConsistent.n}（${pct(agg.selfConsistent.hit, agg.selfConsistent.n)}）`);
  printTable(['边距分箱', '局数', '占比'], [...agg.marginDist.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bin, c]) => [bin, String(c), pct(c, agg.withProb)]));
}

console.log('\n== 预测对手首发命中（L2）==');
{
  console.log(`有预测段 ${agg.withPred}/${agg.previews} · 可配对 ${agg.matched}（对手首发不可用 ${agg.noLeads}、我方阵营缺失 ${agg.noOurSide}）`);
  console.log(`预测数分布：${[...agg.predSizes.entries()].sort((a, b) => a[0] - b[0]).map(([k, c]) => `${k}名×${c}`).join('、') || '-'}`);
  console.log(`top1 命中 ${agg.top1}/${agg.matched} = ${pct(agg.top1, agg.matched)}（均匀基线 ${pct(agg.top1Base, agg.matched)}）`);
  console.log(`any  命中 ${agg.any}/${agg.matched} = ${pct(agg.any, agg.matched)}（均匀基线 ${pct(agg.anyBase, agg.matched)}）`);
  console.log(`both 命中 ${agg.both}/${agg.matched} = ${pct(agg.both, agg.matched)}（均匀基线 ${pct(agg.bothBase, agg.matched)}）`);
  for (const line of missSamples) console.log(`  未命中：${line}`);
}

console.log('\n== 硬指令触发 ==');
console.log(`H1 首发轮换 ${agg.hard.rotate} · H6 天气补入 ${agg.hard.weather} · H11 零 Mega 补入 ${agg.hard.mega}`);
