/**
 * 离线对局统计（默认最近 50 局）：胜负 / 对局结构（比分·回合）/ 选出 / 换人（含换入者当回合代价）/
 * 双方技能 / Mega / 控速（Tailwind·Trick Room）/ Miss / 阵亡 / 天气。
 * 口径约定：
 *  - 我方阵营由 |request| 的 side.name / side.id 动态识别，不硬编码 p1/p2；
 *  - 无 |win|/|tie| 的对局视为未完成，整体排除出所有聚合分母并单独计数；
 *  - 技能与选出只取服务端协议事实（|move| / |switch| 行），与决策日志无关；
 *  - 换人由协议 |switch| 事实驱动，用 decisions 日志区分手动（kind=turn）与强制（kind=force-switch），
 *    决策同 (kind, turn) 重试去重取最后一条；换入者代价为换入当回合（至下一 |turn| 前）的毛伤害。
 * 运行：npx tsx scripts/stats-battles.ts [--last=50] [--detail]
 */
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

const argv = process.argv.slice(2);
const lastN = Number(argv.find(a => a.startsWith('--last='))?.split('=')[1] ?? 50);
const detail = argv.includes('--detail');
if (!Number.isSafeInteger(lastN) || lastN <= 0) throw new Error('--last 需为正整数');
const dir = join(process.cwd(), 'logs');

interface SwitchEvent {
  turn: number;
  slot: 1 | 2;
  from: string | null;
  to: string;
  damagePct: number;
  fainted: boolean;
  kind: 'manual' | 'forced' | 'unknown';
}

interface DecisionCounts {
  manual: Map<string, number>;
  forced: Map<string, number>;
  manualTotal: number;
  forcedTotal: number;
}

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
  switches: SwitchEvent[];
  foeSwitches: Map<string, number>;
  finalTurn: number;
  ourFaints: {species: string; turn: number}[];
  foeFaintCount: number;
  ourMegas: {species: string; turn: number}[];
  foeMegas: {species: string; turn: number}[];
  ourMisses: Map<string, number>;
  foeMissCount: number;
  ourSpeedMoves: {move: string; turn: number}[];
  foeSpeedMoves: {move: string; turn: number}[];
  weathers: string[];
  endNote: {type: 'forfeit' | 'inactivity'; by: 'foe' | 'our'} | null;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function parseHp(raw: string | undefined): {hp: number; maxHp: number | null} {
  if (!raw) return {hp: 0, maxHp: null};
  const m = /^(\d+)\/(\d+)/.exec(raw);
  if (m) return {hp: Number(m[1]), maxHp: Number(m[2])};
  if (/fnt/.test(raw)) return {hp: 0, maxHp: null};
  return {hp: 0, maxHp: null};
}

interface PendingSwitch {
  turn: number;
  slot: 1 | 2;
  from: string | null;
  to: string;
  lastHp: number;
  maxHp: number;
  damage: number;
  fainted: boolean;
}

function parseBattle(text: string): Battle | null {
  let ourName: string | null = null;
  let ourSide: string | null = null;
  let brought: string[] = [];
  let winner: string | null = null;
  let tie = false;
  let turn = 0;
  const switches = new Map<string, string>(); // 各槽位我方首次换入（即首发）
  const ourSeen = new Set<string>();
  const moves = new Map<string, number>();
  const perMon = new Map<string, Map<string, number>>();
  const foeMoves = new Map<string, number>();
  const foeSpecies = new Set<string>();
  const lastSpecies = new Map<number, string>(); // 槽位当前物种（用于换出者）
  const pending = new Map<number, PendingSwitch[]>(); // 各槽位本回合的换入事件（待结算伤害）
  const switchEvents: SwitchEvent[] = [];
  const foeSwitches = new Map<string, number>();
  const ourFaints: {species: string; turn: number}[] = [];
  let foeFaintCount = 0;
  const ourMegas: {species: string; turn: number}[] = [];
  const foeMegas: {species: string; turn: number}[] = [];
  const ourMisses = new Map<string, number>();
  let foeMissCount = 0;
  const ourSpeedMoves: {move: string; turn: number}[] = [];
  const foeSpeedMoves: {move: string; turn: number}[] = [];
  const weatherSet = new Set<string>();
  let endNote: Battle['endNote'] = null;
  // 回合结束后（遇下一 |turn| 或文件尾）把本回合换入事件定稿为事件列表
  const flushPending = (): void => {
    for (const list of pending.values()) {
      for (const p of list) {
        switchEvents.push({turn: p.turn, slot: p.slot, from: p.from, to: p.to, damagePct: p.maxHp > 0 ? (100 * p.damage) / p.maxHp : 0, fainted: p.fainted, kind: 'unknown'});
      }
    }
    pending.clear();
  };
  for (const line of text.split(/\r?\n/)) {
    const tn = /^\|turn\|(\d+)/.exec(line);
    if (tn) { flushPending(); turn = Number(tn[1]); continue; }
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
    const sw = /^\|switch\|(p[12])([ab]): ([^|]+)\|([^|]*)\|([^|]*)/.exec(line);
    if (sw && ourSide) {
      const [, side, slotRaw, name, , hpRaw] = sw;
      const slot = slotRaw === 'a' ? 1 : 2;
      if (side === ourSide) {
        if (!switches.has(slotRaw)) switches.set(slotRaw, name);
        ourSeen.add(name);
        if (turn > 0) {
          const {hp, maxHp} = parseHp(hpRaw);
          const list = pending.get(slot) ?? [];
          list.push({turn, slot, from: lastSpecies.get(slot) ?? null, to: name, lastHp: hp, maxHp: maxHp ?? 100, damage: 0, fainted: false});
          pending.set(slot, list);
        }
        lastSpecies.set(slot, name);
      } else {
        foeSpecies.add(name);
        if (turn > 0) bump(foeSwitches, name);
      }
      continue;
    }
    const dm = /^\|-damage\|p([12])([ab]): [^|]+\|([^|]+)/.exec(line);
    if (dm && ourSide && `p${dm[1]}` === ourSide) {
      const list = pending.get(dm[2] === 'a' ? 1 : 2);
      const cur = list?.[list.length - 1];
      if (cur) {
        const {hp, maxHp} = parseHp(dm[3]);
        if (maxHp !== null) cur.maxHp = maxHp;
        cur.damage += Math.max(0, cur.lastHp - hp);
        cur.lastHp = hp;
      }
      continue;
    }
    const hl = /^\|-heal\|p([12])([ab]): [^|]+\|([^|]+)/.exec(line);
    if (hl && ourSide && `p${hl[1]}` === ourSide) {
      const list = pending.get(hl[2] === 'a' ? 1 : 2);
      const cur = list?.[list.length - 1];
      if (cur) {
        const {hp, maxHp} = parseHp(hl[3]);
        if (maxHp !== null) cur.maxHp = maxHp;
        cur.lastHp = hp;
      }
      continue;
    }
    const ft = /^\|faint\|p([12])([ab]): ([^|]+)/.exec(line);
    if (ft && ourSide) {
      if (`p${ft[1]}` === ourSide) {
        ourFaints.push({species: ft[3], turn});
        const list = pending.get(ft[2] === 'a' ? 1 : 2);
        const cur = list?.[list.length - 1];
        if (cur) cur.fainted = true;
      } else foeFaintCount++;
      continue;
    }
    const mg = /^\|-mega\|p([12])([ab]): ([^|]+)\|/.exec(line);
    if (mg && ourSide) {
      if (`p${mg[1]}` === ourSide) ourMegas.push({species: mg[3], turn});
      else foeMegas.push({species: mg[3], turn});
      continue;
    }
    const ms = /^\|-miss\|p([12])([ab]): ([^|]+)/.exec(line);
    if (ms && ourSide) {
      if (`p${ms[1]}` === ourSide) bump(ourMisses, ms[3]); // -miss 首字段为招式使用者（攻击者）
      else foeMissCount++;
      continue;
    }
    const wt = /^\|-weather\|([^|]+)/.exec(line);
    if (wt) {
      if (wt[1] !== 'none') weatherSet.add(wt[1]);
      continue;
    }
    const em = /^\|-message\|(.+?) (forfeited|lost due to inactivity)\./.exec(line);
    if (em && ourName) {
      endNote = {type: em[2].startsWith('forfeited') ? 'forfeit' : 'inactivity', by: em[1] === ourName ? 'our' : 'foe'};
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
        if (move === 'Tailwind' || move === 'Trick Room') ourSpeedMoves.push({move, turn});
      } else {
        bump(foeMoves, move);
        if (move === 'Tailwind' || move === 'Trick Room') foeSpeedMoves.push({move, turn});
      }
    }
  }
  flushPending();
  if (!ourName || !ourSide) return null;
  const result: Battle['result'] = winner !== null ? (winner === ourName ? 'win' : 'loss') : tie ? 'tie' : 'unfinished';
  if (brought.length === 0) brought = [...ourSeen].slice(0, 4); // 缺出战 request 时以实际换入兜底
  return {result, ourName, brought, leadA: switches.get('a'), leadB: switches.get('b'), moves, perMon, foeMoves, foeSpecies: [...foeSpecies], switches: switchEvents, foeSwitches,
    finalTurn: turn, ourFaints, foeFaintCount, ourMegas, foeMegas, ourMisses, foeMissCount, ourSpeedMoves, foeSpeedMoves, weathers: [...weatherSet], endNote};
}

function parseDecisions(text: string): DecisionCounts {
  const latest = new Map<string, {kind: 'turn' | 'force-switch'; turn: number; chosen: {kind?: string; slot?: number}[]}>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: {kind?: string; turn?: number; chosen?: {kind?: string; slot?: number}[]};
    try { o = JSON.parse(line) as typeof o; } catch { continue; }
    if ((o.kind !== 'turn' && o.kind !== 'force-switch') || typeof o.turn !== 'number') continue;
    latest.set(`${o.kind}:${o.turn}`, {kind: o.kind, turn: o.turn, chosen: o.chosen ?? []}); // 同 (kind,turn) 重试去重：后写覆盖
  }
  const manual = new Map<string, number>();
  const forced = new Map<string, number>();
  for (const rec of latest.values()) {
    for (const c of rec.chosen) {
      if (c.kind !== 'switch' || (c.slot !== 1 && c.slot !== 2)) continue;
      const key = `${rec.turn}:${c.slot}`;
      const target = rec.kind === 'turn' ? manual : forced;
      target.set(key, (target.get(key) ?? 0) + 1);
    }
  }
  const sum = (m: Map<string, number>): number => { let s = 0; for (const v of m.values()) s += v; return s; };
  return {manual, forced, manualTotal: sum(manual), forcedTotal: sum(forced)};
}

/** 用决策计数给协议换人事件分类：同 (turn,slot) 手动优先（换上后同回合被 KO 补位时协议顺序仍对应）。 */
function classifySwitches(events: SwitchEvent[], counts: DecisionCounts): void {
  for (const ev of events) {
    const key = `${ev.turn}:${ev.slot}`;
    if ((counts.manual.get(key) ?? 0) > 0) {
      counts.manual.set(key, counts.manual.get(key)! - 1);
      ev.kind = 'manual';
    } else if ((counts.forced.get(key) ?? 0) > 0) {
      counts.forced.set(key, counts.forced.get(key)! - 1);
      ev.kind = 'forced';
    }
  }
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
  manual: {count: 0, withDamage: 0, damageSum: 0, koed: 0},
  forced: {count: 0, koed: 0},
  unknownSwitches: 0,
  doubleSwitchTurns: 0,
  manualBattles: {n: 0, w: 0},
  noManualBattles: {n: 0, w: 0},
  manualPerBattle: [] as number[],
  switchTo: new Map<string, Tally>(),
  switchFrom: new Map<string, number>(),
  decisionManual: 0, decisionForced: 0, decisionManualUnmatched: 0, decisionForcedUnmatched: 0, missingDecisions: 0,
  foeSwitchTotal: 0,
  foeSwitchTo: new Map<string, number>(),
  finalTurns: {w: [] as number[], l: [] as number[]},
  scores: new Map<string, Tally>(),
  faint: {ourTotal: 0, foeTotal: 0, ourPerMon: new Map<string, {n: number; turnSum: number}>()},
  mega: {
    ourCount: 0, ourByMon: new Map<string, number>(), ourBattles: {n: 0, w: 0}, ourTurns: [] as number[],
    foeCount: 0, foeBattles: {n: 0, w: 0},
  },
  speed: {
    ourTW: {uses: 0, n: 0, w: 0}, foeTW: {uses: 0, n: 0, w: 0},
    ourTR: {uses: 0, n: 0, w: 0}, foeTR: {uses: 0, n: 0, w: 0},
  },
  miss: {ourTotal: 0, foeTotal: 0, ourByMon: new Map<string, number>()},
  weather: new Map<string, Tally>(),
  endFoeForfeit: 0, endFoeInactive: 0, endOurForfeit: 0, endOurInactive: 0, koBattles: 0, koWins: 0,
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
  // 换人：decisions 日志区分手动/强制；协议事件按 (turn,slot) 交叉核对
  const dpath = join(dir, name.replace(/\.protocol\.log$/, '.decisions.jsonl'));
  if (existsSync(dpath)) {
    const counts = parseDecisions(readFileSync(dpath, 'utf8'));
    agg.decisionManual += counts.manualTotal;
    agg.decisionForced += counts.forcedTotal;
    classifySwitches(battle.switches, counts);
    for (const c of counts.manual.values()) agg.decisionManualUnmatched += c;
    for (const c of counts.forced.values()) agg.decisionForcedUnmatched += c;
  } else agg.missingDecisions++;
  const manualEvents = battle.switches.filter(e => e.kind === 'manual');
  const perTurn = new Map<number, number>();
  for (const e of manualEvents) perTurn.set(e.turn, (perTurn.get(e.turn) ?? 0) + 1);
  for (const n of perTurn.values()) if (n >= 2) agg.doubleSwitchTurns++;
  for (const e of battle.switches) {
    if (e.kind === 'unknown') { agg.unknownSwitches++; continue; }
    if (e.kind === 'forced') { agg.forced.count++; if (e.fainted) agg.forced.koed++; continue; }
    agg.manual.count++;
    if (e.damagePct > 0) agg.manual.withDamage++;
    agg.manual.damageSum += e.damagePct;
    if (e.fainted) agg.manual.koed++;
    tally(agg.switchTo, e.to, win);
    bump(agg.switchFrom, e.from ?? '?');
  }
  agg.manualPerBattle.push(manualEvents.length);
  if (manualEvents.length > 0) { agg.manualBattles.n++; if (win) agg.manualBattles.w++; }
  else { agg.noManualBattles.n++; if (win) agg.noManualBattles.w++; }
  for (const [to, c] of battle.foeSwitches) { bump(agg.foeSwitchTo, to, c); agg.foeSwitchTotal += c; }
  // 对局结构：比分（我方剩-对手剩，双方均按带入 4 只）、回合数
  if (battle.result !== 'tie') agg.finalTurns[win ? 'w' : 'l'].push(battle.finalTurn);
  const ourLeft = Math.max(0, 4 - battle.ourFaints.length);
  const foeLeft = Math.max(0, 4 - battle.foeFaintCount);
  tally(agg.scores, `${ourLeft}-${foeLeft}`, win);
  agg.faint.ourTotal += battle.ourFaints.length;
  agg.faint.foeTotal += battle.foeFaintCount;
  for (const f of battle.ourFaints) {
    const e = agg.faint.ourPerMon.get(f.species) ?? {n: 0, turnSum: 0};
    e.n++;
    e.turnSum += f.turn;
    agg.faint.ourPerMon.set(f.species, e);
  }
  if (battle.ourMegas.length > 0) {
    agg.mega.ourCount += battle.ourMegas.length;
    for (const m of battle.ourMegas) { bump(agg.mega.ourByMon, m.species); agg.mega.ourTurns.push(m.turn); }
    agg.mega.ourBattles.n++;
    if (win) agg.mega.ourBattles.w++;
  }
  if (battle.foeMegas.length > 0) {
    agg.mega.foeCount += battle.foeMegas.length;
    agg.mega.foeBattles.n++;
    if (win) agg.mega.foeBattles.w++;
  }
  const speedPairs: [('ourTW' | 'foeTW' | 'ourTR' | 'foeTR'), {move: string; turn: number}[]][] = [
    ['ourTW', battle.ourSpeedMoves.filter(m => m.move === 'Tailwind')],
    ['foeTW', battle.foeSpeedMoves.filter(m => m.move === 'Tailwind')],
    ['ourTR', battle.ourSpeedMoves.filter(m => m.move === 'Trick Room')],
    ['foeTR', battle.foeSpeedMoves.filter(m => m.move === 'Trick Room')],
  ];
  for (const [key, list] of speedPairs) {
    agg.speed[key].uses += list.length;
    if (list.length > 0) { agg.speed[key].n++; if (win) agg.speed[key].w++; }
  }
  for (const [mon, c] of battle.ourMisses) { agg.miss.ourTotal += c; bump(agg.miss.ourByMon, mon, c); }
  agg.miss.foeTotal += battle.foeMissCount;
  for (const w of battle.weathers) tally(agg.weather, w, win);
  // 结束方式：KO 打到底 / 投降（区分双方）/ 掉线超时
  const end = battle.endNote;
  if (!end) { agg.koBattles++; if (win) agg.koWins++; }
  else if (end.type === 'forfeit') { if (end.by === 'foe') agg.endFoeForfeit++; else agg.endOurForfeit++; }
  else if (end.by === 'foe') agg.endFoeInactive++; else agg.endOurInactive++;
  if (detail) {
    const counts = [...battle.moves.values()].reduce((a, b) => a + b, 0);
    const foeCounts = [...battle.foeMoves.values()].reduce((a, b) => a + b, 0);
    console.log(`${name}\n  ${battle.result}  我方=${battle.ourName}  带入=[${battle.brought.join(', ')}]  首发=${battle.leadA ?? '?'} / ${battle.leadB ?? '?'}  招式次数 我方=${counts} 对手=${foeCounts}`);
    console.log(`  结构：回合 ${battle.finalTurn} · 比分 ${ourLeft}-${foeLeft} · Mega 我/敌=${battle.ourMegas.length}/${battle.foeMegas.length} · Miss 我/敌=${[...battle.ourMisses.values()].reduce((a, b) => a + b, 0)}/${battle.foeMissCount} · 天气 [${battle.weathers.join(', ') || '-'}]`);
    if (battle.switches.length > 0) {
      console.log(`  换人=[${battle.switches.map(s => `T${s.turn}${s.slot === 1 ? 'a' : 'b'} ${s.kind} ${s.from ?? '?'}→${s.to} ${s.damagePct.toFixed(0)}%${s.fainted ? ' KO' : ''}`).join('; ')}]`);
    }
  }
}

const scanned = all.length;
console.log(`\n统计目录 ${dir}`);
console.log(`取最近 ${scanned} 局协议日志（按最后写入时间倒序）：完成 ${agg.battles}（胜 ${agg.wins} / 负 ${agg.losses} / 平 ${agg.ties}），排除未完成 ${agg.unfinished}${agg.skipped ? `，无法识别 ${agg.skipped}` : ''}`);
console.log(`总胜率（不含平与未完成）：${pct(agg.wins, agg.wins + agg.losses)}`);

console.log('\n== 对局结构 ==');
{
  const avg = (a: number[]): string => a.length > 0 ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-';
  console.log(`回合数：胜局均值 ${avg(agg.finalTurns.w)} · 负局均值 ${avg(agg.finalTurns.l)}`);
  console.log(`结束方式：打到底 ${agg.koBattles}（胜 ${agg.koWins} / 负 ${agg.koBattles - agg.koWins}）· 对手投降 ${agg.endFoeForfeit} · 对手掉线 ${agg.endFoeInactive} · 我方投降 ${agg.endOurForfeit} · 我方掉线 ${agg.endOurInactive}`);
  if (agg.koBattles > 0) console.log(`打到底口径胜率：${pct(agg.koWins, agg.koBattles)}（表观 ${pct(agg.wins, agg.wins + agg.losses)}）`);
  printTable(['结束比分(我方剩-对手剩)', '局数', '占比', '我方胜率'], [...agg.scores.entries()].sort((a, b) => b[1].n - a[1].n)
    .map(([s, t]) => [s, String(t.n), pct(t.n, agg.battles), pct(t.w, t.n)]));
}

console.log('\n== 我方选出（按带入次数）==');
printTable(['宝可梦', '带入', '选出率', '胜率(带入时)'], [...agg.brought.entries()].sort((a, b) => b[1].n - a[1].n)
  .map(([sp, t]) => [sp, String(t.n), pct(t.n, agg.battles), pct(t.w, t.n)]));

console.log('\n== 我方首发组合（≥3 局）==');
printTable(['组合', '次数', '胜率'], [...agg.leads.entries()].filter(([, t]) => t.n >= 3).sort((a, b) => b[1].n - a[1].n)
  .map(([pair, t]) => [pair, String(t.n), pct(t.w, t.n)]));

console.log('\n== 换人总览 ==');
{
  const m = agg.manual;
  console.log(`手动换人：协议落地 ${m.count} 次 · 决策（同回合重试去重后）${agg.decisionManual} 次 · 决策未落地 ${agg.decisionManualUnmatched} 次${agg.missingDecisions ? ` · ${agg.missingDecisions} 局缺 decisions 文件` : ''}`);
  console.log(`发生手动换人的局：${agg.manualBattles.n}/${agg.battles}（${pct(agg.manualBattles.n, agg.battles)}）· 双换人回合 ${agg.doubleSwitchTurns} 次`);
  console.log(`强制换人（服务器强制补位）：协议 ${agg.forced.count} 次 · 决策 ${agg.decisionForced} 次 · 决策未落地 ${agg.decisionForcedUnmatched} 次 · 协议可见但决策无记录 ${agg.unknownSwitches} 次`);
  console.log(`对手换人：${agg.foeSwitchTotal} 次（平均每局 ${(agg.foeSwitchTotal / Math.max(1, agg.battles)).toFixed(1)}）`);
}

console.log('\n== 手动换入者当回合代价（换入后至下一 |turn| 前）==');
{
  const m = agg.manual;
  console.log(`吃伤害：${m.withDamage}/${m.count}（${pct(m.withDamage, m.count)}）· 平均掉血 ${m.count ? (m.damageSum / m.count).toFixed(1) : '-'}%（满血基准）· 当回合被 KO ${m.koed} 次（${pct(m.koed, m.count)}）`);
}

console.log('\n== 手动换入 Top（按次数）==');
printTable(['宝可梦', '换入次数', '所在局胜率'], [...agg.switchTo.entries()].sort((a, b) => b[1].n - a[1].n)
  .map(([sp, t]) => [sp, String(t.n), pct(t.w, t.n)]));

console.log('\n== 手动换出 Top（被换下）==');
printTable(['宝可梦', '被换下次数'], [...agg.switchFrom.entries()].sort((a, b) => b[1] - a[1])
  .map(([sp, c]) => [sp, String(c)]));

console.log('\n== 每局手动换人次数分布 ==');
{
  const bins = new Map<number, number>();
  for (const n of agg.manualPerBattle) { const k = Math.min(n, 3); bins.set(k, (bins.get(k) ?? 0) + 1); }
  printTable(['次数', '局数', '占比'], [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, c]) => [k >= 3 ? '3+' : String(k), String(c), pct(c, agg.battles)]));
}

console.log('\n== 换人与胜率 ==');
{
  const a = agg.manualBattles;
  const b = agg.noManualBattles;
  printTable(['分组', '局数', '胜率'], [['有手动换人', String(a.n), pct(a.w, a.n)], ['无手动换人', String(b.n), pct(b.w, b.n)]]);
}

console.log('\n== 对手换入 Top（按次数）==');
printTable(['宝可梦', '换入次数'], [...agg.foeSwitchTo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .map(([sp, c]) => [sp, String(c)]));

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

console.log('\n== Mega 使用 ==');
{
  const m = agg.mega;
  const turns = [...m.ourTurns].sort((a, b) => a - b);
  const med = turns.length > 0 ? `T${turns[Math.floor(turns.length / 2)]}` : '-';
  const byMon = [...m.ourByMon.entries()].sort((a, b) => b[1] - a[1]).map(([sp, c]) => `${sp}×${c}`).join('、') || '-';
  console.log(`我方 Mega：${m.ourCount} 次（${byMon}）· 涉及局 ${m.ourBattles.n}，胜率 ${pct(m.ourBattles.w, m.ourBattles.n)} · 发生回合中位 ${med}`);
  console.log(`对手 Mega：${m.foeCount} 次 · 涉及局 ${m.foeBattles.n}，我方胜率 ${pct(m.foeBattles.w, m.foeBattles.n)}`);
}

console.log('\n== 控速对抗（Tailwind / Trick Room 实际使用）==');
{
  const s = agg.speed;
  printTable(['项目', '使用次数', '涉及局', '我方胜率'], [
    ['我方 Tailwind', String(s.ourTW.uses), String(s.ourTW.n), pct(s.ourTW.w, s.ourTW.n)],
    ['我方 Trick Room', String(s.ourTR.uses), String(s.ourTR.n), pct(s.ourTR.w, s.ourTR.n)],
    ['对手 Tailwind', String(s.foeTW.uses), String(s.foeTW.n), pct(s.foeTW.w, s.foeTW.n)],
    ['对手 Trick Room', String(s.foeTR.uses), String(s.foeTR.n), pct(s.foeTR.w, s.foeTR.n)],
  ]);
}

console.log('\n== 命中失误（-miss）==');
{
  console.log(`我方 miss ${agg.miss.ourTotal} 次 · 对手 miss ${agg.miss.foeTotal} 次`);
  if (agg.miss.ourByMon.size > 0) {
    printTable(['我方 miss 者', '次数'], [...agg.miss.ourByMon.entries()].sort((a, b) => b[1] - a[1]).map(([sp, c]) => [sp, String(c)]));
  }
}

console.log('\n== 阵亡分析 ==');
{
  const f = agg.faint;
  console.log(`我方阵亡合计 ${f.ourTotal} · 对手阵亡合计 ${f.foeTotal}（平均每局 ${(f.foeTotal / Math.max(1, agg.battles)).toFixed(1)}）`);
  printTable(['我方宝可梦', '阵亡次数', '平均阵亡回合'], [...f.ourPerMon.entries()].sort((a, b) => b[1].n - a[1].n)
    .map(([sp, e]) => [sp, String(e.n), (e.turnSum / e.n).toFixed(1)]));
}

console.log('\n== 天气出现 ==');
printTable(['天气', '出现局数', '我方胜率'], [...agg.weather.entries()].sort((a, b) => b[1].n - a[1].n).map(([w, t]) => [w, String(t.n), pct(t.w, t.n)]));

console.log('\n== 对手常用技能（Top 12，按总次数）==');
printTable(['技能', '总次数'], [...agg.foeMoves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([m, c]) => [m, String(c)]));

console.log('\n== 对手常见宝可梦（Top 12，按出场局数）==');
printTable(['宝可梦', '出场局数'], [...agg.foeSpecies.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([sp, c]) => [sp, String(c)]));
