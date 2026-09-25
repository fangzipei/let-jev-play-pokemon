/**
 * 离线对局统计（默认最近 50 局）：胜负 / 我方选出 / 双方技能使用。
 * 口径约定：
 *  - 我方阵营由 |request| 的 side.name / side.id 动态识别，不硬编码 p1/p2；
 *  - 无 |win|/|tie| 的对局视为未完成，整体排除出所有聚合分母并单独计数；
 *  - 技能与选出只取服务端协议事实（|move| / |switch| 行），与决策日志无关。
 * 运行：npx tsx scripts/stats-battles.ts [--last=50] [--detail]
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

const argv = process.argv.slice(2);
const lastN = Number(argv.find(a => a.startsWith('--last='))?.split('=')[1] ?? 50);
const detail = argv.includes('--detail');
if (!Number.isSafeInteger(lastN) || lastN <= 0) throw new Error('--last 需为正整数');
const dir = join(process.cwd(), 'logs');

interface Battle {
  result: 'win' | 'loss' | 'tie' | 'unfinished';
  ourName: string;
  brought: string[];
  leadA?: string;
  leadB?: string;
  moves: Map<string, number>;
  perMon: Map<string, Map<string, number>>;
  foeMoves: Map<string, number>;
  foeSpecies: string[];
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function parseBattle(text: string): Battle | null {
  let ourName: string | null = null;
  let ourSide: string | null = null;
  let brought: string[] = [];
  let winner: string | null = null;
  let tie = false;
  const switches = new Map<string, string>(); // 各槽位我方首次换入（即首发）
  const ourSeen = new Set<string>();
  const moves = new Map<string, number>();
  const perMon = new Map<string, Map<string, number>>();
  const foeMoves = new Map<string, number>();
  const foeSpecies = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('|request|')) {
      try {
        const req = JSON.parse(line.slice('|request|'.length)) as {side?: {name?: string; id?: string; pokemon?: {ident?: string}[]}};
        if (req.side?.name) ourName ??= req.side.name;
        if (req.side?.id) ourSide = req.side.id;
        // 预览 request 列出全部 6 只；出战 request 只列带入的 4 只。
        const idents = (req.side?.pokemon ?? []).map(p => p.ident?.split(': ')[1]).filter((n): n is string => Boolean(n));
        if (idents.length > 0 && idents.length <= 4) brought = idents;
      } catch { /* 被截断的 request 行不参与 */ }
      continue;
    }
    if (line.startsWith('|win|')) { winner = line.slice('|win|'.length).trim(); continue; }
    if (line.startsWith('|tie')) { tie = true; continue; }
    const sw = /^\|switch\|(p[12])([ab]): ([^|]+)\|/.exec(line);
    if (sw && ourSide) {
      const [, side, slot, name] = sw;
      if (side === ourSide) {
        if (!switches.has(slot)) switches.set(slot, name);
        ourSeen.add(name);
      } else foeSpecies.add(name);
      continue;
    }
    const drag = /^\|(?:drag|replace)\|(p[12])[ab]: ([^|]+)\|/.exec(line);
    if (drag && ourSide) {
      if (drag[1] !== ourSide) foeSpecies.add(drag[2]);
      continue;
    }
    const mv = /^\|move\|(p[12])[ab]: ([^|]+)\|([^|]+)\|/.exec(line);
    if (mv && ourSide) {
      const [, side, mon, move] = mv;
      if (side === ourSide) {
        bump(moves, move);
        const row = perMon.get(mon) ?? new Map<string, number>();
        bump(row, move);
        perMon.set(mon, row);
      } else bump(foeMoves, move);
    }
  }
  if (!ourName || !ourSide) return null;
  const result: Battle['result'] = winner !== null ? (winner === ourName ? 'win' : 'loss') : tie ? 'tie' : 'unfinished';
  if (brought.length === 0) brought = [...ourSeen].slice(0, 4); // 缺出战 request 时以实际换入兜底
  return {result, ourName, brought, leadA: switches.get('a'), leadB: switches.get('b'), moves, perMon, foeMoves, foeSpecies: [...foeSpecies]};
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

interface Tally {n: number; w: number}

const all = readdirSync(dir)
  .filter(name => name.endsWith('.protocol.log'))
  .map(name => ({name, mtime: statSync(join(dir, name)).mtimeMs}))
  .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
  .slice(0, lastN);
if (all.length === 0) throw new Error(`${dir} 下没有 *.protocol.log`);

const agg = {
  battles: 0, wins: 0, losses: 0, ties: 0, unfinished: 0, skipped: 0,
  brought: new Map<string, Tally>(),
  leads: new Map<string, Tally>(),
  moves: new Map<string, {uses: number; n: number; w: number}>(),
  perMon: new Map<string, Map<string, number>>(),
  foeMoves: new Map<string, number>(),
  foeSpecies: new Map<string, number>(),
};
const tally = (map: Map<string, Tally>, key: string, win: boolean): void => {
  const e = map.get(key) ?? {n: 0, w: 0};
  e.n++;
  if (win) e.w++;
  map.set(key, e);
};

for (const {name} of all) {
  const battle = parseBattle(readFileSync(join(dir, name), 'utf8'));
  if (!battle) { agg.skipped++; continue; }
  if (battle.result === 'unfinished') {
    agg.unfinished++;
    if (detail) console.log(`${name}  未完成（无 |win|/|tie|），不计入`);
    continue;
  }
  agg.battles++;
  const win = battle.result === 'win';
  if (win) agg.wins++; else if (battle.result === 'loss') agg.losses++; else agg.ties++;
  for (const sp of battle.brought) tally(agg.brought, sp, win);
  if (battle.leadA && battle.leadB) tally(agg.leads, [battle.leadA, battle.leadB].sort().join(' + '), win);
  for (const [move, uses] of battle.moves) {
    const e = agg.moves.get(move) ?? {uses: 0, n: 0, w: 0};
    e.uses += uses;
    e.n++;
    if (win) e.w++;
    agg.moves.set(move, e);
  }
  for (const [mon, row] of battle.perMon) {
    const t = agg.perMon.get(mon) ?? new Map<string, number>();
    for (const [move, c] of row) bump(t, move, c);
    agg.perMon.set(mon, t);
  }
  for (const [move, c] of battle.foeMoves) bump(agg.foeMoves, move, c);
  for (const sp of battle.foeSpecies) bump(agg.foeSpecies, sp);
  if (detail) {
    const counts = [...battle.moves.values()].reduce((a, b) => a + b, 0);
    const foeCounts = [...battle.foeMoves.values()].reduce((a, b) => a + b, 0);
    console.log(`${name}\n  ${battle.result}  我方=${battle.ourName}  带入=[${battle.brought.join(', ')}]  首发=${battle.leadA ?? '?'} / ${battle.leadB ?? '?'}  招式次数 我方=${counts} 对手=${foeCounts}`);
  }
}

const scanned = all.length;
console.log(`\n统计目录 ${dir}`);
console.log(`取最近 ${scanned} 局协议日志（按最后写入时间倒序）：完成 ${agg.battles}（胜 ${agg.wins} / 负 ${agg.losses} / 平 ${agg.ties}），排除未完成 ${agg.unfinished}${agg.skipped ? `，无法识别 ${agg.skipped}` : ''}`);
console.log(`总胜率（不含平与未完成）：${pct(agg.wins, agg.wins + agg.losses)}`);

console.log('\n== 我方选出（按带入次数）==');
printTable(['宝可梦', '带入', '选出率', '胜率(带入时)'], [...agg.brought.entries()].sort((a, b) => b[1].n - a[1].n)
  .map(([sp, t]) => [sp, String(t.n), pct(t.n, agg.battles), pct(t.w, t.n)]));

console.log('\n== 我方首发组合（≥3 局）==');
printTable(['组合', '次数', '胜率'], [...agg.leads.entries()].filter(([, t]) => t.n >= 3).sort((a, b) => b[1].n - a[1].n)
  .map(([pair, t]) => [pair, String(t.n), pct(t.w, t.n)]));

console.log('\n== 我方技能使用（Top 15，按总次数）==');
printTable(['技能', '总次数', '使用对局', '使用时胜率'], [...agg.moves.entries()].sort((a, b) => b[1].uses - a[1].uses).slice(0, 15)
  .map(([move, e]) => [move, String(e.uses), String(e.n), pct(e.w, e.n)]));

console.log('\n== 我方各宝可梦常用技能（Top 3）==');
{
  const rows: string[][] = [];
  for (const [mon, row] of agg.perMon) {
    rows.push([mon, String([...row.values()].reduce((a, b) => a + b, 0)), [...row.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, c]) => `${m}×${c}`).join(', ')]);
  }
  printTable(['宝可梦', '总次数', '常用技能'], rows.sort((a, b) => Number(b[1]) - Number(a[1])));
}

console.log('\n== 对手常用技能（Top 12，按总次数）==');
printTable(['技能', '总次数'], [...agg.foeMoves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([m, c]) => [m, String(c)]));

console.log('\n== 对手常见宝可梦（Top 12，按出场局数）==');
printTable(['宝可梦', '出场局数'], [...agg.foeSpecies.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([sp, c]) => [sp, String(c)]));
