// src/learn/extract.ts
import {parseDetails, parseIdent, parseLine} from '../state/protocol.js';

export interface RevealedSpecies {
  species: string;
  item?: string;
  ability?: string;
  moves: string[];
  itemConsumed: boolean;
  led: boolean;
}

export interface BattleObservation {
  battleId: string;
  won: boolean;
  /** 我方队伍物种（模型复盘需要双方队伍做对抗背景） */
  ourSpecies: string[];
  opponentSpecies: string[];
  opponentMegaSpecies: string[];
  revealed: RevealedSpecies[];
}

/** decisions.jsonl 首条 state 的 our-side 快照（serialize payload 约定）→ p1/p2。 */
function ourSideFromDecisions(jsonl: string): 'p1' | 'p2' | null {
  const first = jsonl.split('\n').map(l => l.trim()).find(Boolean);
  if (!first) return null;
  try {
    const entry = JSON.parse(first) as Record<string, any>;
    const ours = entry?.state?.sides?.ours;
    const ident: unknown = ours?.active?.[0]?.ident ?? ours?.preview?.[0]?.ident ?? ours?.bench?.[0]?.ident;
    const m = typeof ident === 'string' ? /^(p\d)/.exec(ident) : null;
    return m ? m[1] as 'p1' | 'p2' : null;
  } catch {
    return null;
  }
}

/** 单局 protocol.log（+ decisions.jsonl 判我方 side）→ 结构化观察；无法判定或未分胜负时 null。 */
export function extractObservation(
  protocolLog: string,
  decisionsJsonl: string,
  opts: {ourSideHint?: 'p1' | 'p2' | null; battleId?: string} = {},
): BattleObservation | null {
  const ourSide = opts.ourSideHint ?? ourSideFromDecisions(decisionsJsonl);
  if (!ourSide) return null;
  const oppSide = ourSide === 'p1' ? 'p2' : 'p1';
  const ourSpecies: string[] = [];
  const opponentSpecies: string[] = [];
  const revealed = new Map<string, RevealedSpecies>();
  const megaSpecies = new Set<string>();
  const playerNames: Record<string, string> = {};
  let winner: string | null = null;
  let started = false;

  const ensure = (name: string, species: string): RevealedSpecies => {
    let record = revealed.get(name);
    if (!record) {
      record = {species, moves: [], itemConsumed: false, led: false};
      revealed.set(name, record);
    }
    if (species && record.species !== species) record.species = species;
    return record;
  };

  for (const raw of protocolLog.split('\n')) {
    const line = parseLine(raw);
    if (!line) continue;
    const [a0, a1] = line.args;
    if (line.type === 'player') {
      // 赛后会出现空名 |player|pX| 行（对手离开房间），不得覆盖赛内有效名字
      if (a0 && a1?.trim()) playerNames[a0] = a1.trim();
      continue;
    }
    if (line.type === 'poke') {
      if (a0 === oppSide && a1) opponentSpecies.push(parseDetails(a1).species);
      if (a0 === ourSide && a1) ourSpecies.push(parseDetails(a1).species);
      continue;
    }
    if (line.type === 'win') {
      winner = a0 ?? null;
      continue;
    }
    if (line.type === 'turn') {
      started = true;
      continue;
    }
    if (line.type === 'detailschange' || line.type === 'formechange') {
      const ident = a0 ? parseIdent(a0) : null;
      if (ident?.side === oppSide && a1) ensure(ident.name, '').species = parseDetails(a1).species;
      continue;
    }
    const ident = a0 ? parseIdent(a0) : null;
    if (!ident || ident.side !== oppSide) continue;
    switch (line.type) {
      case 'switch':
      case 'drag': {
        const record = ensure(ident.name, a1 ? parseDetails(a1).species : ident.name);
        if (!started) record.led = true;
        break;
      }
      case 'move':
        if (a1 && !ensure(ident.name, ident.name).moves.includes(a1)) ensure(ident.name, ident.name).moves.push(a1);
        break;
      case '-item':
        if (a1) ensure(ident.name, ident.name).item = a1;
        break;
      case '-enditem': {
        const record = ensure(ident.name, ident.name);
        if (a1) record.item = a1;
        record.itemConsumed = true;
        break;
      }
      case '-ability':
        if (a1 && !['none', 'hidden'].includes(a1)) ensure(ident.name, ident.name).ability = a1;
        break;
      case '-mega':
        // 仅登记发生 Mega 的形态标识（-mega 行 a1）；不覆盖揭示记录的物种，形态变更由 detailschange 负责
        if (a1) megaSpecies.add(a1);
        break;
      default:
        break;
    }
  }
  const won = winner === playerNames[ourSide];
  const lost = winner === playerNames[oppSide];
  if (!won && !lost) return null; // tie 或无归属
  return {
    battleId: opts.battleId ?? '',
    won,
    ourSpecies,
    opponentSpecies,
    opponentMegaSpecies: [...megaSpecies],
    revealed: [...revealed.values()],
  };
}
