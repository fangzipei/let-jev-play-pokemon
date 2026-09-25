import {speciesTypes, type DexData} from '../dex/index.js';
import type {ChooseAction} from '../ps/choose.js';
import {findOurPokemon} from '../state/analysis.js';
import {effectiveness, estimateDamagePercent} from '../state/calc.js';
import {toId} from '../state/protocol.js';
import {
  activeEntries, benchEntries, conditionPercent, isFainted, speciesOf, teamSlotOf,
  type BattleRequest, type RequestPokemon,
} from '../state/request.js';
import {opponentActives, PROTECT_LIKE_MOVES} from '../state/serialize.js';
import type {BattleTracker} from '../state/tracker.js';

export interface FallbackContext {
  dex: DexData;
  request: BattleRequest;
  tracker: BattleTracker;
}

export function fallbackTeamPreview(): ChooseAction {
  return {kind: 'team', order: [1, 2, 3, 4, 5, 6]};
}

/** 每个需要换人的槽位选“血最厚、被对手属性克制最少”的存活替补 */
export function fallbackSwitchActions(ctx: FallbackContext): ChooseAction[] {
  const {dex, request, tracker} = ctx;
  const forceSwitch = request.forceSwitch ?? [];
  const maxSlot = Math.max(forceSwitch.length, request.active?.length ?? 0, 1);
  const foes = opponentActives(dex, tracker.state).filter(f => f.status !== 'fnt' && f.hpPercent > 0);
  const danger = (p: RequestPokemon): number => {
    const types = speciesTypes(dex, speciesOf(p));
    let worst = 1;
    for (const foe of foes) {
      for (const t of foe.types) worst = Math.max(worst, effectiveness(dex, t, types));
    }
    return worst;
  };
  const ranked = benchEntries(request)
    .map(p => ({slot: teamSlotOf(request, p), hp: conditionPercent(p.condition), danger: danger(p)}))
    .sort((a, b) => b.hp - a.hp || a.danger - b.danger || a.slot - b.slot);
  const used = new Set<number>();
  const actions: ChooseAction[] = [];
  for (let i = 1; i <= maxSlot; i++) {
    const slot = i as 1 | 2;
    if (!forceSwitch[i - 1]) {
      actions.push({kind: 'pass', slot});
      continue;
    }
    const pick = ranked.find(c => !used.has(c.slot));
    if (!pick) {
      actions.push({kind: 'pass', slot});
      continue;
    }
    used.add(pick.slot);
    actions.push({kind: 'switch', slot, teamIndex: pick.slot});
  }
  return actions;
}

/** 每个槽位选粗估伤害最大的招式；伤害为 0 时优先 Protect 类状态招式（上一回合已守过时直接跳过保护类，避免连续保护失败） */
export function fallbackTurnActions(ctx: FallbackContext): ChooseAction[] {
  const {dex, request, tracker} = ctx;
  const actives = activeEntries(request);
  const foes = opponentActives(dex, tracker.state).filter(f => f.status !== 'fnt' && f.hpPercent > 0);
  const weather = tracker.state.weather;
  const ourSide = tracker.state.sides[tracker.state.ourSideId ?? request.side.id];
  const actions: ChooseAction[] = [];
  for (let i = 0; i < (request.active?.length ?? 0); i++) {
    const slot = (i + 1) as 1 | 2;
    const reqActive = request.active![i];
    const me = actives[i];
    if (!reqActive || !me) {
      actions.push({kind: 'slot-default', slot});
      continue;
    }
    // 服务器 getChoiceIndex 会自动 pass fainted 槽位（sim/side.ts）；若这里仍发动作，会被错位应用到下一个参战位
    if (isFainted(me.condition)) continue;
    const tracked = findOurPokemon(ourSide, me);
    // 上一回合用过保护类招式 → 连续保护不可靠（PS stall 计数：第二次约 1/3），直接跳过保护类候选
    const chainedProtect = tracked?.lastMoveTurn !== undefined
      && tracked.lastMoveTurn === tracker.state.turn - 1
      && PROTECT_LIKE_MOVES.has(toId(tracked.lastMoveId ?? ''));
    const types = speciesTypes(dex, speciesOf(me));
    let best: {index: number; target?: string; score: number} | null = null;
    for (let j = 0; j < reqActive.moves.length; j++) {
      const mv = reqActive.moves[j];
      if (mv.disabled || mv.pp <= 0) continue;
      // 上一回合用过保护类招式 → 本回合不再考虑（连续保护不可靠，避免连续守住）
      if (chainedProtect && PROTECT_LIKE_MOVES.has(toId(mv.id))) continue;
      const move = dex.moves[toId(mv.id)];
      const spread = mv.target === 'allAdjacentFoes' || mv.target === 'allAdjacent';
      // CHOOSABLE_TARGETS（sim/battle-actions.ts）：这些 target 在双打必须写出目标位，否则服务器报 needs a target
      const needsFoeTarget = mv.target === 'normal' || mv.target === 'adjacentFoe' || mv.target === 'any';
      const needsAllyTarget = mv.target === 'adjacentAlly' || mv.target === 'adjacentAllyOrSelf';
      let score = 0;
      let target: string | undefined;
      if (!move || !move.basePower) {
        // 连续保护已在上方跳过；保护类仍按高于普通状态招式的分数优先
        score = PROTECT_LIKE_MOVES.has(toId(mv.id)) ? 0.9 : 0.5;
      } else if (spread) {
        // 与 sim trySpreadMoveHit 同源：命中多于一个目标才有 0.75x 减益（allAdjacent 还要看同伴是否存活）
        const partnerFights = actives.some(p => p !== me && !isFainted(p.condition));
        const spreadHits = foes.length !== 1 || (mv.target === 'allAdjacent' && partnerFights);
        for (const foe of foes) {
          const pct = estimateDamagePercent({
            dex, moveId: mv.id, attackerTypes: types, attackerStats: me.stats,
            attackerAbility: me.ability ?? me.baseAbility,
            defenderSpecies: foe.species, isSpread: spreadHits, weather,
          }) ?? 0;
          score = Math.max(score, pct);
        }
      } else if (needsFoeTarget && foes.length > 0) {
        for (let fi = 0; fi < foes.length; fi++) {
          const pct = estimateDamagePercent({
            dex, moveId: mv.id, attackerTypes: types, attackerStats: me.stats,
            attackerAbility: me.ability ?? me.baseAbility,
            defenderSpecies: foes[fi].species, weather,
          }) ?? 0;
          if (pct > score) {
            score = pct;
            target = `+${fi + 1}`;
          }
        }
      } else if (needsAllyTarget) {
        score = 0; // 同伴目标招式（Helping Hand 等）不用于对敌输出
      } else {
        const foe = foes[0];
        score = foe
          ? estimateDamagePercent({
            dex, moveId: mv.id, attackerTypes: types, attackerStats: me.stats,
            attackerAbility: me.ability ?? me.baseAbility,
            defenderSpecies: foe.species, weather,
          }) ?? 0
          : 0;
      }
      if (needsFoeTarget) target = target ?? (foes.length > 0 ? '+1' : undefined);
      else if (needsAllyTarget) target = slot === 1 ? '-2' : '-1';
      else target = undefined; // 其余 target 一律不写（写了会被服务器拒绝）
      if (!best || score > best.score) best = {index: j + 1, target, score};
    }
    if (!best) {
      actions.push({kind: 'slot-default', slot});
      continue;
    }
    actions.push({kind: 'move', slot, moveIndex: best.index, target: best.target});
  }
  return actions;
}

export function fallbackActions(ctx: FallbackContext): ChooseAction[] {
  const {request} = ctx;
  if (request.teamPreview) return [fallbackTeamPreview()];
  if (request.active) return fallbackTurnActions(ctx);
  if ((request.forceSwitch ?? []).some(Boolean)) return fallbackSwitchActions(ctx);
  return [{kind: 'default'}];
}
