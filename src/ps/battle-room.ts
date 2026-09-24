import type {DexData} from '../dex/index.js';
import type {PriorMeta} from '../dex/priors.js';
import {decideChoice, type PolicyConfig} from '../decide/policy.js';
import type {AdvisorClient} from '../jev/advisor.js';
import type {JevClient} from '../jev/client.js';
import type {CallControl} from '../jev/deadline.js';
import type {DecisionsUsage} from '../jev/types.js';
import type {MemoryData} from '../learn/store.js';
import type {Logger} from '../log/logger.js';
import {parseLine, toId} from '../state/protocol.js';
import {parseRequest, type BattleRequest} from '../state/request.js';
import {BattleTracker} from '../state/tracker.js';
import type {PsConnection} from './connection.js';

export interface BattleSummary {
  battleId: string;
  winner?: string;
  won: boolean;
  turns: number;
  decisions: number;
  fallbacks: number;
  costUsd: number;
  finished: boolean;
}

export interface BattleRoomOptions {
  battleId: string;
  ourName: string;
  dex: DexData;
  jev: JevClient | null;
  advisor?: AdvisorClient | null;
  /** 统计先验与跨局经验（启动期加载一次，由会话透传） */
  priors?: PriorMeta | null;
  memory?: MemoryData | null;
  logger: Logger;
  conn: PsConnection;
  cfg: PolicyConfig;
}

/** 同一 request 被拒后最多自动补发几次修正指令 */
const MAX_CHOICE_RETRIES = 1;

/**
 * 单个战斗房间：消费协议行、处理 |request|、调用决策层并把 /choose 发回服务器。
 * - 相同 JSON 只答一次；更新的 request 会取消旧决策（generation 机制）
 * - |error|[Invalid choice] 后用本地启发式重发修正指令（服务器不会重发 request）；重试用尽后发 default
 * - |error|[Invalid choice] 连续 3 次后本场固定用本地启发式
 * - |win| / |tie| / |deinit| 触发结束汇总
 */
export class BattleRoom {
  readonly tracker: BattleTracker;
  private generation = 0;
  private lastRequestJson: string | null = null;
  private activeDecision: {controller: AbortController; control: CallControl} | null = null;
  private illegalErrors = 0;
  private heuristicMode = false;
  /** 最近一次已发送指令的 request；用于被拒后重发修正指令 */
  private pendingRequest: BattleRequest | null = null;
  private pendingRetries = 0;
  private summary: BattleSummary;
  private resolveFinished!: (summary: BattleSummary) => void;
  private finishedPromise: Promise<BattleSummary>;

  constructor(private opts: BattleRoomOptions) {
    this.tracker = new BattleTracker(opts.battleId, opts.ourName);
    this.summary = {
      battleId: opts.battleId,
      won: false,
      turns: 0,
      decisions: 0,
      fallbacks: 0,
      costUsd: 0,
      finished: false,
    };
    this.finishedPromise = new Promise(resolve => {
      this.resolveFinished = resolve;
    });
  }

  /** 结束前返回当前快照（turns 取 tracker 实时值） */
  getSummary(): BattleSummary {
    return {...this.summary, turns: this.tracker.state.turn};
  }

  /** 战斗结束（|win|/|tie|/|deinit|）时 resolve；构造后立即武装，避免竞态 */
  waitFinish(): Promise<BattleSummary> {
    return this.finishedPromise;
  }

  handleLine(line: string): void {
    this.opts.logger.protocol(this.opts.battleId, line);
    const parsed = parseLine(line);
    if (!parsed) return;
    this.tracker.handleLine(line);
    switch (parsed.type) {
      case 'request': {
        const payload = line.startsWith('|request|') ? line.slice('|request|'.length) : '';
        this.handleRequest(payload);
        break;
      }
      case 'error':
        this.handleError(parsed.args.join('|'));
        break;
      case 'win':
        this.finish(parsed.args[0]);
        break;
      case 'tie':
        this.finish(undefined);
        break;
      case 'deinit':
        if (!this.summary.finished) this.finish(this.tracker.state.winner);
        break;
      case 'inactive':
        this.opts.logger.warn(`[${this.opts.battleId}] 计时器告警: ${line}`);
        break;
      default:
        break;
    }
  }

  /** 作废当前请求；断线后收到新请求仍可继续决策。 */
  cancelPendingDecision(): void {
    const active = this.activeDecision;
    this.generation++;
    this.activeDecision = null;
    this.lastRequestJson = null;
    this.pendingRequest = null;
    this.pendingRetries = 0;
    active?.controller.abort();
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.summary.finished &&
      this.activeDecision !== null && !this.activeDecision.controller.signal.aborted;
  }

  private recordUsage(usage: DecisionsUsage, generation: number): void {
    const cost = usage.cost;
    if (this.isCurrent(generation) && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      this.summary.costUsd += cost;
    }
  }

  /** 顶层异常时的终极兜底 */
  sendDefault(): void {
    const valid = this.isCurrent(this.generation);
    const json = this.lastRequestJson;
    this.cancelPendingDecision();
    this.lastRequestJson = json;
    if (!valid) return;
    try {
      this.connSend('/choose default');
    } catch {
      /* 连接已断开，忽略 */
    }
  }

  private handleRequest(json: string): void {
    if (this.summary.finished) return;
    // wait 可以没有 side，必须先于完整 request 校验处理。
    try {
      if (JSON.parse(json)?.wait === true) {
        this.cancelPendingDecision();
        return;
      }
    } catch {
      // 交给下面的解析校验统一处理。
    }
    if (json === this.lastRequestJson) return;
    this.cancelPendingDecision();
    const controller = new AbortController();
    const control: CallControl = {
      signal: controller.signal,
      deadlineAt: Date.now() + (this.opts.cfg.jevDecisionBudgetMs ?? 35000),
    };
    this.activeDecision = {controller, control};
    this.lastRequestJson = json;
    const request = parseRequest(json);
    if (!request) {
      this.opts.logger.warn(`[${this.opts.battleId}] 无法解析 |request|，发送 default`);
      this.sendDefault();
      return;
    }
    void this.decideAndSend(request, this.generation, control);
  }

  private async decideAndSend(request: BattleRequest, generation: number, control: CallControl): Promise<void> {
    try {
      const outcome = await decideChoice({
        dex: this.opts.dex,
        request,
        tracker: this.tracker,
        jev: this.heuristicMode ? null : this.opts.jev,
        advisor: this.heuristicMode ? null : this.opts.advisor,
        priors: this.opts.priors,
        memory: this.opts.memory,
        control,
        onUsage: (usage: DecisionsUsage) => this.recordUsage(usage, generation),
        logger: this.opts.logger,
        battleId: this.opts.battleId,
        cfg: this.opts.cfg,
      });
      if (!this.isCurrent(generation)) return;
      if (!outcome) return;
      this.pendingRequest = request;
      this.pendingRetries = 0;
      this.summary.decisions++;
      if (outcome.fallback) this.summary.fallbacks++;
      this.connSend(outcome.command);
      this.opts.logger.info(
        `[${this.opts.battleId}] 回合 ${this.tracker.state.turn}: ${outcome.command}${outcome.fallback ? '（本地兜底）' : ''}`,
      );
    } catch (err) {
      // 决策层理论上不抛错；这里兜住任何意外，绝不让计时器判负
      if (!this.isCurrent(generation)) return;
      this.opts.logger.error(
        `[${this.opts.battleId}] 决策异常，发送 default: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.sendDefault();
    }
  }

  private handleError(text: string): void {
    this.opts.logger.warn(`[${this.opts.battleId}] |error| ${text}`);
    if (text.includes('[Invalid choice]')) {
      this.illegalErrors++;
      if (this.illegalErrors >= 3 && !this.heuristicMode) {
        this.heuristicMode = true;
        this.opts.logger.warn(
          `[${this.opts.battleId}] 连续 ${this.illegalErrors} 次非法指令，本场后续固定使用本地启发式`,
        );
      }
      // "too late" 可能是旧 rqid 的迟到错误；服务器不会因此补发 request。
      // 只清除重发记录，不取消可能已在飞的新请求。
      if (text.includes('too late')) {
        this.pendingRequest = null;
        this.pendingRetries = 0;
      } else {
        void this.retryAfterInvalidChoice();
      }
    }
  }

  /**
   * 服务器对被拒的 /choose 不会重发 request（sim/side.ts emitChoiceError 只发 |error|），
   * 必须自己补发修正指令，否则会白等到计时器超时被服务器代选。
   */
  private async retryAfterInvalidChoice(): Promise<void> {
    const request = this.pendingRequest;
    if (!request || !this.isCurrent(this.generation)) return;
    if (this.pendingRetries >= MAX_CHOICE_RETRIES) {
      this.opts.logger.error(`[${this.opts.battleId}] 非法指令重试次数用尽，发送 default`);
      this.sendDefault();
      return;
    }
    this.pendingRetries++;
    const generation = this.generation;
    try {
      const outcome = await decideChoice({
        dex: this.opts.dex,
        request,
        tracker: this.tracker,
        jev: null, // 原指令已被服务器判非法，直接改用本地启发式，不再调用模型
        advisor: null,
        priors: this.opts.priors,
        memory: this.opts.memory,
        control: this.activeDecision?.control,
        onUsage: (usage: DecisionsUsage) => this.recordUsage(usage, generation),
        logger: this.opts.logger,
        battleId: this.opts.battleId,
        cfg: this.opts.cfg,
      });
      if (!outcome || !this.isCurrent(generation)) return;
      this.summary.decisions++;
      this.summary.fallbacks++;
      this.connSend(outcome.command);
      this.opts.logger.warn(
        `[${this.opts.battleId}] 修正指令（第 ${this.pendingRetries} 次重试）: ${outcome.command}`,
      );
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      this.opts.logger.error(
        `[${this.opts.battleId}] 重试决策异常，发送 default: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.sendDefault();
    }
  }

  private finish(winner: string | undefined): void {
    if (this.summary.finished) return;
    this.cancelPendingDecision();
    this.summary.finished = true;
    this.summary.winner = winner;
    this.summary.won = winner != null && toId(winner) === toId(this.opts.ourName);
    this.summary.turns = this.tracker.state.turn;
    this.opts.logger.info(
      `[${this.opts.battleId}] 战斗结束：${winner ? `${winner} 获胜` : '平局/无结果'}` +
        `（回合 ${this.summary.turns}，决策 ${this.summary.decisions} 次，兜底 ${this.summary.fallbacks} 次，` +
        `花费 $${this.summary.costUsd.toFixed(6)}）`,
    );
    this.resolveFinished(this.getSummary());
  }

  private connSend(command: string): void {
    this.opts.conn.send(this.opts.battleId, command);
  }
}
