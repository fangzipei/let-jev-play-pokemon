import type {JevClient} from '../jev/client.js';
import type {AdvisorClient} from '../jev/advisor.js';
import {withDeadline, CallCancelledError, DeadlineExceededError, type CallControl} from '../jev/deadline.js';
import {buildAnalysisContext} from '../state/analysis.js';
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
  jevContextLevel?: 1 | 2 | 3;
  jevDecisionBudgetMs?: number;
  jevAdvisorTimeoutMs?: number;
}

export interface DecisionContext extends FallbackContext {
  jev: JevClient | null;
  logger: Logger;
  battleId: string;
  cfg: PolicyConfig;
  advisor?: AdvisorClient | null;
  control?: CallControl;
  /** 每个已完成 API 调用立即记账，即使随后请求被取消也保留已知费用。 */
  onUsage?: (usage: DecisionsUsage, source: 'jev' | 'advisor') => void;
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
  advisorUsage?: DecisionsUsage;
  advisorLatencyMs?: number;
  totalLatencyMs?: number;
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
  advisorUsage?: DecisionsUsage;
  advisorLatencyMs?: number;
  advisorStatus?: 'success' | 'unavailable' | 'failed';
  totalLatencyMs?: number;
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
  trace: DecisionRun,
): Promise<DecisionRun> {
  const level = ctx.cfg.jevContextLevel ?? 2;
  const analysis = buildAnalysisContext({dex: ctx.dex, state: ctx.tracker.state, request: ctx.request, level});
  const state = structuredClone(buildStatePayload({state: ctx.tracker.state, request: ctx.request, dex: ctx.dex, analysis}));
  // 在第一次 await 之前固定本次请求的状态和合法选项；advisor 与 jev 使用同一份快照。
  const plans = kind === 'team-preview' ? [] : kind === 'turn' ? buildTurnPlans({...ctx, analysis}) : buildSwitchPlans({...ctx, analysis});
  let questions: Record<string, Question> = kind === 'team-preview' ? buildPreviewQuestions({
    dex: ctx.dex, request: ctx.request, analysis,
    opponentPreviewSpecies: previewOpponentSpecies(ctx.tracker.state),
  }).questions : Object.fromEntries(plans.map(plan => [plan.questionName, plan.question]));
  if (!Object.keys(questions).length) throw new Error(`没有可提交给 jev 的 ${kind} 问题`);
  trace.state = state;
  trace.questions = questions;
  if (level === 3) {
    trace.advisorStatus = 'unavailable';
    if (ctx.advisor) {
      const deadlineAt = Math.min(ctx.control?.deadlineAt ?? Infinity, Date.now() + (ctx.cfg.jevAdvisorTimeoutMs ?? 10000));
      try {
        const advice = await withDeadline(signal => ctx.advisor!.analyze({kind, state, questions}, {signal, deadlineAt}), {
          signal: ctx.control?.signal, deadlineAt,
        });
        ctx.control?.signal?.throwIfAborted();
        if (advice) {
          trace.advisorUsage = advice.usage;
          trace.advisorLatencyMs = advice.latencyMs;
          ctx.onUsage?.(advice.usage, 'advisor');
          const text = advice.text.trim();
          trace.advisorStatus = text ? 'success' : 'failed';
          if (text) {
            state.advisor_analysis = {text, model: advice.model, latency_ms: advice.latencyMs};
            questions = Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, {
              ...question, instructions: `Coach analysis: ${text}\nWeigh this advice against the snapshot and legal options; the final choice is yours.\n${question.instructions}`,
            }]));
            trace.questions = questions;
          }
        } else trace.advisorStatus = 'failed';
      } catch {
        ctx.control?.signal?.throwIfAborted();
        trace.advisorStatus = 'failed';
      }
    }
    if (trace.advisorStatus !== 'success') ctx.logger.warn('advisor 不可用或超时，本次按 L2 上下文继续');
  }
  ctx.control?.signal?.throwIfAborted();
  const res = await jev.decide({sessionId: ctx.battleId, state, questions}, ctx.control);
  ctx.control?.signal?.throwIfAborted();
  trace.usage = res.usage;
  trace.latencyMs = res.latencyMs;
  trace.answers = res.answers;
  ctx.onUsage?.(res.usage, 'jev');
  if (kind === 'team-preview') {
    const {order, adjusted} = resolvePreviewOrder(res.answers);
    const missingCount = adjusted.filter(a => a.startsWith('missing:')).length;
    return {
      ...trace,
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
    ...trace,
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
    advisor_usage: run.advisorUsage,
    advisor_latency_ms: run.advisorLatencyMs,
    advisor_status: run.advisorStatus,
    total_latency_ms: run.totalLatencyMs,
    context_level: ctx.cfg.jevContextLevel ?? 2,
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
    advisorUsage: run.advisorUsage,
    advisorLatencyMs: run.advisorLatencyMs,
    totalLatencyMs: run.totalLatencyMs,
  };
}

/**
 * 回合决策入口：wait → null；JEV_MOCK/无客户端 → 本地兜底；jev 抛错 → 本地兜底；
 * jev 无任何可用答案 → 本地兜底；否则 jev 答案与本地兜底按槽位合并。
 */
export async function decideChoice(ctx: DecisionContext): Promise<DecisionOutcome | null> {
  if (ctx.request.wait || ctx.tracker.state.ended || ctx.control?.signal?.aborted) return null;
  const kind = decideKind(ctx.request);
  if (kind === 'none') return null;
  const jev = ctx.jev;
  if (ctx.cfg.jevMock || !jev) {
    const note = ctx.cfg.jevMock ? 'JEV_MOCK=1' : 'no jev client configured';
    return finish(ctx, kind, localRun(ctx, note), true);
  }
  const started = Date.now();
  const deadlineAt = Math.min(ctx.control?.deadlineAt ?? Infinity, started + (ctx.cfg.jevDecisionBudgetMs ?? 35000));
  const trace = localRun(ctx, 'jev error');
  let run: DecisionRun;
  try {
    run = await withDeadline(signal => runWithJev({...ctx, control: {signal, deadlineAt}}, kind, jev, trace), {
      signal: ctx.control?.signal, deadlineAt,
    });
  } catch (err) {
    // 取消代表请求已经失效；超时仍应为当前请求及时提供本地动作。
    if (ctx.control?.signal?.aborted || ctx.tracker.state.ended || err instanceof CallCancelledError) return null;
    ctx.logger.warn(err instanceof DeadlineExceededError ? '决策总预算耗尽，改用本地兜底' : 'jev 决策失败，改用本地兜底');
    trace.totalLatencyMs = Date.now() - started;
    trace.actions = fallbackActions(ctx);
    return finish(ctx, kind, trace, true);
  }
  if (ctx.control?.signal?.aborted || ctx.tracker.state.ended) return null;
  run.totalLatencyMs = Date.now() - started;
  if (run.replacedCount === 0) {
    return finish(ctx, kind, {...run, actions: fallbackActions(ctx), adjusted: [...run.adjusted, 'no usable jev answer']}, true);
  }
  return finish(ctx, kind, run, false);
}
