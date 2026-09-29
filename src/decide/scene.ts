import type {DexData} from '../dex/index.js';
import {seenInBattle} from '../state/battle-context.js';
import {toId} from '../state/protocol.js';
import {activeEntries, speciesOf, type BattleRequest} from '../state/request.js';
import type {BattleState, PokemonState} from '../state/tracker.js';

/** 对手单只的已暴露情报（HP/状态/技能/道具/特性/Mega）；未揭示项显式标未知，不猜测。 */
function foeIntelText(p: PokemonState): string {
  const bits: string[] = [`HP ${p.hpPercent}%`];
  if (p.fainted) bits.push('fainted');
  else if (p.status) bits.push(`status ${p.status}`);
  if (p.mega) bits.push('has Mega Evolved');
  bits.push(p.revealedMoves.length ? `moves seen: ${p.revealedMoves.join(', ')}` : 'no moves revealed');
  if (p.item) bits.push(`item ${p.item}`);
  else if (p.consumedItem) bits.push(`item ${p.revealedItems?.[p.revealedItems.length - 1] ?? 'unknown'} (already consumed)`);
  else bits.push('no item revealed');
  bits.push(p.ability ? `ability ${p.ability}` : 'no ability revealed');
  return `${p.species} (${bits.join('; ')})`;
}

/**
 * 回合/换人提问前的场上简报：速度线 + 对手已暴露情报 + 后排已见对手。
 * 天气/戏法空间/顺风已由 speedControlText 覆盖，这里只补速度线与对手情报，不重复。
 */
export function sceneBriefing(input: {dex: DexData; request: BattleRequest; state: BattleState}): string | null {
  const {dex, request, state} = input;
  const oppSideId = state.ourSideId === 'p1' ? 'p2' : 'p1';
  const oppSide = state.sides[oppSideId];
  const segments: string[] = [];
  const foes = (oppSide?.pokemon ?? []).filter(p => p.activePos >= 0 && !p.fainted);
  // 速度线：我方用队伍精确值（request.stats），对手只有 base Speed（性格/努力/道具未知）
  const ours = activeEntries(request).map(me => `${speciesOf(me)} ${me.stats?.spe ?? 'unknown'}`);
  if (ours.length && foes.length) {
    const foeSpeeds = foes.map(p => `${p.species} base ${dex.species[toId(p.species)]?.baseStats?.spe ?? 'unknown'}`);
    segments.push(`Speed line — yours: ${ours.join(', ')} (exact, from your team); foes: ${foeSpeeds.join(', ')} (base stats only — their natures, EVs and items are unknown)`);
  }
  if (foes.length) segments.push(`Foes on the field: ${foes.map(foeIntelText).join('; ')}`);
  const benchSeen = (oppSide?.pokemon ?? []).filter(p => p.activePos < 0 && seenInBattle(p));
  if (benchSeen.length) segments.push(`Seen in battle, now benched: ${benchSeen.map(foeIntelText).join('; ')}`);
  return segments.length ? `Scene — ${segments.join(' ')}` : null;
}
