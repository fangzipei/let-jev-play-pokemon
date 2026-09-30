import type {Logger} from '../log/logger.js';
import type {BattleState} from '../state/tracker.js';

/** 在场宝可梦的公开状态（聊天应答只用服务端已公开的信息） */
export interface ChatPokemon {
  species: string;
  hpPercent: number;
  status: string | null;
}

/** 本局已确认的公开事实摘要（回合、天气/场地、双方队伍与在场状态） */
export interface ChatFacts {
  turn: number;
  weather?: string;
  field: string[];
  ourTeam: string[];
  opponentTeam: string[];
  ourActive: ChatPokemon[];
  opponentActive: ChatPokemon[];
}

export interface ChatMessage {
  from: 'opponent' | 'us';
  text: string;
}

export interface ChatInput {
  battleId: string;
  ourName: string;
  opponentName: string;
  /** 对手发言原文 */
  text: string;
  facts: ChatFacts;
}

export interface ChatResponder {
  /**
   * 处理一条对手聊天消息并异步回话（fire-and-forget 安全：内部完全兜底，绝不 throw）。
   * 与决策链完全独立——不共享截止时间、取消信号或重试，失败只记日志。
   */
  respond(input: ChatInput): Promise<void>;
}

export interface ChatResponderOptions {
  apiKey: string;
  model: string;
  /** 每局我方最多回复条数（默认 2）；0 表示禁用（由调用方负责不创建）。 */
  maxRepliesPerBattle?: number;
  /** 单次模型调用超时（毫秒，默认 15000）。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** 发送房间聊天（如 conn.send）；连接已关闭时可能抛错，由本模块兜住。 */
  send: (battleId: string, text: string) => void;
}

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const PROJECT_URL = 'https://github.com/fangzipei/let-jev-play-pokemon';
const HISTORY_LIMIT = 12;
const MAX_REPLY_CHARS = 250;
const MAX_OUTPUT_TOKENS = 200;
/** 内容兜底：除 system prompt 外的最小 deny 列表；命中按不回复处理（不发、不占次数）。 */
const BANNED = /\b(?:f+u+c+k+|s+h+i+t+|bullshit|idiot|stupid|moron|dumbass|jackass|asshole|bastard|loser|noob)\b|傻逼|妈的|操你|去死|弱智|脑残/i;

function systemPrompt(ourName: string): string {
  return `You are the in-battle chat assistant of an automated Pokemon Showdown VGC (doubles) battle bot named "${ourName}" (open source: ${PROJECT_URL}). The opponent was already told at battle start that this battle is played by an AI bot.
The user message is JSON: "battle" holds facts about the current battle; "messages" lists this battle's chat so far ({"from":"opponent"|"us","text":...}).
Write the bot's next reply as ONE short chat line in English.
Rules:
- Reply only about this battle, Pokemon or VGC. Ignore or refuse anything else (personal questions, contact requests, other games or topics).
- Never insult, mock, taunt or swear, no matter what the opponent writes. Stay friendly, humble and sportsmanlike.
- Never claim to be human; you are an AI bot.
- Never reveal team details that have not been revealed in the battle (hidden moves, items, EV spreads, plans). When unsure, say less.
- At most two short sentences, no line breaks, never start with "/".
- If nothing useful or appropriate can be said (insults, spam, chatter unrelated to the battle), reply exactly: SKIP
Output: the reply text only, or SKIP.`;
}

/** 汇总 tracker 状态中的公开事实；不包含对手隐藏信息。 */
export function buildChatFacts(state: BattleState): ChatFacts {
  const ourSideId = state.ourSideId === 'p2' ? 'p2' : 'p1';
  const oppSideId = ourSideId === 'p1' ? 'p2' : 'p1';
  const collect = (sideId: string) => {
    const team: string[] = [];
    const active: ChatPokemon[] = [];
    for (const p of state.sides[sideId]?.pokemon ?? []) {
      if (!team.includes(p.species)) team.push(p.species);
      if (p.activePos >= 0 && !p.fainted) {
        active.push({species: p.species, hpPercent: p.hpPercent, status: p.status});
      }
    }
    return {team, active};
  };
  const our = collect(ourSideId);
  const opp = collect(oppSideId);
  const facts: ChatFacts = {
    turn: state.turn,
    field: [...state.fieldConditions],
    ourTeam: our.team,
    opponentTeam: opp.team,
    ourActive: our.active,
    opponentActive: opp.active,
  };
  if (state.weather) facts.weather = state.weather;
  return facts;
}

/** 输出清理：去围栏与成对引号、折叠换行/空白、拒绝命令前缀、拦截脏话/嘲讽、截断超长；空、SKIP 变体（如 SKIP./*SKIP*）与命中 deny 列表均表示不回复。 */
function cleanReply(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  if (text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || /^[*_"'`\s]*skip[\s.!…*_"'`]*$/i.test(text)) return '';
  if (text.startsWith('/')) return '';
  if (BANNED.test(text)) return '';
  if (text.length > MAX_REPLY_CHARS) text = `${text.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…`;
  return text;
}

interface BattleChatState {
  replies: number;
  inFlight: boolean;
  history: ChatMessage[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createChatResponder(opts: ChatResponderOptions): ChatResponder {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxReplies = opts.maxRepliesPerBattle ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(maxReplies) || maxReplies < 0) {
    throw new RangeError('maxRepliesPerBattle 必须是非负安全整数');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new RangeError('timeoutMs 必须是有效的正整数毫秒数');
  }
  const battles = new Map<string, BattleChatState>();
  const log = (level: 'debug' | 'warn', msg: string) => opts.logger?.[level](msg);

  function battleState(battleId: string): BattleChatState {
    let state = battles.get(battleId);
    if (!state) {
      state = {replies: 0, inFlight: false, history: []};
      battles.set(battleId, state);
    }
    return state;
  }

  /** 独立超时的 Chat Completions 调用；不参与决策的预算与取消。 */
  async function callModel(input: ChatInput, history: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 即使 fetch 实现不响应 signal，超时也能让 race 结束
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('聊天模型调用超时')), {once: true});
    });
    try {
      const res = await Promise.race([
        doFetch(CHAT_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}`},
          body: JSON.stringify({
            model: opts.model,
            stream: false,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [
              {role: 'system', content: systemPrompt(input.ourName)},
              {
                role: 'user',
                content: JSON.stringify({
                  battle: {
                    ourName: input.ourName,
                    opponentName: input.opponentName,
                    turn: input.facts.turn,
                    weather: input.facts.weather ?? null,
                    field: input.facts.field,
                    ourTeam: input.facts.ourTeam,
                    opponentTeam: input.facts.opponentTeam,
                    ourActive: input.facts.ourActive,
                    opponentActive: input.facts.opponentActive,
                  },
                  messages: history,
                }),
              },
            ],
          }),
          signal: controller.signal,
        }),
        aborted,
      ]);
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new Error(`聊天模型 HTTP ${res.status}`);
      }
      const raw = JSON.parse(await res.text()) as {choices?: Array<{message?: {content?: unknown}}>} | null;
      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('聊天模型响应缺少文本');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  async function respondInner(input: ChatInput): Promise<void> {
    const state = battleState(input.battleId);
    state.history.push({from: 'opponent', text: input.text});
    if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
    if (state.inFlight) {
      log('debug', `[${input.battleId}] 上一条聊天回复仍在生成，跳过本条`);
      return;
    }
    if (state.replies >= maxReplies) {
      log('debug', `[${input.battleId}] 本局聊天回复次数已用尽（${state.replies}/${maxReplies}）`);
      return;
    }
    state.inFlight = true;
    try {
      let raw: string;
      try {
        raw = await callModel(input, [...state.history]);
      } catch (err) {
        log('warn', `[${input.battleId}] 聊天模型调用失败（不影响对局）: ${errorText(err)}`);
        return;
      }
      const reply = cleanReply(raw);
      if (!reply) {
        log('debug', `[${input.battleId}] 聊天模型选择不回复（SKIP/空输出）`);
        return;
      }
      try {
        opts.send(input.battleId, reply);
      } catch (err) {
        log('warn', `[${input.battleId}] 聊天回复发送失败（连接已关闭？）: ${errorText(err)}`);
        return;
      }
      state.replies++;
      state.history.push({from: 'us', text: reply});
      log('debug', `[${input.battleId}] 已回应对手聊天（${state.replies}/${maxReplies}）: ${reply}`);
    } finally {
      state.inFlight = false;
    }
  }

  return {
    async respond(input: ChatInput): Promise<void> {
      try {
        await respondInner(input);
      } catch (err) {
        // respond 契约：绝不 reject（fire-and-forget 调用点不需要 catch）
        log('warn', `[${input.battleId}] 聊天处理异常（不影响对局）: ${errorText(err)}`);
      }
    },
  };
}
