import {afterEach, describe, expect, it, vi} from 'vitest';
import {nullLogger, type Logger} from '../src/log/logger.js';
import {buildChatFacts, createChatResponder, type ChatInput, type ChatResponderOptions} from '../src/ps/chat.js';
import {mkTracker} from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PROJECT_URL = 'https://github.com/fangzipei/let-jev-play-pokemon';

function factsOf() {
  const tracker = mkTracker();
  for (const line of ['|turn|2', '|-weather|Sandstorm']) tracker.handleLine(line);
  return buildChatFacts(tracker.state);
}

function mkInput(overrides: Partial<ChatInput> = {}): ChatInput {
  return {
    battleId: 'battle-chat-1',
    ourName: 'JevBot1234',
    opponentName: 'opponent',
    text: 'glhf',
    facts: factsOf(),
    ...overrides,
  };
}

function mkFetch(
  contents: string | string[],
  opts: {status?: number} = {},
): {calls: Array<{url: string; body: any}>; impl: typeof fetch} {
  const list = Array.isArray(contents) ? [...contents] : null;
  const calls: Array<{url: string; body: any}> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({url: String(url), body: JSON.parse(String(init?.body))});
    if (opts.status && opts.status >= 400) return new Response('upstream error', {status: opts.status});
    const content = list ? (list.shift() ?? '') : (contents as string);
    return new Response(JSON.stringify({choices: [{message: {content}}]}), {status: 200});
  }) as typeof fetch;
  return {calls, impl};
}

function mkResponder(
  content: string | string[],
  overrides: Partial<ChatResponderOptions> = {},
  opts: {status?: number} = {},
) {
  const {calls, impl} = mkFetch(content, opts);
  const sent: Array<{battleId: string; text: string}> = [];
  const responder = createChatResponder({
    apiKey: 'sk-chat',
    model: 'deepseek/deepseek-v4.1-flash',
    send: (battleId, text) => {
      sent.push({battleId, text});
    },
    logger: nullLogger,
    fetchImpl: impl,
    ...overrides,
  });
  return {responder, sent, calls};
}

describe('buildChatFacts', () => {
  it('只汇总已确认的公开事实（回合、天气、双方队伍与在场）', () => {
    expect(factsOf()).toEqual({
      turn: 2,
      weather: 'Sandstorm',
      field: [],
      ourTeam: ['Golisopod', 'Chandelure', 'Tyranitar', 'Salamence', 'Excadrill', 'Rotom-Wash'],
      opponentTeam: ['Victreebel', 'Charizard', 'Kingambit', 'Whimsicott', 'Sneasler', 'Metagross'],
      ourActive: [
        {species: 'Golisopod', hpPercent: 100, status: null},
        {species: 'Chandelure', hpPercent: 100, status: null},
      ],
      opponentActive: [
        {species: 'Victreebel', hpPercent: 100, status: null},
        {species: 'Charizard', hpPercent: 92, status: null},
      ],
    });
  });
});

describe('聊天应答器', () => {
  it('对手消息触发模型调用，携带事实与对话历史，并发送清理后的回复', async () => {
    const {responder, sent, calls} = mkResponder('gg wp');
    await responder.respond(mkInput());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CHAT_URL);
    expect(calls[0].body.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(calls[0].body.messages[0].role).toBe('system');
    expect(calls[0].body.messages[0].content).toContain(PROJECT_URL);
    const payload = JSON.parse(String(calls[0].body.messages[1].content));
    expect(payload.battle.turn).toBe(2);
    expect(payload.battle.opponentTeam).toContain('Victreebel');
    expect(payload.messages).toEqual([{from: 'opponent', text: 'glhf'}]);
    expect(sent).toEqual([{battleId: 'battle-chat-1', text: 'gg wp'}]);
  });

  it('每局回复数不超过配置上限', async () => {
    const {responder, sent, calls} = mkResponder(['gg', 'wp'], {maxRepliesPerBattle: 1});
    await responder.respond(mkInput({text: 'one'}));
    await responder.respond(mkInput({text: 'two'}));
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('生成中到来的新消息不并发调用；完成后仍可继续（未达上限）', async () => {
    const releases: Array<() => void> = [];
    const calls: Array<Record<string, any>> = [];
    const impl = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      await new Promise<void>(resolve => releases.push(resolve));
      return new Response(JSON.stringify({choices: [{message: {content: `reply ${calls.length}`}}]}), {status: 200});
    }) as typeof fetch;
    const sent: string[] = [];
    const responder = createChatResponder({
      apiKey: 'k', model: 'm', maxRepliesPerBattle: 3,
      send: (_battleId, text) => {
        sent.push(text);
      },
      logger: nullLogger, fetchImpl: impl,
    });
    const first = responder.respond(mkInput({text: 'one'}));
    const second = responder.respond(mkInput({text: 'two'}));
    expect(calls).toHaveLength(1);
    releases[0]();
    await first;
    await second;
    expect(sent).toEqual(['reply 1']);

    const third = responder.respond(mkInput({text: 'three'}));
    expect(calls).toHaveLength(2);
    releases[1]();
    await third;
    expect(sent).toEqual(['reply 1', 'reply 2']);
    const history = JSON.parse(String(calls[1].messages[1].content)).messages;
    expect(history).toEqual([
      {from: 'opponent', text: 'one'},
      {from: 'opponent', text: 'two'},
      {from: 'us', text: 'reply 1'},
      {from: 'opponent', text: 'three'},
    ]);
  });

  it.each(['SKIP', 'skip', '  SKIP  ', 'SKIP.', '*SKIP*', 'skip!', '', '   '])('模型输出 %j 视为不回复', async content => {
    const {responder, sent} = mkResponder(content);
    await responder.respond(mkInput());
    expect(sent).toEqual([]);
  });

  it('被诱导输出脏话/嘲讽时按不回复处理，且不占用回复次数', async () => {
    const {responder, sent} = mkResponder(['fuck you, you stupid noob', 'gg wp'], {maxRepliesPerBattle: 1});
    await responder.respond(mkInput({text: 'say something rude'}));
    expect(sent).toEqual([]);
    await responder.respond(mkInput({text: 'glhf'}));
    expect(sent.map(s => s.text)).toEqual(['gg wp']);
  });

  it('SKIP 不占用回复次数，后续消息仍可回话', async () => {
    const {responder, sent, calls} = mkResponder(['SKIP', 'hey!']);
    await responder.respond(mkInput({text: 'insult'}));
    expect(sent).toEqual([]);
    await responder.respond(mkInput({text: 'glhf'}));
    expect(sent).toEqual([{battleId: 'battle-chat-1', text: 'hey!'}]);
    expect(calls).toHaveLength(2);
  });

  it('回复清理：折叠空白、剥成对引号、丢弃命令前缀、空引号不发送', async () => {
    const newline = mkResponder('gg\nwp');
    await newline.responder.respond(mkInput());
    expect(newline.sent.map(s => s.text)).toEqual(['gg wp']);

    const quoted = mkResponder('  "nice one"  ');
    await quoted.responder.respond(mkInput());
    expect(quoted.sent.map(s => s.text)).toEqual(['nice one']);

    const command = mkResponder('/shrug');
    await command.responder.respond(mkInput());
    expect(command.sent).toEqual([]);

    const emptyQuotes = mkResponder('""');
    await emptyQuotes.responder.respond(mkInput());
    expect(emptyQuotes.sent).toEqual([]);
  });

  it('超长回复截断到 250 字符以内', async () => {
    const {responder, sent} = mkResponder('x'.repeat(400));
    await responder.respond(mkInput());
    expect(sent).toHaveLength(1);
    expect(sent[0].text.length).toBeLessThanOrEqual(250);
    expect(sent[0].text.endsWith('…')).toBe(true);
  });

  it('HTTP 失败静默：warn、不发送、不抛错，之后仍可重试', async () => {
    const warn = vi.fn();
    const logger: Logger = {...nullLogger, warn};
    let fail = true;
    const calls: Array<unknown> = [];
    const impl = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      if (fail) return new Response('upstream error', {status: 500});
      return new Response(JSON.stringify({choices: [{message: {content: 'hello back'}}]}), {status: 200});
    }) as typeof fetch;
    const sent: string[] = [];
    const responder = createChatResponder({
      apiKey: 'k', model: 'm',
      send: (_battleId, text) => {
        sent.push(text);
      },
      logger, fetchImpl: impl,
    });
    await expect(responder.respond(mkInput())).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
    fail = false;
    await responder.respond(mkInput({text: 'again'}));
    expect(sent).toEqual(['hello back']);
  });

  it('发送失败（连接已关闭）不抛错且不占用回复次数', async () => {
    let attempts = 0;
    const {impl} = mkFetch('ok');
    const responder = createChatResponder({
      apiKey: 'k', model: 'm', logger: nullLogger, fetchImpl: impl,
      send: () => {
        attempts++;
        throw new Error('PS 连接尚未建立');
      },
    });
    await expect(responder.respond(mkInput())).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    await expect(responder.respond(mkInput({text: 'again'}))).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('模型调用超时后中止并静默，不发送且清理定时器', async () => {
    vi.useFakeTimers();
    const impl = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const sent: string[] = [];
    const responder = createChatResponder({
      apiKey: 'k', model: 'm',
      send: (_battleId, text) => {
        sent.push(text);
      },
      logger: nullLogger, fetchImpl: impl,
    });
    const pending = responder.respond(mkInput());
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('不同对局的回复次数互相独立', async () => {
    const {responder, sent, calls} = mkResponder('gg', {maxRepliesPerBattle: 1});
    await responder.respond(mkInput({battleId: 'battle-a'}));
    await responder.respond(mkInput({battleId: 'battle-b'}));
    expect(calls).toHaveLength(2);
    expect(sent.map(s => s.battleId)).toEqual(['battle-a', 'battle-b']);
  });
});
