import type {AppConfig} from '../config.js';
import type {DexData} from '../dex/index.js';
import {decideChoice} from '../decide/policy.js';
import type {JevClient} from '../jev/client.js';
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
  logger: Logger;
  conn: PsConnection;
  cfg: Pick<AppConfig, 'jevMock' | 'sendRqid'>;
}

/**
 * 单个战斗房间：消费协议行、处理 |request|、调用决策层并把 /choose 发回服务器。
 * - 同一 rqid 只答一次；更新的 request 会作废旧决策（generation 机制）
 * - |error|[Invalid choice] 连续 3 次后本场固定用本地启发式
 * - |win| / |tie| / |deinit| 触发结束汇总
 */
export class BattleRoom {
  readonly tracker: BattleTracker;
  private generation = 0;
  private lastRqidAnswered: number | null = null;
  private illegalErrors = 0;
  private heuristicMode = false;
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

  /** 顶层异常时的终极兜底 */
  sendDefault(): void {
    try {
      this.connSend('/choose default');
    } catch {
      /* 连接已断开，忽略 */
    }
  }

  private handleRequest(json: string): void {
    const request = parseRequest(json);
    if (!request) {
      this.opts.logger.warn(`[${this.opts.battleId}] 无法解析 |request|，发送 default`);
      this.connSend('/choose default');
      return;
    }
    if (request.wait) return; // 等待对手；服务器稍后会重发真正的 request
    if (request.rqid != null && this.lastRqidAnswered === request.rqid) return; // 同一 rqid 只答一次
    const generation = ++this.generation;
    void this.decideAndSend(request, generation);
  }

  private async decideAndSend(request: BattleRequest, generation: number): Promise<void> {
    try {
      const outcome = await decideChoice({
        dex: this.opts.dex,
        request,
        tracker: this.tracker,
        jev: this.heuristicMode ? null : this.opts.jev,
        logger: this.opts.logger,
        battleId: this.opts.battleId,
        cfg: this.opts.cfg,
      });
      if (generation !== this.generation) return; // 已被更新的 request 取代，丢弃
      if (!outcome) return;
      this.lastRqidAnswered = request.rqid ?? null;
      this.summary.decisions++;
      if (outcome.fallback) this.summary.fallbacks++;
      this.summary.costUsd += outcome.usage?.cost ?? 0;
      this.connSend(outcome.command);
      this.opts.logger.info(
        `[${this.opts.battleId}] 回合 ${this.tracker.state.turn}: ${outcome.command}${outcome.fallback ? '（本地兜底）' : ''}`,
      );
    } catch (err) {
      // 决策层理论上不抛错；这里兜住任何意外，绝不让计时器判负
      this.opts.logger.error(
        `[${this.opts.battleId}] 决策异常，发送 default: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (generation === this.generation) this.connSend('/choose default');
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
    }
  }

  private finish(winner: string | undefined): void {
    if (this.summary.finished) return;
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
