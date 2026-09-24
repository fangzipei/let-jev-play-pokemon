import 'dotenv/config';

export interface AppConfig {
  openrouterApiKey: string;
  jevModel: string;
  jevTransport: 'sdk' | 'fetch' | 'chat';
  jevTimeoutMs: number;
  jevMock: boolean;
  jevRetry: number;
  jevContextLevel: 1 | 2 | 3;
  jevAdvisorModel: string;
  jevAdvisorApiKey: string;
  jevAdvisorTimeoutMs: number;
  jevAdvisorMaxTokens: number;
  /** 仅对确认支持推理参数的模型显式设置；未设置时不注入 reasoning。 */
  jevAdvisorReasoning?: 'low' | 'medium' | 'high';
  jevDecisionBudgetMs: number;
  psServer: string;
  psUsername: string;
  psPassword: string;
  psFormat: string;
  teamFile: string;
  startMode: 'ladder' | 'challenge' | 'accept';
  challengeUser: string;
  maxBattles: number;
  sendRqid: boolean;
  logDir: string;
  logLevel: 'debug' | 'info' | 'warn';
  /** 已停用：Pikalytics 先验默认关闭（决策先验由 pokechamdb 每日快照供应）；仅 JEV_PIKA_ENABLED=1 显式恢复。 */
  pikaEnabled: boolean;
  pikaCutoff: number;
  /** （仅停用路径使用）Pikalytics 先验缓存目录。 */
  pikaDir: string;
  /** 决策统计先验（items/abilities/moves 使用率与英文效果说明）的来源目录，由 `npm run chamdb:refresh` 写入。 */
  chamdbDir: string;
  /** Pokechamdb 本地缓存的重新同步间隔（小时）。 */
  chamdbTtlHours: number;
  memoryDir: string;
  reviewModel: string;
  reviewApiKey: string;
  /** 未设置 = `npm run review` 不发送 max_tokens（不限制输出，含推理 token）。 */
  reviewMaxTokens?: number;
}

function parseAdvisorReasoning(raw: string | undefined): 'low' | 'medium' | 'high' | undefined {
  const value = raw?.trim() ?? '';
  if (!value) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error(`JEV_ADVISOR_REASONING 仅支持 low、medium 或 high（收到 ${value}）`);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: {requireApiKey?: boolean} = {},
): AppConfig {
  const level = Number(env.JEV_CONTEXT_LEVEL ?? 2);
  const validLevel = level === 1 || level === 2 || level === 3;
  if (!validLevel) console.warn('JEV_CONTEXT_LEVEL 无效；回退为 2');
  const mainKey = env.OPENROUTER_API_KEY?.trim() ?? '';
  const cfg: AppConfig = {
    openrouterApiKey: mainKey,
    jevModel: env.JEV_MODEL ?? '~typesafe/jev-latest',
    jevTransport: (env.JEV_TRANSPORT ?? 'sdk') as AppConfig['jevTransport'],
    jevTimeoutMs: Number(env.JEV_TIMEOUT_MS ?? 20000),
    jevMock: env.JEV_MOCK === '1',
    jevRetry: Number(env.JEV_RETRY ?? 1),
    jevContextLevel: validLevel ? level : 2,
    jevAdvisorModel: env.JEV_ADVISOR_MODEL ?? 'google/gemini-3.8-flash',
    jevAdvisorApiKey: env.JEV_ADVISOR_API_KEY?.trim() || mainKey,
    jevAdvisorTimeoutMs: Number(env.JEV_ADVISOR_TIMEOUT_MS ?? 10000),
    jevAdvisorMaxTokens: Number(env.JEV_ADVISOR_MAX_TOKENS ?? 2048),
    jevAdvisorReasoning: parseAdvisorReasoning(env.JEV_ADVISOR_REASONING),
    jevDecisionBudgetMs: Number(env.JEV_DECISION_BUDGET_MS ?? 35000),
    psServer: env.PS_SERVER ?? 'wss://sim3.psim.us/showdown/websocket',
    psUsername: env.PS_USERNAME ?? `JevBot${Math.floor(1000 + Math.random() * 9000)}`,
    psPassword: env.PS_PASSWORD ?? '',
    psFormat: env.PS_FORMAT ?? 'gen9championsvgc2026regmc',
    teamFile: env.TEAM_FILE ?? 'team.txt',
    startMode: (env.START_MODE ?? 'ladder') as AppConfig['startMode'],
    challengeUser: env.CHALLENGE_USER ?? '',
    maxBattles: Number(env.MAX_BATTLES ?? 1),
    sendRqid: env.SEND_RQID !== '0',
    logDir: env.LOG_DIR ?? 'logs',
    logLevel: (env.LOG_LEVEL ?? 'info') as AppConfig['logLevel'],
    pikaEnabled: env.JEV_PIKA_ENABLED === '1',
    pikaCutoff: Number(env.JEV_PIKA_CUTOFF ?? 1760),
    pikaDir: env.JEV_PIKA_DIR ?? '.cache/pikalytics',
    chamdbDir: env.JEV_CHAMDB_DIR ?? '.cache/pokechamdb',
    chamdbTtlHours: Number(env.JEV_CHAMDB_TTL_HOURS ?? 24),
    memoryDir: env.JEV_MEMORY_DIR ?? '.cache/jev-memory',
    reviewModel: (env.JEV_REVIEW_MODEL ?? '').trim(),
    reviewApiKey: env.JEV_REVIEW_API_KEY?.trim() || mainKey,
    reviewMaxTokens: env.JEV_REVIEW_MAX_TOKENS?.trim() ? Number(env.JEV_REVIEW_MAX_TOKENS) : undefined,
  };
  validateConfig(cfg, opts);
  return cfg;
}

export function validateConfig(cfg: AppConfig, opts: {requireApiKey?: boolean} = {}): void {
  const requireApiKey = opts.requireApiKey ?? true;
  if (requireApiKey && !cfg.jevMock && !cfg.openrouterApiKey.trim()) {
    throw new Error('OPENROUTER_API_KEY is required unless JEV_MOCK=1');
  }
  for (const [name, value] of [
    ['JEV_TIMEOUT_MS', cfg.jevTimeoutMs],
    ['JEV_ADVISOR_TIMEOUT_MS', cfg.jevAdvisorTimeoutMs],
    ['JEV_DECISION_BUDGET_MS', cfg.jevDecisionBudgetMs],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > 2147483647) {
      throw new Error(`${name} 必须是 1 至 2147483647 的整数毫秒数`);
    }
  }
  if (!Number.isSafeInteger(cfg.jevRetry) || cfg.jevRetry < 0) {
    throw new Error('JEV_RETRY 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(cfg.jevAdvisorMaxTokens) || cfg.jevAdvisorMaxTokens <= 0) {
    throw new Error('JEV_ADVISOR_MAX_TOKENS 必须是正安全整数');
  }
  if (!Number.isSafeInteger(cfg.pikaCutoff) || cfg.pikaCutoff <= 0) {
    throw new Error('JEV_PIKA_CUTOFF 必须是正安全整数');
  }
  if (!Number.isFinite(cfg.chamdbTtlHours) || cfg.chamdbTtlHours <= 0) {
    throw new Error('JEV_CHAMDB_TTL_HOURS 必须是正数（小时）');
  }
  if (cfg.reviewMaxTokens !== undefined && (!Number.isSafeInteger(cfg.reviewMaxTokens) || cfg.reviewMaxTokens <= 0)) {
    throw new Error('JEV_REVIEW_MAX_TOKENS 必须是正安全整数（留空或仅空白表示不限制）');
  }
  if (cfg.startMode === 'challenge' && !cfg.challengeUser) {
    throw new Error('CHALLENGE_USER is required when START_MODE=challenge');
  }
  if (!['sdk', 'fetch', 'chat'].includes(cfg.jevTransport)) {
    throw new Error(`Invalid JEV_TRANSPORT: ${cfg.jevTransport}`);
  }
  if (!['ladder', 'challenge', 'accept'].includes(cfg.startMode)) {
    throw new Error(`Invalid START_MODE: ${cfg.startMode}`);
  }
}
