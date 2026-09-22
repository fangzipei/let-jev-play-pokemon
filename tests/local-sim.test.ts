import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {fallbackActions} from '../src/decide/fallback.js';
import type {DexData} from '../src/dex/index.js';
import {buildChooseCommand} from '../src/ps/choose.js';
import {packTeam} from '../src/ps/team.js';
import {parseRequest, type BattleRequest} from '../src/state/request.js';
import {BattleTracker} from '../src/state/tracker.js';
import {mkDex} from './helpers.js';

/**
 * pokemon-showdown 的 BattleStream 是 ObjectReadWriteStream（lib/streams.ts）：
 * write(chunk) 输入指令，next() 异步取出一个输出 chunk（不是 EventEmitter）。
 * 输出 chunk 首行为消息类型，见 sim/battle.ts sendUpdates：update / sideupdate / end。
 */
interface BattleStreamLike {
  write(chunk: string): void | Promise<void>;
  next(): Promise<IteratorResult<string>>;
  /** ObjectReadStream 的待消费队列（lib/streams.ts）；push 均为同步，清空即代表本批输出已消费完 */
  buf: string[];
}

const require = createRequire(import.meta.url);

function loadBattleStream(): new () => BattleStreamLike {
  const pkg = require('pokemon-showdown') as {BattleStream: new () => BattleStreamLike};
  return pkg.BattleStream;
}

/** 优先用真正的 Champions 格式；本地包没有该格式时回退双打自定义对局 */
function pickFormatId(): string {
  try {
    const pkg = require('pokemon-showdown') as {
      Dex?: {formats: {get(id: string): {exists?: boolean}}};
    };
    if (pkg.Dex?.formats.get('gen9championsvgc2026regmc')?.exists) return 'gen9championsvgc2026regmc';
  } catch {
    /* ignore */
  }
  return 'gen9doublescustomgame';
}

const TEAM_P1 = [
  'Golisopod @ Sitrus Berry',
  'Ability: Emergency Exit',
  'Level: 50',
  '- Iron Head',
  '- Drill Run',
  '- Leech Life',
  '- Sucker Punch',
  '',
  'Chandelure @ Leftovers',
  'Ability: Flash Fire',
  'Level: 50',
  '- Shadow Ball',
  '- Heat Wave',
  '- Trick Room',
  '- Protect',
  '',
  'Tyranitar @ Choice Scarf',
  'Ability: Sand Stream',
  'Level: 50',
  '- Rock Slide',
  '- Knock Off',
  '- Ice Punch',
  '- Fire Punch',
  '',
  'Salamence @ Lum Berry',
  'Ability: Intimidate',
  'Level: 50',
  '- Hyper Voice',
  '- Draco Meteor',
  '- Flamethrower',
  '- Protect',
  '',
  'Excadrill @ Focus Sash',
  'Ability: Sand Rush',
  'Level: 50',
  '- Drill Run',
  '- Iron Head',
  '- Rock Slide',
  '- Protect',
  '',
  'Rotom-Wash @ Magnet',
  'Ability: Levitate',
  'Level: 50',
  '- Thunderbolt',
  '- Hydro Pump',
  '- Volt Switch',
  '- Protect',
].join('\n');

const TEAM_P2 = [
  'Charizard @ Leftovers',
  'Ability: Blaze',
  'Level: 50',
  '- Flamethrower',
  '- Brave Bird',
  '',
  'Metagross @ Sitrus Berry',
  'Ability: Clear Body',
  'Level: 50',
  '- Iron Head',
  '- Ice Punch',
  '',
  'Kingambit @ Lum Berry',
  'Ability: Supreme Overlord',
  'Level: 50',
  '- Kowtow Cleave',
  '- Iron Head',
  '',
  'Whimsicott @ Focus Sash',
  'Ability: Prankster',
  'Level: 50',
  '- Tailwind',
  '- Encore',
  '',
  'Sneasler @ Choice Scarf',
  'Ability: Unburden',
  'Level: 50',
  '- Dire Claw',
  '- Iron Head',
  '',
  'Victreebel @ Life Orb',
  'Ability: Chlorophyll',
  'Level: 50',
  '- Sludge Bomb',
  '- Sucker Punch',
].join('\n');

interface LocalBattleResult {
  errors: string[];
  finished: boolean;
  winner?: string;
  requests: number;
  log: string[];
}

/** 在 deadline 内取下一个输出 chunk；超时抛出带上下文的错误 */
async function nextWithDeadline(
  stream: BattleStreamLike,
  deadline: number,
  describe: () => string,
): Promise<IteratorResult<string>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(describe());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stream.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(describe())), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runLocalBattle(input: {
  formatId: string;
  dex: DexData;
  p1Team: string;
  p2Team: string;
  p1Choice: (request: BattleRequest, tracker: BattleTracker) => string | null;
  timeoutMs?: number;
}): Promise<LocalBattleResult> {
  const StreamCtor = loadBattleStream();
  const stream = new StreamCtor();
  const tracker = new BattleTracker('local-sim', 'Player1');
  const out: LocalBattleResult = {errors: [], finished: false, winner: undefined, requests: 0, log: []};
  const timeoutMs = input.timeoutMs ?? 15000;
  const deadline = Date.now() + timeoutMs;
  const timeoutMessage = () =>
    `本地对局未在 ${timeoutMs}ms 内结束（已处理 ${out.requests} 个 request；最近错误: ${out.errors.at(-1) ?? '无'}）`;
  const pending: Array<{slot: string; request: BattleRequest}> = [];

  const feedUpdate = (line: string): void => {
    if (!line) return;
    out.log.push(line);
    if (line.startsWith('|error|')) out.errors.push(line);
    if (line.startsWith('|win|')) {
      out.finished = true;
      out.winner = line.slice('|win|'.length).trim();
    } else if (line.startsWith('|tie|')) {
      out.finished = true;
    }
    tracker.handleLine(line);
  };

  // sim 的 setPlayer 对 team 字符串走 Teams.unpack（sim/battle.ts getTeam），
  // 因此必须传 packed 格式，与真实服务器上传的队伍格式一致
  // 固定 seed：使 p2 的 default 选招/伤害随机数可复现，避免探针用例如随机波动而 flaky
  void stream.write(`>start {"formatid":"${input.formatId}","seed":[1,2,3,4]}`);
  void stream.write(`>player p1 ${JSON.stringify({name: 'Player1', team: packTeam(input.p1Team).packed})}`);
  void stream.write(`>player p2 ${JSON.stringify({name: 'Player2', team: packTeam(input.p2Team).packed})}`);

  while (!out.finished) {
    const step = await nextWithDeadline(stream, deadline, timeoutMessage);
    if (step.done) break;
    const lines = step.value.split('\n');
    switch (lines[0]) {
      case 'update':
        for (const line of lines.slice(1)) feedUpdate(line);
        break;
      case 'sideupdate': {
        const slot = lines[1];
        const payload = lines[2] ?? '';
        if (payload.startsWith('|error|')) {
          out.errors.push(payload);
          break;
        }
        if (!payload.startsWith('|request|')) break;
        const request = parseRequest(payload.slice('|request|'.length));
        if (request && !request.wait) pending.push({slot, request});
        break;
      }
      case 'end': {
        out.finished = true;
        try {
          const logData = JSON.parse(lines.slice(1).join('\n')) as {winner?: string | null};
          if (logData.winner) out.winner = logData.winner;
        } catch {
          /* 无法解析的 end 数据不影响断言 */
        }
        break;
      }
      default:
        break;
    }
    // sim 在同一批输出里先 push sideupdate(request)、再在 write 尾部 push update(日志)：
    // 必须等待消费队列清空（tracker 已消化完本批 |switch| 等行）再决策，
    // 这与真实服务器“房间消息行内先日志后 request”的可观察结果一致。
    if (stream.buf.length !== 0) continue;
    while (pending.length > 0 && !out.finished) {
      const {slot, request: rq} = pending.shift()!;
      if (slot === 'p2') {
        void stream.write('>p2 default');
        continue;
      }
      out.requests++;
      const choice = input.p1Choice(rq, tracker);
      if (choice) void stream.write(`>p1 ${choice}`);
    }
  }
  return out;
}

/** 用本地启发式产生 p1 的 choice 字符串（去掉 /choose 前缀） */
function fallbackChoice(dex: DexData) {
  return (request: BattleRequest, tracker: BattleTracker): string | null => {
    const actions = fallbackActions({dex, request, tracker});
    return buildChooseCommand(actions, {rqid: request.rqid, sendRqid: false}).slice('/choose '.length);
  };
}

describe('local sim 集成', () => {
  it('完整双打对局：不出现 |error| 且正常结束', async () => {
    const dex = mkDex();
    const result = await runLocalBattle({
      formatId: pickFormatId(),
      dex,
      p1Team: TEAM_P1,
      p2Team: TEAM_P2,
      p1Choice: fallbackChoice(dex),
      timeoutMs: 15000,
    });
    expect(result.errors).toEqual([]);
    expect(result.finished).toBe(true);
    expect(result.requests).toBeGreaterThan(1);
  }, 30000);

  it('TARGETSPEC 探针：+1 命中 p2a，-1 指向队友 p1a', async () => {
    const probeDex = mkDex();
    probeDex.moves.helpinghand = {
      name: 'Helping Hand', type: 'Normal', basePower: 0, category: 'Status',
      target: 'adjacentAlly', priority: 5,
    };
    const probeTeamP1 = TEAM_P1.replace(
      '- Shadow Ball\n- Heat Wave\n- Trick Room\n- Protect',
      '- Helping Hand\n- Shadow Ball\n- Heat Wave\n- Protect',
    );
    let firstTurnDone = false;
    const result = await runLocalBattle({
      formatId: pickFormatId(),
      dex: probeDex,
      p1Team: probeTeamP1,
      p2Team: TEAM_P2,
      p1Choice: (request, tracker) => {
        if (!request.teamPreview && !firstTurnDone && (request.active?.length ?? 0) === 2) {
          firstTurnDone = true;
          // 槽位 1：Sucker Punch（第 4 招，先制 +1）指 +1（p2a）——先制保证 p1a 在对手之前出手，
          // 避免慢速的 Golisopod 被 Metagross 的 Iron Head（30% 畏缩）先手打断（seed 固定后曾稳定复现）；
          // 槽位 2：Helping Hand（替换后第 1 招，先制 +5）指 -1（p1a，即队友）
          return 'move 4 +1, move 1 -1';
        }
        return fallbackChoice(probeDex)(request, tracker);
      },
      timeoutMs: 15000,
    });
    expect(result.errors).toEqual([]);
    const diagnostic = `p1a 相关日志: ${result.log.filter(line => line.includes('p1a')).join(' | ') || '(无)'}`;
    const suckerPunchLine = result.log.find(line => line.startsWith('|move|p1a:') && line.includes('|Sucker Punch|'));
    expect(suckerPunchLine, diagnostic).toBeDefined();
    expect(suckerPunchLine).toContain('|p2a:');
    const helpingHandLine = result.log.find(line => line.startsWith('|move|p1b:') && line.includes('|Helping Hand|'));
    expect(helpingHandLine, diagnostic).toBeDefined();
    expect(helpingHandLine).toContain('|p1a:');
  }, 30000);
});
