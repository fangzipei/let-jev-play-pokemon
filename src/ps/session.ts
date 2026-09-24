import type {AppConfig} from '../config.js';
import type {DexData} from '../dex/index.js';
import type {PriorMeta} from '../dex/priors.js';
import type {AdvisorClient} from '../jev/advisor.js';
import type {JevClient} from '../jev/client.js';
import type {MemoryData} from '../learn/store.js';
import type {Logger} from '../log/logger.js';
import {parseLine} from '../state/protocol.js';
import {BattleRoom} from './battle-room.js';
import type {PsConnection, PsMessage} from './connection.js';
import {buildTrnCommand, getAssertion} from './login.js';

/** 主站对局页 URL（实时观战/赛后回放入口） */
function battleUrl(battleId: string): string {
  return `https://play.pokemonshowdown.com/${battleId}`;
}

export interface PsSessionOptions {
  conn: PsConnection;
  cfg: AppConfig;
  logger: Logger;
  dex: DexData;
  jev: JevClient | null;
  advisor?: AdvisorClient | null;
  /** 统计先验与跨局经验（启动期加载一次，透传给每个战斗房间） */
  priors?: PriorMeta | null;
  memory?: MemoryData | null;
  packedTeam: string;
  /** 队伍被拒绝时的剥离 -Mega 重打包版本（spec 不确定项 1） */
  packedTeamFallback?: string;
  fetchImpl?: typeof fetch;
  /** 无法恢复的错误（如队伍非法弹窗）时回调，由上层决定退出 */
  onFatal?: (reason: string) => void;
}

/**
 * 一个 PS 账号会话：登录 → 上传队伍 → 开始匹配；并把战斗房间消息路由给 BattleRoom。
 * - 全局消息（challstr/updateuser/nametaken/popup/updatechallenges）在这里处理
 * - battle-* 房间消息懒创建 BattleRoom 并逐行转发
 */
export class PsSession {
  readonly rooms = new Map<string, BattleRoom>();
  private username: string;
  private challstr = '';
  private loggedIn = false;
  private nametakenRetried = false;
  private teamFallbackTried = false;
  private loginResolvers: Array<() => void> = [];
  private battleResolvers: Array<(room: BattleRoom) => void> = [];

  constructor(private opts: PsSessionOptions) {
    this.username = opts.cfg.psUsername;
  }

  /** 登录完成时回调（已登录则立即回调） */
  onLogin(handler: () => void): void {
    if (this.loggedIn) {
      handler();
      return;
    }
    this.loginResolvers.push(handler);
  }

  /** 第一个战斗房间出现时 resolve（已存在则立即返回） */
  waitForBattle(): Promise<BattleRoom> {
    const existing = [...this.rooms.values()][0];
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      this.battleResolvers.push(resolve);
    });
  }

  /** 取消所有房间的当前决策；不禁用后续重连消息。 */
  dispose(): void {
    for (const room of this.rooms.values()) room.cancelPendingDecision();
  }

  handleMessage(msg: PsMessage): void {
    if (msg.roomId) {
      if (msg.roomId.startsWith('battle-')) {
        const room = this.roomFor(msg.roomId);
        for (const line of msg.lines) room.handleLine(line);
      }
      return;
    }
    for (const line of msg.lines) this.handleGlobalLine(line);
  }

  private roomFor(battleId: string): BattleRoom {
    let room = this.rooms.get(battleId);
    if (!room) {
      room = new BattleRoom({
        battleId,
        ourName: this.username,
        dex: this.opts.dex,
        jev: this.opts.jev,
        advisor: this.opts.advisor,
        priors: this.opts.priors,
        memory: this.opts.memory,
        logger: this.opts.logger,
        conn: this.opts.conn,
        cfg: this.opts.cfg,
      });
      this.rooms.set(battleId, room);
      this.opts.logger.info(`进入战斗房间: ${battleId}（${battleUrl(battleId)}）`);
      // 每场对局默认请求开启计时器（用户约定：超时自动判负而非无限等待）
      this.opts.conn.send(battleId, '/timer on');
      for (const resolve of this.battleResolvers.splice(0)) resolve(room);
    }
    return room;
  }

  private handleGlobalLine(line: string): void {
    const parsed = parseLine(line);
    if (!parsed) return;
    switch (parsed.type) {
      case 'challstr':
        void this.login(parsed.args.join('|'));
        break;
      case 'updateuser': {
        // |updateuser|USER|NAMED|AVATAR|SETTINGS （NAMED: 0=游客 1=已登录）
        const name = (parsed.args[0] ?? '').trim();
        if (parsed.args[1] === '1' && name) this.onLoggedIn(name);
        break;
      }
      case 'nametaken': {
        const reason = parsed.args[1] ?? '';
        this.opts.logger.warn(`名字被占用（${reason}）`);
        if (!this.opts.cfg.psPassword && !this.nametakenRetried) {
          this.nametakenRetried = true;
          this.username = `${this.opts.cfg.psUsername}${Math.floor(1000 + Math.random() * 9000)}`;
          this.opts.logger.warn(`游客模式：改用 ${this.username} 重试一次`);
          void this.loginWithCurrentChallstr();
        }
        break;
      }
      case 'popup': {
        const text = parsed.args.join('|');
        this.opts.logger.error(`服务器弹窗: ${text}`);
        if (
          this.rooms.size === 0 &&
          /team|invalid|reject/i.test(text) &&
          this.opts.packedTeamFallback &&
          !this.teamFallbackTried
        ) {
          this.teamFallbackTried = true;
          this.opts.logger.warn('队伍可能被拒绝：剥离 -Mega 后缀重新上传并重试搜索');
          this.opts.conn.command(`/utm ${this.opts.packedTeamFallback}`);
          this.startSearch();
        } else {
          this.opts.onFatal?.(text);
        }
        break;
      }
      case 'updatechallenges': {
        const payload = parsed.args[0] ?? '{}';
        try {
          const data = JSON.parse(payload) as {challengesFrom?: Record<string, string>};
          const from = Object.keys(data.challengesFrom ?? {});
          if (from.length > 0) {
            this.opts.logger.info(`收到挑战: ${from.join(', ')}`);
            if (this.opts.cfg.startMode === 'accept') {
              this.opts.conn.command(`/accept ${from[0]}`);
              this.opts.logger.info(`已接受 ${from[0]} 的挑战`);
            }
          }
        } catch {
          this.opts.logger.debug(`updatechallenges 解析失败: ${payload}`);
        }
        break;
      }
      default:
        break;
    }
  }

  private async login(challstr: string): Promise<void> {
    this.challstr = challstr;
    this.opts.logger.debug(`收到 challstr: ${challstr.slice(0, 12)}…`);
    await this.loginWithCurrentChallstr();
  }

  private async loginWithCurrentChallstr(): Promise<void> {
    try {
      const assertion = await getAssertion({
        name: this.username,
        password: this.opts.cfg.psPassword,
        challstr: this.challstr,
        logger: this.opts.logger,
        fetchImpl: this.opts.fetchImpl,
      });
      this.opts.conn.command(buildTrnCommand(this.username, assertion));
    } catch (err) {
      const reason = `登录失败: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.logger.error(reason);
      this.opts.onFatal?.(reason);
    }
  }

  private onLoggedIn(name: string): void {
    if (this.loggedIn) return;
    this.loggedIn = true;
    this.username = name;
    this.opts.logger.info(`登录成功: ${name}`);
    this.opts.conn.command(`/utm ${this.opts.packedTeam}`);
    this.startSearch();
    for (const resolve of this.loginResolvers.splice(0)) resolve();
  }

  /** 开始匹配；多场模式在每场结束后重新调用 */
  startSearch(): void {
    const {cfg, conn, logger} = this.opts;
    switch (cfg.startMode) {
      case 'ladder':
        conn.command(`/search ${cfg.psFormat}`);
        logger.info(`开始搜索: ${cfg.psFormat}`);
        break;
      case 'challenge':
        conn.command(`/challenge ${cfg.challengeUser}, ${cfg.psFormat}`);
        logger.info(`向 ${cfg.challengeUser} 发起挑战: ${cfg.psFormat}`);
        break;
      case 'accept':
        logger.info('accept 模式：等待他人挑战');
        break;
    }
  }
}
