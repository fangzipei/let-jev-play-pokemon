import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn';

export interface ConsoleSink {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LoggerOptions {
  logDir: string;
  logLevel?: LogLevel;
  /** 控制台输出目标（测试可注入；默认 console） */
  console?: ConsoleSink;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  /** 追加一行原始协议到 logs/<battleId>.protocol.log */
  protocol(battleId: string, line: string): void;
  /** 追加一条决策记录到 logs/<battleId>.decisions.jsonl（自动补 ts 字段） */
  decision(battleId: string, entry: Record<string, unknown>): void;
  close(): void;
}

const LEVELS: Record<string, number> = {debug: 10, info: 20, warn: 30, error: 40};

export function createLogger(opts: LoggerOptions): Logger {
  const min = LEVELS[opts.logLevel ?? 'info'] ?? LEVELS.info;
  const con = opts.console ?? (console as ConsoleSink);
  const stamp = () => new Date().toISOString();
  const filePath = (battleId: string, ext: string) => path.join(opts.logDir, `${battleId}.${ext}`);
  const append = (file: string, text: string) => {
    fs.mkdirSync(opts.logDir, {recursive: true});
    fs.appendFileSync(file, text);
  };
  const emit = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown) => {
    if (LEVELS[level] < min) return;
    const tail = meta === undefined ? '' : ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
    const line = `[${level}] ${stamp()} ${msg}${tail}`;
    if (level === 'error') con.error(line);
    else if (level === 'warn') con.warn(line);
    else con.log(line);
  };
  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    protocol: (battleId, line) => append(filePath(battleId, 'protocol.log'), `${line}\n`),
    decision: (battleId, entry) => append(filePath(battleId, 'decisions.jsonl'), `${JSON.stringify({ts: stamp(), ...entry})}\n`),
    close: () => {},
  };
}

export const nullLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  protocol() {}, decision() {}, close() {},
};
