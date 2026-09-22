import 'dotenv/config';

export interface AppConfig {
  openrouterApiKey: string;
  jevModel: string;
  jevTransport: 'sdk' | 'fetch';
  jevTimeoutMs: number;
  jevMock: boolean;
  jevRetry: number;
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
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: {requireApiKey?: boolean} = {},
): AppConfig {
  const cfg: AppConfig = {
    openrouterApiKey: env.OPENROUTER_API_KEY ?? '',
    jevModel: env.JEV_MODEL ?? '~typesafe/jev-latest',
    jevTransport: (env.JEV_TRANSPORT ?? 'sdk') as AppConfig['jevTransport'],
    jevTimeoutMs: Number(env.JEV_TIMEOUT_MS ?? 20000),
    jevMock: env.JEV_MOCK === '1',
    jevRetry: Number(env.JEV_RETRY ?? 1),
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
  };
  validateConfig(cfg, opts);
  return cfg;
}

export function validateConfig(cfg: AppConfig, opts: {requireApiKey?: boolean} = {}): void {
  const requireApiKey = opts.requireApiKey ?? true;
  if (requireApiKey && !cfg.jevMock && !cfg.openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required unless JEV_MOCK=1');
  }
  if (cfg.startMode === 'challenge' && !cfg.challengeUser) {
    throw new Error('CHALLENGE_USER is required when START_MODE=challenge');
  }
  if (!['sdk', 'fetch'].includes(cfg.jevTransport)) {
    throw new Error(`Invalid JEV_TRANSPORT: ${cfg.jevTransport}`);
  }
  if (!['ladder', 'challenge', 'accept'].includes(cfg.startMode)) {
    throw new Error(`Invalid START_MODE: ${cfg.startMode}`);
  }
}
