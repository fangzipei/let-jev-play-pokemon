import {describe, expect, it, vi} from 'vitest';

vi.mock('dotenv/config', () => ({}));
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

  it('上下文与 advisor 使用批准的默认值', () => {
    expect(loadConfig(base)).toMatchObject({
      jevContextLevel: 2,
      jevAdvisorModel: 'google/gemini-3.8-flash',
      jevAdvisorApiKey: 'sk-test',
      jevAdvisorTimeoutMs: 10000,
      jevAdvisorMaxTokens: 2048,
      jevDecisionBudgetMs: 35000,
    });
  });

  it('显式配置覆盖默认值', () => {
    expect(loadConfig({...base,
      JEV_CONTEXT_LEVEL: '3', JEV_ADVISOR_MODEL: 'custom/model',
      JEV_ADVISOR_API_KEY: ' advisor-key ', JEV_ADVISOR_TIMEOUT_MS: '5000',
      JEV_ADVISOR_MAX_TOKENS: '3072',
      JEV_DECISION_BUDGET_MS: '25000',
    })).toMatchObject({
      jevContextLevel: 3, jevAdvisorModel: 'custom/model', jevAdvisorApiKey: 'advisor-key',
      jevAdvisorTimeoutMs: 5000, jevAdvisorMaxTokens: 3072, jevDecisionBudgetMs: 25000,
    });
  });

  it.each(['', ' ', '\t\n'])('空白 advisor key %j 回退主 key', (key) => {
    expect(loadConfig({...base, OPENROUTER_API_KEY: ' main-key ', JEV_ADVISOR_API_KEY: key}))
      .toMatchObject({openrouterApiKey: 'main-key', jevAdvisorApiKey: 'main-key'});
  });

  it('空白主 key 不能通过验证，mock 则可无 key', () => {
    expect(() => loadConfig({...base, OPENROUTER_API_KEY: '  '})).toThrow(/OPENROUTER_API_KEY/);
    expect(loadConfig({JEV_MOCK: '1'}).jevAdvisorApiKey).toBe('');
  });

  it.each(['1', '2', '3'])('允许上下文等级 %s', (level) => {
    expect(loadConfig({...base, JEV_CONTEXT_LEVEL: level}).jevContextLevel).toBe(Number(level));
  });

  it.each(['0', '4', 'NaN', '', '2.5', 'private-invalid-value'])('非法等级 %j 安全告警并回退 L2', (level) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadConfig({...base, JEV_CONTEXT_LEVEL: level}).jevContextLevel).toBe(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('JEV_CONTEXT_LEVEL'));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private-invalid-value');
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['JEV_TIMEOUT_MS', 'JEV_ADVISOR_TIMEOUT_MS', 'JEV_DECISION_BUDGET_MS'])('%s 拒绝无效时间预算', (name) => {
    for (const value of ['0', '-1', 'Infinity', 'NaN', 'abc', '', ' ', '1.5', '2147483648']) {
      expect(() => loadConfig({...base, [name]: value}), `${name}=${value}`).toThrow(name);
    }
  });

  it('JEV_ADVISOR_MAX_TOKENS 须为正安全整数，否则启动拒绝', () => {
    expect(loadConfig({...base, JEV_ADVISOR_MAX_TOKENS: '4096'}).jevAdvisorMaxTokens).toBe(4096);
    for (const value of ['0', '-1', 'NaN', 'Infinity', 'abc', '1.5', '', ' ']) {
      expect(() => loadConfig({...base, JEV_ADVISOR_MAX_TOKENS: value}), `JEV_ADVISOR_MAX_TOKENS=${value}`)
        .toThrow(/JEV_ADVISOR_MAX_TOKENS/);
    }
  });

  it('JEV_ADVISOR_REASONING 仅接受 low/medium/high，未设置或空白则不注入推理参数', () => {
    expect(loadConfig(base).jevAdvisorReasoning).toBeUndefined();
    expect(loadConfig({...base, JEV_ADVISOR_REASONING: '  '}).jevAdvisorReasoning).toBeUndefined();
    for (const value of ['low', 'medium', 'high'] as const) {
      expect(loadConfig({...base, JEV_ADVISOR_REASONING: value}).jevAdvisorReasoning).toBe(value);
      expect(loadConfig({...base, JEV_ADVISOR_REASONING: ` ${value}\t`}).jevAdvisorReasoning).toBe(value);
    }
    for (const value of ['lo', 'LOW', 'none', '0', 'true']) {
      expect(() => loadConfig({...base, JEV_ADVISOR_REASONING: value}), `JEV_ADVISOR_REASONING=${value}`)
        .toThrow(/JEV_ADVISOR_REASONING/);
    }
  });

  it('JEV_TRANSPORT=chat 启用 Chat Completions 决策路径', () => {
    expect(loadConfig({...base, JEV_TRANSPORT: 'chat'}).jevTransport).toBe('chat');
  });

  it('非法 JEV_TRANSPORT 拒绝启动', () => {
    expect(() => loadConfig({...base, JEV_TRANSPORT: 'carrier-pigeon'})).toThrow('JEV_TRANSPORT');
  });

  it('非法重试次数不能造成无限重试', () => {
    for (const value of ['-1', 'Infinity', 'NaN', '1.5']) {
      expect(() => loadConfig({...base, JEV_RETRY: value})).toThrow('JEV_RETRY');
    }
  });
});

describe('Pikalytics 与复盘配置', () => {
  it('默认值', () => {
    expect(loadConfig(base)).toMatchObject({
      pikaEnabled: true, pikaCutoff: 1760, pikaDir: '.cache/pikalytics',
      memoryDir: '.cache/jev-memory', reviewModel: '', reviewApiKey: 'sk-test', reviewMaxTokens: 2048,
    });
  });
  it('显式覆盖与 PIKA_ENABLED=0 关闭', () => {
    expect(loadConfig({...base, JEV_PIKA_ENABLED: '0'}).pikaEnabled).toBe(false);
    expect(loadConfig({...base,
      JEV_PIKA_CUTOFF: '1500', JEV_PIKA_DIR: 'x/y', JEV_MEMORY_DIR: 'm/n',
      JEV_REVIEW_MODEL: 'vendor/model', JEV_REVIEW_API_KEY: ' rk ', JEV_REVIEW_MAX_TOKENS: '512',
    })).toMatchObject({pikaCutoff: 1500, pikaDir: 'x/y', memoryDir: 'm/n', reviewModel: 'vendor/model', reviewApiKey: 'rk', reviewMaxTokens: 512});
  });
  it('非法 cutoff 与 maxTokens 拒绝启动', () => {
    for (const value of ['0', '-5', 'NaN', 'abc', '1.5', '']) {
      expect(() => loadConfig({...base, JEV_PIKA_CUTOFF: value})).toThrow(/JEV_PIKA_CUTOFF/);
    }
    for (const value of ['0', '-1', 'NaN', 'abc', '1.5', '']) {
      expect(() => loadConfig({...base, JEV_REVIEW_MAX_TOKENS: value})).toThrow(/JEV_REVIEW_MAX_TOKENS/);
    }
  });
});
