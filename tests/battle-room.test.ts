import {describe, expect, it} from 'vitest';
import {nullLogger} from '../src/log/logger.js';
import {BattleRoom} from '../src/ps/battle-room.js';
import type {PsConnection} from '../src/ps/connection.js';
import {mkDex, mkRequest} from './helpers.js';

async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function mkHarness(): {room: BattleRoom; sent: string[]} {
  const sent: string[] = [];
  const conn = {
    send: (_battleId: string, command: string) => {
      sent.push(command);
    },
  } as unknown as PsConnection;
  const room = new BattleRoom({
    battleId: 'battle-test-1',
    ourName: 'JevBot1234',
    dex: mkDex(),
    jev: null,
    logger: nullLogger,
    conn,
    cfg: {jevMock: false, sendRqid: true},
  });
  room.handleLine('|player|p1|JevBot1234|1|1500');
  room.handleLine('|player|p2|opponent|2|1500');
  return {room, sent};
}

/** 双槽位强制换人 request（mkRequest 的替补为 teamIndex 3/4） */
function switchRequestLine(rqid: number): string {
  const req = mkRequest();
  req.active = undefined;
  req.forceSwitch = [true, true];
  req.rqid = rqid;
  return `|request|${JSON.stringify(req)}`;
}

describe('BattleRoom 非法指令恢复', () => {
  it('收到 [Invalid choice] 后用本地启发式重发修正指令（同 rqid）', async () => {
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toBe('/choose switch 3, switch 4|9');
    const parts = /\/choose switch (\d), switch (\d)\|9/.exec(sent[0]);
    expect(parts).not.toBeNull();
    expect(parts![1]).not.toBe(parts![2]); // 两个槽位必须是不同替补（服务器拒绝 can only switch in once）

    room.handleLine("|error|[Invalid choice] Can't switch: The Pokémon in slot 3 can only switch in once");
    await waitFor(() => sent.length === 2);
    expect(sent[1]).toBe('/choose switch 3, switch 4|9');

    // 重试次数用尽后发 default，绝不让计时器判负
    room.handleLine("|error|[Invalid choice] Can't switch: The Pokémon in slot 3 can only switch in once");
    await waitFor(() => sent.length === 3);
    expect(sent[2]).toBe('/choose default');
  });

  it('"too late" 错误不触发重发（回合已推进，等新 request）', async () => {
    const {room, sent} = mkHarness();
    room.handleLine(switchRequestLine(9));
    await waitFor(() => sent.length === 1);
    room.handleLine('|error|[Invalid choice] Sorry, too late to make a different move; the next turn has already started');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(sent.length).toBe(1);
  });
});
