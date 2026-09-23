import {loadConfig, type AppConfig} from '../config.js';
import {loadDex, type DexData} from '../dex/index.js';
import {loadPikaMeta} from '../dex/pikalytics.js';
import {createAdvisorClient} from '../jev/advisor.js';
import {createJevClient, type JevClient} from '../jev/client.js';
import {loadMemory} from '../learn/store.js';
import {createLogger, type Logger} from '../log/logger.js';
import type {BattleRoom, BattleSummary} from '../ps/battle-room.js';
import {PsConnection, type WsLike} from '../ps/connection.js';
import {PsSession} from '../ps/session.js';
import {loadTeamPaste, packTeam, stripMegaSuffix} from '../ps/team.js';
import {sleep} from './wait.js';

export interface RunOptions {
  cfg?: AppConfig;
  logger?: Logger;
  /** 测试注入 */
  dex?: DexData;
  paste?: string;
  wsFactory?: (url: string) => WsLike;
  fetchImpl?: typeof fetch;
  /** 等待战斗出现的上限（默认 120000） */
  waitBattleTimeoutMs?: number;
}

export interface RunResult {
  summaries: BattleSummary[];
  wins: number;
  losses: number;
  totalCostUsd: number;
}

export function summarizeBattles(summaries: BattleSummary[]): RunResult {
  const wins = summaries.filter(s => s.won).length;
  return {
    summaries,
    wins,
    losses: summaries.length - wins,
    totalCostUsd: summaries.reduce((sum, s) => sum + s.costUsd, 0),
  };
}

function mkJevClient(cfg: AppConfig, logger: Logger, fetchImpl?: typeof fetch): JevClient | null {
  if (cfg.jevMock) {
    logger.info('JEV_MOCK=1：跳过 Decisions API，全部使用本地启发式');
    return null;
  }
  return createJevClient({
    apiKey: cfg.openrouterApiKey,
    model: cfg.jevModel,
    transport: cfg.jevTransport,
    timeoutMs: cfg.jevTimeoutMs,
    retry: cfg.jevRetry,
    fetchImpl,
    logger,
  });
}

async function waitForBattle(
  session: PsSession,
  timeoutMs: number,
  getFatal: () => string | undefined,
  exclude: Set<string>,
): Promise<BattleRoom> {
  const started = Date.now();
  for (;;) {
    const fatal = getFatal();
    if (fatal) throw new Error(`会话失败: ${fatal}`);
    const room = [...session.rooms.values()].find(r => !exclude.has(r.tracker.state.id));
    if (room) return room;
    if (Date.now() - started > timeoutMs) {
      throw new Error('等待战斗开始超时（队伍是否合法？对手是否接受挑战？）');
    }
    await sleep(100);
  }
}

/** 端到端编排：登录 → 搜索/挑战 → 每场决策 → 汇总 */
export async function runMatch(opts: RunOptions = {}): Promise<RunResult> {
  const cfg = opts.cfg ?? loadConfig();
  const logger = opts.logger ?? createLogger({logDir: cfg.logDir, logLevel: cfg.logLevel});
  const dex = opts.dex ?? (await loadDex({fetchImpl: opts.fetchImpl}));
  const jev = mkJevClient(cfg, logger, opts.fetchImpl);
  const advisor = !cfg.jevMock && cfg.jevContextLevel === 3 && cfg.jevAdvisorApiKey.trim()
    ? createAdvisorClient({
      apiKey: cfg.jevAdvisorApiKey,
      model: cfg.jevAdvisorModel,
      timeoutMs: cfg.jevAdvisorTimeoutMs,
      maxTokens: cfg.jevAdvisorMaxTokens,
      reasoningEffort: cfg.jevAdvisorReasoning,
      fetchImpl: opts.fetchImpl,
      logger,
    })
    : null;
  const pika = cfg.pikaEnabled
    ? await loadPikaMeta({
      format: cfg.psFormat, cutoff: cfg.pikaCutoff, cacheDir: cfg.pikaDir,
      fetchImpl: opts.fetchImpl, log: msg => logger.warn(msg),
    })
    : null;
  logger.info(pika
    ? `Pikalytics 先验已加载（${pika.dataDate}，${Object.keys(pika.bySpecies).length} 物种）`
    : 'Pikalytics 先验不可用（无假设注入）');
  const memory = await loadMemory(cfg.memoryDir);
  logger.info(`跨局经验库已加载（${Object.keys(memory.species).length} 物种）`);
  const paste = opts.paste ?? loadTeamPaste(cfg.teamFile);
  const team = packTeam(paste);
  const teamFallback = packTeam(stripMegaSuffix(paste));
  logger.info(`队伍已打包（${team.hasMegaFormSpecies ? '含 -Mega 形态写法' : '常规写法'}），共 ${cfg.maxBattles} 场`);

  let fatal: string | undefined;
  const conn = new PsConnection({serverUrl: cfg.psServer, logger, wsFactory: opts.wsFactory});
  const session = new PsSession({
    conn,
    cfg,
    logger,
    dex,
    jev,
    advisor,
    pika,
    memory,
    packedTeam: team.packed,
    packedTeamFallback: teamFallback.packed,
    fetchImpl: opts.fetchImpl,
    onFatal: reason => {
      fatal = reason;
    },
  });
  conn.onMessage(msg => session.handleMessage(msg));
  conn.onReconnect(() => logger.warn('已重连；等待服务器重新发送 challstr 并重新登录'));
  conn.onClose(() => {
    session.dispose();
    logger.warn('与 PS 的连接已关闭');
  });

  const summaries: BattleSummary[] = [];
  try {
    await conn.connect();
    const timeoutMs = opts.waitBattleTimeoutMs ?? 120000;
    const done = new Set<string>();
    for (let battleNo = 1; battleNo <= cfg.maxBattles; battleNo++) {
      const room = await waitForBattle(session, timeoutMs, () => fatal, done);
      logger.info(`第 ${battleNo}/${cfg.maxBattles} 场战斗: ${room.tracker.state.id}`);
      const summary = await room.waitFinish();
      done.add(summary.battleId);
      summaries.push(summary);
      logger.info(
        `第 ${battleNo} 场结束: ${summary.won ? '胜利' : summary.winner ? '失败' : '无结果'}，回合 ${summary.turns}，` +
          `决策 ${summary.decisions}（兜底 ${summary.fallbacks}），花费 $${summary.costUsd.toFixed(6)}`,
      );
      if (battleNo < cfg.maxBattles) {
        await sleep(3000);
        session.startSearch();
      }
    }
  } catch (err) {
    logger.error(`运行中断: ${err instanceof Error ? err.message : String(err)}`);
    for (const room of session.rooms.values()) {
      if (!room.getSummary().finished) room.sendDefault();
    }
    throw err;
  } finally {
    session.dispose();
    conn.close();
    logger.close();
  }
  const result = summarizeBattles(summaries);
  logger.info(
    `全部 ${result.summaries.length} 场: ${result.wins} 胜 ${result.losses} 负，总花费 $${result.totalCostUsd.toFixed(6)}`,
  );
  return result;
}
