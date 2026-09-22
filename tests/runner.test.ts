import {describe, expect, it} from 'vitest';
import {loadConfig} from '../src/config.js';
import {nullLogger} from '../src/log/logger.js';
import {runMatch, summarizeBattles} from '../src/match/runner.js';
import type {WsLike} from '../src/ps/connection.js';
import {mkDex} from './helpers.js';

class FakeWs implements WsLike {
  sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }

  open(): void {
    this.emit('open');
  }

  message(data: string): void {
    this.emit('message', data);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const SIMPLE_PASTE = [
  'Golisopod @ Golisopite',
  'Ability: Emergency Exit',
  '- Iron Head',
  '',
  'Tyranitar @ Choice Scarf',
  'Ability: Sand Stream',
  '- Rock Slide',
].join('\n');

const PREVIEW_REQUEST =
  '{"teamPreview":true,"rqid":1,"side":{"name":"JevBot1000","id":"p1","pokemon":[' +
  '{"ident":"p1: Golisopod","details":"Golisopod, L50, M","condition":"150/150","active":false},' +
  '{"ident":"p1: Tyranitar","details":"Tyranitar, L50, M","condition":"175/175","active":false},' +
  '{"ident":"p1: Chandelure","details":"Chandelure, L50, F","condition":"135/135","active":false},' +
  '{"ident":"p1: Excadrill","details":"Excadrill, L50, F","condition":"165/165","active":false},' +
  '{"ident":"p1: Salamence","details":"Salamence, L50, M","condition":"170/170","active":false},' +
  '{"ident":"p1: Rotom-Wash","details":"Rotom-Wash, L50","condition":"135/135","active":false}]}}';

describe('summarizeBattles', () => {
  it('统计胜负与总花费', () => {
    const result = summarizeBattles([
      {battleId: 'b1', won: true, turns: 8, decisions: 8, fallbacks: 0, costUsd: 0.01, finished: true},
      {battleId: 'b2', winner: 'foe', won: false, turns: 10, decisions: 10, fallbacks: 2, costUsd: 0.02, finished: true},
    ]);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.03);
  });
});

describe('runMatch（最小流程）', () => {
  it('登录 → 搜索 → 战斗房间 → team preview 决策 → 胜利汇总', async () => {
    const sockets: FakeWs[] = [];
    const cfg = loadConfig({JEV_MOCK: '1', PS_USERNAME: 'JevBot1000', PS_PASSWORD: '', MAX_BATTLES: '1'});
    const runPromise = runMatch({
      cfg,
      logger: nullLogger,
      dex: mkDex(),
      paste: SIMPLE_PASTE,
      waitBattleTimeoutMs: 3000,
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      fetchImpl: (async () => new Response(']{"assertion":"assert-1"}', {status: 200})) as typeof fetch,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0].open();
    sockets[0].message('|challstr|4|12345\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn JevBot1000,0,')));
    sockets[0].message('|updateuser|JevBot1000|1|1\n');
    await waitFor(() => sockets[0].sent.includes('|/search gen9championsvgc2026regmc'));
    sockets[0].message(
      '>battle-gen9championsvgc2026regmc-1000\n' +
        '|player|p1|JevBot1000|1|1500\n' +
        '|player|p2|foe|2|1500\n' +
        '|teampreview|4\n' +
        `|request|${PREVIEW_REQUEST}\n`,
    );
    await waitFor(() => sockets[0].sent.some(s => s.includes('|/choose team ')));
    expect(sockets[0].sent.some(s => s === 'battle-gen9championsvgc2026regmc-1000|/choose team 123456|1')).toBe(true);
    // 真实服务器发送房间消息时总会带 `>roomid` 头（server/users.ts sendTo），这里保持一致
    sockets[0].message('>battle-gen9championsvgc2026regmc-1000\n|win|JevBot1000\n');
    const result = await runPromise;
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(0);
    expect(result.summaries[0].battleId).toBe('battle-gen9championsvgc2026regmc-1000');
    expect(result.summaries[0].turns).toBe(0);
  });

  it('等待战斗超时抛出可读错误', async () => {
    const sockets: FakeWs[] = [];
    const cfg = loadConfig({JEV_MOCK: '1', PS_USERNAME: 'JevBot2000', PS_PASSWORD: ''});
    const runPromise = runMatch({
      cfg,
      logger: nullLogger,
      dex: mkDex(),
      paste: SIMPLE_PASTE,
      waitBattleTimeoutMs: 400,
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      fetchImpl: (async () => new Response(']{"assertion":"assert-1"}', {status: 200})) as typeof fetch,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0].open();
    sockets[0].message('|challstr|4|999\n');
    await waitFor(() => sockets[0].sent.some(s => s.startsWith('|/trn ')));
    sockets[0].message('|updateuser|JevBot2000|1|1\n');
    await expect(runPromise).rejects.toThrow(/超时/);
  });
});
