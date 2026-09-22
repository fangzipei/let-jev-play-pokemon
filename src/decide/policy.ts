import type {JevClient} from '../jev/client.js';
import type {Answer, DecisionsUsage, Question} from '../jev/types.js';
import type {Logger} from '../log/logger.js';
import {buildChooseCommand, validateActions, type ChooseAction} from '../ps/choose.js';
import type {BattleRequest} from '../state/request.js';
import {buildStatePayload} from '../state/serialize.js';
import type {BattleState} from '../state/tracker.js';
import {resolveKey} from './answers.js';
import {fallbackActions, type FallbackContext} from './fallback.js';
import {buildSwitchPlans} from './force-switch.js';
import {buildPreviewQuestions, fullTeamOrder, resolvePreviewOrder} from './team-preview.js';
import {buildTurnPlans, type SlotAction, type SlotQuestionPlan} from './turn.js';

export type DecisionKind = 'team-preview' | 'turn' | 'force-switch' | 'none';

export interface PolicyConfig {
  jevMock: boolean;
  sendRqid: boolean;
}

export interface DecisionContext extends FallbackContext {
  jev: JevClient | null;
  logger: Logger;
  battleId: string;
  cfg: PolicyConfig;
}

export interface DecisionOutcome {
  kind: Exclude<DecisionKind, 'none'>;
  command: string;
  chosen: ChooseAction[];
  adjusted: string[];
  fallback: boolean;
  answers?: Record<string, Answer>;
  usage?: DecisionsUsage;
  latencyMs?: number;
}

export function decideKind(request: BattleRequest): DecisionKind {
  if (request.teamPreview) return 'team-preview';
  if (request.active) return 'turn';
  if ((request.forceSwitch ?? []).some(Boolean)) return 'force-switch';
  return 'none';
}

interface SlotPick {
  slot: 1 | 2;
  action: SlotAction;
  key: string;
  confidence: number;
}

interface DecisionRun {
  actions: ChooseAction[];
  adjusted: string[];
  /** 成功替换的槽位数；0 = 没有任何可用答案（视为兜底） */
  replacedCount: number;
  answers: Record<string, Answer>;
  usage: DecisionsUsage;
  latencyMs: number;
  state: unknown;
  questions: Record<string, Question>;
}

function previewOpponentSpecies(state: BattleState): string[] {
  const oppId = state.ourSideId === 'p1' ? 'p2' : 'p1';
  return (state.sides[oppId]?.pokemon ?? []).map(p => p.species);
}

/** 以本地兜底动作为底，用 jev 挑选的槽位动作逐一替换 */
function mergeBySlot(base: ChooseAction[], picks: SlotPick[]): {actions: ChooseAction[]; replacedCount: number} {
  const bySlot = new Map<number, ChooseAction>();
  for (const pick of picks) bySlot.set(pick.slot, pick.action);
  let replacedCount = 0;
  const actions = base.map(action => {
    if ('slot' in action) {
      const pick = bySlot.get(action.slot);
      if (pick) {
        replacedCount++;
        return pick;
      }
    }
    return action;
  });
  return {actions, replacedCount};
}

/** 双槽位同时声明 Mega 时，保留 confidence 更高者，其余降级为普通招式 */
function degradeMegaConflicts(actions: ChooseAction[], picks: SlotPick[], adjusted: string[]): ChooseAction[] {
  const megas: Array<{slot: 1 | 2; confidence: number}> = [];
  for (const action of actions) {
    if (action.kind === 'move' && action.mega) {
      megas.push({slot: action.slot, confidence: picks.find(p => p.slot === action.slot)?.confidence ?? 0});
    }
  }
  if (megas.length <= 1) return actions;
  const keepSlot = [...megas].sort((a, b) => b.confidence - a.confidence || a.slot - b.slot)[0].slot;
  return actions.map(action => {
    if (action.kind === 'move' && action.mega && action.slot !== keepSlot) {
      adjusted.push(`mega-conflict: slot ${action.slot} downgraded (kept slot ${keepSlot})`);
      return {...action, mega: undefined};
    }
    return action;
  });
}

/**
 * 同一只替补不能被两个槽位同时换入（服务器 sim/side.ts 会拒绝 "can only switch in once"）。
 * 合并结果中出现重复时，后出现的槽位改用该槽位问题 probabilities（缺失时按选项顺序）中最高的未用替补；
 * 无候选时保留原动作，交给 validateActions 判定后整体兜底。
 */
function dedupeSwitchTargets(
  actions: ChooseAction[],
  plans: SlotQuestionPlan[],
  answers: Record<string, Answer>,
  adjusted: string[],
): ChooseAction[] {
  const used = new Set<number>();
  const out: ChooseAction[] = [];
  for (const action of actions) {
    if (action.kind !== 'switch') {
      out.push(action);
      continue;
    }
    if (!used.has(action.teamIndex)) {
      used.add(action.teamIndex);
      out.push(action);
      continue;
    }
    const plan = plans.find(p => p.slot === action.slot);
    const answer = plan ? answers[plan.questionName] : undefined;
    const probabilities = answer && answer.type === 'choice' ? answer.probabilities ?? {} : {};
    const alternative = (plan?.options ?? [])
      .filter(o => o.action.kind === 'switch' && !used.has(o.action.teamIndex))
      .sort((a, b) => (probabilities[b.key] ?? -1) - (probabilities[a.key] ?? -1))[0];
    if (plan && alternative && alternative.action.kind === 'switch') {
      used.add(alternative.action.teamIndex);
      adjusted.push(`adjusted:${plan.questionName}: ${alternative.key}`);
      out.push(alternative.action);
    } else {
      out.push(action);
    }
  }
  return out;
}

function localRun(ctx: FallbackContext, note: string): DecisionRun {
  return {
    actions: fallbackActions(ctx),
    adjusted: [note],
    replacedCount: 0,
    answers: {},
    usage: {},
    latencyMs: 0,
    state: null,
    questions: {},
  };
}

async function runWithJev(
  ctx: DecisionContext,
  kind: Exclude<DecisionKind, 'none'>,
  jev: JevClient,
): Promise<DecisionRun> {
  const state = buildStatePayload({state: ctx.tracker.state, request: ctx.request, dex: ctx.dex});
  if (kind === 'team-preview') {
    const {questions} = buildPreviewQuestions({
      dex: ctx.dex,
      request: ctx.request,
      opponentPreviewSpecies: previewOpponentSpecies(ctx.tracker.state),
    });
    const res = await jev.decide({sessionId: ctx.battleId, state, questions});
    const {order, adjusted} = resolvePreviewOrder(res.answers);
    const missingCount = adjusted.filter(a => a.startsWith('missing:')).length;
    return {
      actions: [{kind: 'team', order: fullTeamOrder(order)}],
      adjusted,
      replacedCount: order.length - missingCount,
      answers: res.answers,
      usage: res.usage,
      latencyMs: res.latencyMs,
      state,
      questions,
    };
  }
  const plans = kind === 'turn' ? buildTurnPlans(ctx) : buildSwitchPlans(ctx);
  if (plans.length === 0) throw new Error(`没有可提交给 jev 的 ${kind} 问题`);
  const questions: Record<string, Question> = {};
  for (const plan of plans) questions[plan.questionName] = plan.question;
  const res = await jev.decide({sessionId: ctx.battleId, state, questions});
  const picks: SlotPick[] = [];
  const adjusted: string[] = [];
  for (const plan of plans) {
    const resolved = resolveKey(res.answers[plan.questionName], plan.options.map(o => o.key));
    if (!resolved) {
      adjusted.push(`missing:${plan.questionName}`);
      continue;
    }
    const option = plan.options.find(o => o.key === resolved.key);
    if (!option) continue;
    if (resolved.adjusted) adjusted.push(`adjusted:${plan.questionName}: ${resolved.key}`);
    picks.push({slot: plan.slot, action: option.action, key: resolved.key, confidence: resolved.confidence});
  }
  const merged = mergeBySlot(fallbackActions(ctx), picks);
  const deduped = dedupeSwitchTargets(merged.actions, plans, res.answers, adjusted);
  const actions = degradeMegaConflicts(deduped, picks, adjusted);
  return {
    actions,
    adjusted,
    replacedCount: merged.replacedCount,
    answers: res.answers,
    usage: res.usage,
    latencyMs: res.latencyMs,
    state,
    questions,
  };
}

function finish(
  ctx: DecisionContext,
  kind: Exclude<DecisionKind, 'none'>,
  run: DecisionRun,
  usedFallback: boolean,
): DecisionOutcome {
  let actions = run.actions;
  let fallback = usedFallback;
  let problems = validateActions(actions, ctx.request);
  if (problems.length > 0) {
    ctx.logger.warn(`动作校验失败（${problems.join('；')}），改用本地兜底`, {actions});
    actions = fallbackActions(ctx);
    fallback = true;
    run.adjusted.push(`invalid: ${problems.join('；')}`);
    problems = validateActions(actions, ctx.request);
    if (problems.length > 0) {
      // 终极兜底：绝不让计时器判负
      ctx.logger.error(`兜底动作仍非法（${problems.join('；')}），使用 /choose default`);
      actions = [{kind: 'default'}];
    }
  }
  const command = buildChooseCommand(actions, {rqid: ctx.request.rqid, sendRqid: ctx.cfg.sendRqid});
  ctx.logger.decision(ctx.battleId, {
    kind,
    turn: ctx.tracker.state.turn,
    rqid: ctx.request.rqid,
    chosen: actions,
    adjusted: run.adjusted,
    fallback,
    latency_ms: run.latencyMs,
    usage: run.usage,
    answers: run.answers,
    questions: run.questions,
    state: run.state,
  });
  return {
    kind,
    command,
    chosen: actions,
    adjusted: run.adjusted,
    fallback,
    answers: run.answers,
    usage: run.usage,
    latencyMs: run.latencyMs,
  };
}

/**
 * 回合决策入口：wait → null；JEV_MOCK/无客户端 → 本地兜底；jev 抛错 → 本地兜底；
 * jev 无任何可用答案 → 本地兜底；否则 jev 答案与本地兜底按槽位合并。
 */
export async function decideChoice(ctx: DecisionContext): Promise<DecisionOutcome | null> {
  if (ctx.request.wait || ctx.tracker.state.ended) return null;
  const kind = decideKind(ctx.request);
  if (kind === 'none') return null;
  const jev = ctx.jev;
  if (ctx.cfg.jevMock || !jev) {
    const note = ctx.cfg.jevMock ? 'JEV_MOCK=1' : 'no jev client configured';
    return finish(ctx, kind, localRun(ctx, note), true);
  }
  let run: DecisionRun;
  try {
    run = await runWithJev(ctx, kind, jev);
  } catch (err) {
    ctx.logger.warn(`jev 决策失败，改用本地兜底: ${err instanceof Error ? err.message : String(err)}`);
    return finish(ctx, kind, localRun(ctx, 'jev error'), true);
  }
  if (run.replacedCount === 0) {
    return finish(ctx, kind, {...run, actions: fallbackActions(ctx), adjusted: [...run.adjusted, 'no usable jev answer']}, true);
  }
  return finish(ctx, kind, run, false);
}
