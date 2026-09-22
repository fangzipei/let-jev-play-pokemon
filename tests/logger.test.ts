import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createLogger, nullLogger} from '../src/log/logger.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jevlog-'));
}

const silent = {log() {}, warn() {}, error() {}};

describe('createLogger', () => {
  it('写入 protocol 日志（逐行追加）', () => {
    const dir = tmpDir();
    const logger = createLogger({logDir: dir, logLevel: 'info', console: silent});
    logger.protocol('battle-1', '|turn|1');
    logger.protocol('battle-1', '|turn|2');
    const text = fs.readFileSync(path.join(dir, 'battle-1.protocol.log'), 'utf8');
    expect(text).toBe('|turn|1\n|turn|2\n');
  });

  it('决策写入 JSONL（自动补 ts）', () => {
    const dir = tmpDir();
    const logger = createLogger({logDir: dir, logLevel: 'info', console: silent});
    logger.decision('battle-1', {kind: 'turn', fallback: false});
    const lines = fs.readFileSync(path.join(dir, 'battle-1.decisions.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.kind).toBe('turn');
    expect(typeof entry.ts).toBe('string');
  });

  it('控制台级别过滤：warn 级别不打印 info', () => {
    const dir = tmpDir();
    const printed: string[] = [];
    const logger = createLogger({
      logDir: dir,
      logLevel: 'warn',
      console: {
        log: (m: string) => printed.push(`log:${m}`),
        warn: (m: string) => printed.push(`warn:${m}`),
        error: (m: string) => printed.push(`error:${m}`),
      },
    });
    logger.info('hidden');
    logger.warn('shown');
    logger.error('boom');
    expect(printed.length).toBe(2);
    expect(printed[0]).toContain('shown');
    expect(printed[1]).toContain('boom');
  });

  it('nullLogger 全部为 no-op', () => {
    expect(() => nullLogger.protocol('x', '|turn|1')).not.toThrow();
    expect(() => nullLogger.decision('x', {a: 1})).not.toThrow();
    nullLogger.info('x');
    nullLogger.close();
  });
});
