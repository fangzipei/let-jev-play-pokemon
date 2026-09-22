import {describe, expect, it} from 'vitest';
import {loadConfig, validateConfig} from '../src/config.js';

const base = {
  OPENROUTER_API_KEY: 'sk-test',
  JEV_MOCK: '0',
} as NodeJS.ProcessEnv;

describe('config', () => {
  it('加载默认值', () => {
    const cfg = loadConfig(base);
    expect(cfg.jevModel).toBe('~typesafe/jev-latest');
    expect(cfg.jevTransport).toBe('sdk');
    expect(cfg.jevTimeoutMs).toBe(20000);
    expect(cfg.psFormat).toBe('gen9championsvgc2026regmc');
    expect(cfg.startMode).toBe('ladder');
    expect(cfg.maxBattles).toBe(1);
    expect(cfg.sendRqid).toBe(true);
    expect(cfg.psUsername).toMatch(/^JevBot\d{4}$/);
  });

  it('JEV_MOCK=1 时不需要 API key', () => {
    const cfg = loadConfig({JEV_MOCK: '1'} as NodeJS.ProcessEnv);
    expect(cfg.jevMock).toBe(true);
  });

  it('缺少 API key 且非 mock 时报错', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/OPENROUTER_API_KEY/);
  });

  it('challenge 模式必须给 CHALLENGE_USER', () => {
    expect(() => validateConfig({
      ...loadConfig(base), startMode: 'challenge', challengeUser: '',
    })).toThrow(/CHALLENGE_USER/);
  });

  it('SEND_RQID=0 关闭 rqid', () => {
    expect(loadConfig({...base, SEND_RQID: '0'}).sendRqid).toBe(false);
  });
});
