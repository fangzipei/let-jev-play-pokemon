import {describe, expect, it} from 'vitest';
import {buildBattleContext, seenInBattle} from '../src/state/battle-context.js';
import type {BattleRequest} from '../src/state/request.js';
import {BattleTracker} from '../src/state/tracker.js';
import {speedControlOf} from '../src/state/speed-control.js';
import {mkRequest, mkTracker} from './helpers.js';

it('导出可调用的纯派生入口', async () => {
  const path = '../src/state/battle-context.js';
  const module = await import(path).catch(() => null);
  expect(module?.buildBattleContext).toBeTypeOf('function');
});

function feed(t: BattleTracker, ...lines: string[]): BattleTracker {
  for (const line of lines) t.handleLine(line);
  return t;
}

function build(t: BattleTracker, request = mkRequest()) {
  return buildBattleContext({state: t.state, request});
}

function member(c: ReturnType<typeof build>, side: 'ours' | 'opponent', ident: string) {
  return c.summary[side].pokemon.find((p: {ident: string}) => p.ident === ident)!;
}

function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  Object.freeze(value);
}

describe('回合窗口与协议事件', () => {
  it.each([
    [{teamPreview: true}, 'team-preview'],
    [{}, 'turn'],
    [{forceSwitch: [false, true]}, 'force-switch'],
    [{forceSwitch: [false, false]}, 'turn'],
    [{wait: true}, 'wait'],
    [{wait: true, forceSwitch: [true]}, 'wait'],
  ] as [Partial<BattleRequest>, string][])('阶段 %j', (partial, phase) => {
    const c = build(mkTracker(), mkRequest(partial));
    expect(c).toMatchObject({battle_id: 'battle-gen9championsvgc2026regmc-1', turn: 1, phase});
  });

  it('三个完整回合加空当前回合，不被空回合挤掉第三个完整回合', () => {
    const t = mkTracker();
    for (let turn = 1; turn <= 5; turn++) {
      if (turn > 1) t.handleLine(`|turn|${turn}`);
      if (turn < 5) t.handleLine('|move|p1a: Golisopod|Protect|p1a: Golisopod');
    }
    const c = build(t);
    expect(c.recent_turns).toEqual([2, 3, 4, 5].map(turn => ({
      turn, status: turn === 5 ? 'in_progress' : 'completed',
      events: turn === 5 ? [] : ['|move|p1a: Golisopod|Protect|p1a: Golisopod'], truncated: false,
    })));
    expect(c.history_truncated).toBe(true);
  });

  it('首发 setup 只在开局与 T1 保留，不当作完整回合', () => {
    const t = mkTracker();
    const c = build(t);
    expect(c.recent_turns).toHaveLength(2);
    expect(c.recent_turns[0]).toMatchObject({turn: 0, status: 'setup', truncated: false});
    expect(c.recent_turns[0].events).toContain('|switch|p1a: Golisopod|Golisopod, L50, M|150/150');
    expect(c.recent_turns[1]).toEqual({turn: 1, status: 'in_progress', events: [], truncated: false});
    t.handleLine('|turn|2');
    expect(build(t).recent_turns[0]).toMatchObject({turn: 1, status: 'completed'});
    expect(build(t).recent_turns).toHaveLength(2);
  });

  it('重试、重复同回合标记、强制换人和 upkeep 不推进回合', () => {
    const t = feed(mkTracker(), '|move|p1a: Golisopod|Protect|p1a: Golisopod', '|upkeep', '|turn|1');
    const req = mkRequest({forceSwitch: [true, false]});
    const before = build(t, req);
    expect(build(t, {...req, rqid: 900})).toEqual(before);
    expect(before.recent_turns.at(-1)).toMatchObject({turn: 1, status: 'in_progress'});
    t.handleLine('|switch|p1a: Tyranitar|Tyranitar, L50|175/175');
    const after = build(t, req);
    expect(after.turn).toBe(1);
    expect(after.recent_turns.at(-1)!.events).toHaveLength(2);
    expect(after.recent_turns.at(-1)!.events[1]).toContain('|switch|');
  });

  it('原样保留双方动作、明确目标与独立结算，不推断伤害来源', () => {
    const events = [
      '|move|p1a: Golisopod|Rock Slide|p2a: Victreebel|[spread] p2a,p2b',
      '|-damage|p2b: Charizard|62/100',
      '|-damage|p1a: Golisopod|135/150|[from] item: Life Orb',
      '|move|p2a: Victreebel|Sleep Powder|p1b: Chandelure|[miss]',
      '|-miss|p2a: Victreebel|p1b: Chandelure',
      '|cant|p1b: Chandelure|par',
      '|-fail|p1b: Chandelure|move: Protect',
      '|-immune|p2b: Charizard|[from] ability: Levitate',
      '|-status|p2a: Victreebel|brn',
      '|-curestatus|p2a: Victreebel|brn',
      '|-heal|p2a: Victreebel|100/100|[from] item: Sitrus Berry',
      '|-sethp|p1a: Golisopod|50/150|p2a: Victreebel|50/100|[from] move: Pain Split',
      '|detailschange|p2b: Charizard|Charizard-Mega-Y, L50',
      '|-mega|p2b: Charizard|Charizard|Charizardite Y',
      '|-ability|p2b: Charizard|Drought',
      '|-enditem|p2a: Victreebel|Sitrus Berry|[eat]',
      '|-weather|SunnyDay|[from] ability: Drought|[of] p2b: Charizard',
      '|-fieldstart|move: Trick Room',
      '|-fieldend|move: Trick Room',
      '|-sidestart|p2: PrivatePlayer|move: Tailwind',
      '|-sideend|p2: PrivatePlayer|move: Tailwind',
      '|-start|p2a: Victreebel|move: Taunt',
      '|-end|p2a: Victreebel|move: Taunt',
      '|-singleturn|p1a: Golisopod|Protect',
      '|-activate|p1a: Golisopod|move: Protect',
      '|-boost|p1a: Golisopod|spe|1',
      '|-unboost|p1a: Golisopod|spe|1',
      '|-damage|p2a: Victreebel|0 fnt|[from] brn',
      '|faint|p2a: Victreebel',
      '|drag|p2a: Kingambit|Kingambit, L50|100/100',
      '|replace|p2a: Kingambit|Kingambit, L50|100/100',
    ];
    const c = build(feed(mkTracker(), ...events));
    expect(c.recent_turns.at(-1)!.events).toEqual(events.map(e => e.replace('p2: PrivatePlayer', 'p2')));
    expect(c.history_note).toMatch(/协议事件/);
    expect(c.history_note).toMatch(/不保证成功/);
    expect(c.history_note).toMatch(/state.*权威/);
    expect(c.history_note).toMatch(/先制/);
    expect(c.history_note).toMatch(/不保证未来先手/);
  });

  it('保留合法的 Trace/boost 特性事件和束缚结算，不放行未知第三参数', () => {
    const events = [
      '|-ability|p1b: Chandelure|Chlorophyll|Trace|[from] ability: Trace|[of] p2a: Victreebel',
      '|-ability|p2a: Victreebel|Competitive|boost',
      '|-damage|p2a: Victreebel|80/100|[from] move: Fire Spin|[partiallytrapped]',
      '|-end|p2a: Victreebel|move: Fire Spin|[partiallytrapped]|[silent]',
    ];
    const t = feed(mkTracker(), ...events);
    t.state.log.push('|-ability|p2a: Victreebel|Chlorophyll|INJECT');
    const c = build(t);
    expect(c.recent_turns.at(-1)!.events).toEqual(events);
    expect(JSON.stringify(c.recent_turns)).not.toContain('INJECT');
  });

  it('严格拒绝噪声、未知事件及伪装成战斗事件的跨行或额外字段注入', () => {
    const t = mkTracker();
    t.state.log.push(
      '|request|{"secret":"INJECT"}', '|c|evil|INJECT', '|chat|evil|INJECT',
      '|html|INJECT', '|raw|INJECT', '|error|INJECT', '|inactive|INJECT',
      '|timer|INJECT', '|win|INJECT', '|player|p2|INJECT', '|-message|INJECT',
      '|unknown|INJECT', '/choose INJECT', '|choice|INJECT',
      '|move|p1a: Golisopod|Protect|p1a: Golisopod\n|c|evil|INJECT',
      '|move|p1a: Golisopod|Protect|p1a: Golisopod|request|INJECT',
      '|move|p1a: Golisopod|Protect|p1a: Golisopod|[unknown] INJECT',
      '|-sidestart|p2: INJECT|move: Tailwind',
    );
    const c = build(t);
    expect(JSON.stringify(c.recent_turns)).not.toContain('INJECT');
    expect(c.recent_turns.at(-1)!.events).toEqual(['|-sidestart|p2|move: Tailwind']);
  });

  it('单事件 240 字符且显式标注截断，每回合不超过 48 条', () => {
    const t = mkTracker();
    t.state.log.push(`|move|p1a: ${'长'.repeat(500)}|Protect|p1a: Golisopod`);
    for (let n = 0; n < 60; n++) t.state.log.push('|-damage|p2b: Charizard|92/100');
    const c = build(t);
    const row = c.recent_turns.at(-1)!;
    expect(row.events).toHaveLength(48);
    expect(row.events[0].length).toBeLessThanOrEqual(240);
    expect(row.events[0]).toMatch(/\[truncated\]$/);
    expect(row.truncated).toBe(true);
    expect(c.history_truncated).toBe(true);
    expect(c.history_note).toMatch(/裁剪|截断/);
  });

  it('总事件约 8000 字符，含 JSON 转义、结构及备注的历史不超过 10000', () => {
    const t = new BattleTracker('battle-budget', 'us');
    for (let turn = 1; turn <= 4; turn++) {
      t.handleLine(`|turn|${turn}`);
      for (let i = 0; i < 48; i++) t.state.log.push(`|move|p1a: ${'"'.repeat(180)}|Protect|p1a: X`);
    }
    const c = build(t);
    const {recent_turns, history_note, history_truncated} = c;
    expect(recent_turns).toHaveLength(4);
    expect(recent_turns.flatMap((r: {events: string[]}) => r.events).join('').length).toBeLessThanOrEqual(8000);
    expect(JSON.stringify({recent_turns, history_note, history_truncated}).length).toBeLessThanOrEqual(10000);
    expect(history_truncated).toBe(true);
    for (const row of recent_turns) {
      expect(row.events.length).toBeLessThanOrEqual(48);
      for (const event of row.events) expect(event.length).toBeLessThanOrEqual(240);
    }
  });

  it('日志开头截断时丢弃无边界片段，不假装它是 setup 或完整回合', () => {
    const t = mkTracker();
    t.state.turn = 9;
    t.state.log = ['|-damage|p2b: Charizard|1/100', '|turn|8', '|cant|p2b: Charizard|par', '|turn|9'];
    const c = build(t);
    expect(c.recent_turns).toEqual([
      {turn: 8, status: 'completed', events: ['|cant|p2b: Charizard|par'], truncated: false},
      {turn: 9, status: 'in_progress', events: [], truncated: false},
    ]);
    expect(c.history_truncated).toBe(true);
    expect(c.history_note).toMatch(/边界|缺失/);
  });

  it('回合标记跳号或当前标记缺失时宁缺，不错误归属事件', () => {
    const t = mkTracker();
    t.state.turn = 4;
    t.state.log = ['|turn|1', '|move|p1a: Golisopod|Protect|p1a: Golisopod', '|turn|3', '|turn|4'];
    expect(build(t).recent_turns).toEqual([
      {turn: 3, status: 'completed', events: [], truncated: false},
      {turn: 4, status: 'in_progress', events: [], truncated: false},
    ]);
    expect(build(t).history_truncated).toBe(true);
    t.state.log = ['|turn|3', '|cant|p2b: Charizard|par'];
    expect(build(t).recent_turns).toEqual([]);
    expect(build(t).history_truncated).toBe(true);
  });

  it('缺失近期回合不能用窗口之外的老回合补足三个名额', () => {
    const t = new BattleTracker('battle-gap', 'us');
    feed(t, '|turn|1', '|turn|2', '|turn|3', '|turn|6', '|turn|7', '|turn|8');
    const c = build(t);
    expect(c.recent_turns.map(r => r.turn)).toEqual([6, 7, 8]);
    expect(c.history_truncated).toBe(true);
  });

  it('乱序回合标记的片段不混入旧回合或生成重复完整回合', () => {
    const t = new BattleTracker('battle-backwards', 'us');
    t.state.turn = 3;
    t.state.log = ['|turn|1', '|cant|p1a: A|par', '|turn|2', '|turn|1',
      '|cant|p1a: STALE|par', '|turn|2', '|cant|p1a: B|par', '|turn|3'];
    const c = build(t);
    expect(c.recent_turns.map(r => r.turn)).toEqual([1, 2, 3]);
    expect(JSON.stringify(c.recent_turns)).not.toContain('STALE');
    expect(c.history_truncated).toBe(true);
  });

  it('缺 start 的开局片段宁缺、坏回合标记后事件也不误归属', () => {
    const t = new BattleTracker('battle-no-start', 'us');
    t.state.turn = 1;
    t.state.log = ['|switch|p1a: A|Pikachu|100/100', '|turn|1'];
    expect(build(t).recent_turns).toEqual([{turn: 1, status: 'in_progress', events: [], truncated: false}]);
    expect(build(t).history_truncated).toBe(true);
    t.state.log = ['|turn|1', '|turn|bad', '|cant|p1a: A|par'];
    expect(build(t).recent_turns).toEqual([]);
  });

  it('清洗不可见控制字符，拒绝 HTML 与嵌在事件内的命令', () => {
    const t = mkTracker();
    t.state.log.push('|move|p1a: Goli\u202esopod|Protect|p1a: Golisopod',
      '|move|p1a: /choose BAD|Protect|p1a: Golisopod',
      '|move|p1a: Golisopod|Protect|p1a: Golisopod|[from] <script>BAD</script>');
    expect(build(t).recent_turns.at(-1)!.events).toEqual(['|move|p1a: Golisopod|Protect|p1a: Golisopod']);
  });

  it('没有历史就返回空列表，不根据 state 回合号补造', () => {
    const t = new BattleTracker('battle-empty', 'us');
    expect(build(t).recent_turns).toEqual([]);
    t.state.turn = 12;
    expect(build(t).recent_turns).toEqual([]);
    expect(build(t).history_note).toMatch(/没有.*历史/);
  });
});

describe('累计摘要与快照', () => {
  it('我方只从当前 request 取参赛名单、HP、道具及 PP 资源', () => {
    const req = mkRequest();
    req.side.pokemon[0].condition = '30/150 brn';
    req.side.pokemon[0].item = '';
    req.side.pokemon[2].condition = '0 fnt';
    const c = build(mkTracker(), req);
    expect(c.summary.ours.roster_source).toBe('request-brought');
    expect(c.summary.ours.pokemon).toHaveLength(4);
    expect(c.summary.ours.brought_count).toEqual({known: 4, confirmed: 4, unknown: false});
    expect(c.summary.ours.remaining_count).toEqual({known: 3, confirmed: 3, unknown: false});
    expect(member(c, 'ours', 'p1: Golisopod')).toMatchObject({
      hp: {current: 30, max: 150, percent: 20, source: 'request'},
      status: 'brn', item: null, item_known: true, participation: 'confirmed',
      known_moves: req.side.pokemon[0].moves,
    });
    expect(c.summary.ours.active_resources[0]).toMatchObject({
      ident: 'p1: Golisopod', can_mega_evo: true,
      moves: [{id: 'ironhead', move: 'Iron Head', pp: 15, maxpp: 15}, {}, {}, {}],
    });
  });

  it('双方换下的成员不携带已经失效的强化等级，场上等级仍保留', () => {
    const t = feed(mkTracker(), '|-boost|p1a: Golisopod|atk|2', '|-boost|p2a: Victreebel|spa|2',
      '|switch|p1a: Tyranitar|Tyranitar, L50|175/175',
      '|switch|p2a: Kingambit|Kingambit, L50|100/100', '|-boost|p2a: Kingambit|atk|1');
    const req = mkRequest();
    req.side.pokemon[0].active = false;
    req.side.pokemon[2].active = true;
    const c = build(t, req);
    expect(member(c, 'ours', 'p1: Golisopod').boosts).toEqual({});
    expect(member(c, 'opponent', 'p2: Victreebel').boosts).toEqual({});
    expect(member(c, 'opponent', 'p2: Kingambit').boosts).toEqual({atk: 1});
  });

  it('我方 preview 六只不叫选出；对手预览和默认 teamsize 不计算精确剩余', () => {
    const t = new BattleTracker('battle-preview', 'us');
    const req = mkRequest({teamPreview: true});
    req.side.pokemon.push(
      {...req.side.pokemon[0], ident: 'p1: Excadrill', active: false},
      {...req.side.pokemon[1], ident: 'p1: Rotom', active: false},
    );
    for (const p of req.side.pokemon) p.active = false;
    for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) t.handleLine(`|poke|p2|${name}, L50|`);
    t.handleLine('|teamsize|p2|6');
    const c = build(t, req);
    expect(c.summary.ours.roster_source).toBe('request-preview');
    expect(c.summary.ours.brought_count).toEqual({known: 0, confirmed: null, unknown: true});
    expect(c.summary.opponent.brought_count).toEqual({known: 0, confirmed: null, unknown: true});
    expect(c.summary.opponent.remaining_count).toEqual({known: 0, confirmed: null, unknown: true});
    expect(c.summary.opponent.reported_team_size).toBe(6);
    expect(c.summary.opponent.pokemon[0]).toMatchObject({participation: 'unknown', hp: null});
    const fresh = build(new BattleTracker('battle-default', 'us'));
    expect(fresh.summary.opponent.reported_team_size).toBeNull();
    expect(fresh.summary.opponent.remaining_count.confirmed).toBeNull();
  });

  it('对手只确认出现/倒下下界，服务端 reported teamsize 独立于 brought', () => {
    const t = feed(mkTracker(), '|faint|p2a: Victreebel');
    const c = build(t);
    expect(c.summary.opponent.reported_team_size).toBe(4);
    expect(c.summary.opponent.brought_count).toEqual({known: 2, confirmed: null, unknown: true});
    expect(c.summary.opponent.remaining_count).toEqual({known: 1, confirmed: null, unknown: true});
    expect(c.summary.opponent.fainted_count).toBe(1);
  });

  it('整局揭示/道具终止/Mega/倒下及满血换下，不随 5000 行日志裁剪失忆', () => {
    const t = feed(mkTracker(),
      '|-ability|p2a: Victreebel|Chlorophyll', '|-ability|p2a: Victreebel|Insomnia',
      '|move|p2a: Victreebel|Sleep Powder|p1b: Chandelure',
      '|-item|p2a: Victreebel|Focus Sash', '|-enditem|p2a: Victreebel|Focus Sash',
      '|-item|p2a: Victreebel|Sitrus Berry', '|-enditem|p2a: Victreebel|Sitrus Berry',
      '|-mega|p2a: Victreebel|Victreebel|Victreebelite', '|faint|p2a: Victreebel',
      '|switch|p2a: Whimsicott|Whimsicott, L50|100/100',
      '|switch|p2a: Kingambit|Kingambit, L50|100/100',
    );
    for (let i = 0; i < 5100; i++) t.handleLine('|c|noise|ignored');
    feed(t, '|turn|8', '|turn|9', '|turn|10', '|turn|11');
    expect(t.state.log.length).toBeLessThanOrEqual(5000);
    expect(t.state.log.some(l => l.includes('|Sleep Powder|'))).toBe(false);
    const c = build(t);
    expect(member(c, 'opponent', 'p2: Victreebel')).toMatchObject({
      revealed_moves: ['Sleep Powder'], revealed_items: ['Focus Sash', 'Sitrus Berry', 'Victreebelite'],
      ended_items: ['Focus Sash', 'Sitrus Berry'], revealed_abilities: ['Chlorophyll', 'Insomnia'],
      consumed_item: true, mega: true, fainted: true, seen_in_battle: true,
    });
    expect(member(c, 'opponent', 'p2: Whimsicott')).toMatchObject({
      seen_in_battle: true, participation: 'confirmed', active: false, hp: {percent: 100},
    });
    expect(c.summary.opponent.seen_count).toBe(4);
    expect(c.summary.opponent.mega_used).toBe(true);
    expect(c.history_truncated).toBe(true);
  });

  it('显式来源揭示跨日志裁剪保留，不把来源特性记在被伤害者身上', () => {
    const t = feed(mkTracker(),
      '|-weather|SunnyDay|[from] ability: Drought|[of] p2b: Charizard',
      '|-damage|p1a: Golisopod|140/150|[from] ability: Rough Skin|[of] p2a: Victreebel',
      '|-heal|p2a: Victreebel|100/100|[from] item: Leftovers',
    );
    t.state.log = ['|turn|7'];
    t.state.turn = 7;
    const c = build(t);
    expect(member(c, 'opponent', 'p2: Charizard').revealed_abilities).toContain('Drought');
    expect(member(c, 'opponent', 'p2: Victreebel').revealed_abilities).toContain('Rough Skin');
    expect(member(c, 'opponent', 'p2: Victreebel').revealed_items).toContain('Leftovers');
    expect(member(c, 'ours', 'p1: Golisopod').revealed_abilities).not.toContain('Rough Skin');
  });

  it('重新获得道具后当前消耗标记可清除，但终止道具记录不丢失', () => {
    const t = feed(mkTracker(), '|-enditem|p2a: Victreebel|Sitrus Berry|[eat]',
      '|-item|p2a: Victreebel|Leftovers');
    expect(member(build(t), 'opponent', 'p2: Victreebel')).toMatchObject({
      item: 'Leftovers', consumed_item: false, ended_items: ['Sitrus Berry'],
      revealed_items: ['Sitrus Berry', 'Leftovers'],
    });
  });

  it('可复用参战判定覆盖第零回合满血换下，而不把 preview 候选算成参战', () => {
    const t = feed(mkTracker(), '|switch|p2a: Whimsicott|Whimsicott, L50|100/100');
    const old = t.findPokemon('p2', 'Victreebel')!;
    expect(old.switchInTurn).toBe(0);
    expect(seenInBattle(old)).toBe(true);
    expect(seenInBattle(t.findPokemon('p2', 'Metagross')!)).toBe(false);
  });

  it('预览前 wait 不确认参赛名单，非法 teamsize 不混入显式来源', () => {
    const t = new BattleTracker('battle-wait', 'us');
    const req = mkRequest({wait: true, active: undefined});
    for (const p of req.side.pokemon) p.active = false;
    feed(t, '|teamsize|p2|bad', '|teamsize|p2|0', '|teamsize|p2|-1');
    expect(build(t, req).summary.ours.brought_count.confirmed).toBeNull();
    expect(build(t, req).summary.opponent.reported_team_size).toBeNull();
  });

  it('同名跨 p1/p2 隔离，request 确定我方阵营', () => {
    const t = feed(new BattleTracker('battle-names', 'us'),
      '|switch|p1a: Same|Pikachu, L50|100/100', '|switch|p2a: Same|Raichu, L50|100/100',
      '|turn|1', '|move|p1a: Same|Thunderbolt|p2a: Same', '|move|p2a: Same|Fake Out|p1a: Same',
    );
    const req = mkRequest({side: {id: 'p2', name: 'us', pokemon: [
      {ident: 'p2: Same', details: 'Raichu, L50', condition: '50/100', active: true},
    ]}});
    const c = build(t, req);
    expect(c.summary.ours.side_id).toBe('p2');
    expect(member(c, 'ours', 'p2: Same').revealed_moves).toEqual(['Fake Out']);
    expect(member(c, 'opponent', 'p1: Same').revealed_moves).toEqual(['Thunderbolt']);
  });

  it('场地及控速从当前累计 state 派生，不从近邻事件重算', () => {
    const t = feed(mkTracker(), '|turn|3', '|-sidestart|p1: us|move: Tailwind',
      '|-fieldstart|move: Trick Room', '|-weather|SunnyDay', '|turn|4');
    const c = build(t);
    expect(c.summary.field).toMatchObject({
      weather: 'SunnyDay', conditions: ['move: Trick Room'], speed_control: speedControlOf(t.state, 'p1'),
    });
    expect(c.summary.ours.side_conditions).toEqual(['move: Tailwind']);
  });

  it('纯读取被冻结输入，结果 JSON 往返等价，输出与后续 tracker 不互相别名', () => {
    const t = mkTracker();
    const req = mkRequest();
    const stateBefore = JSON.stringify(t.state);
    const requestBefore = JSON.stringify(req);
    const c = build(t, req);
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    c.summary.ours.pokemon[0].known_moves.push('output-only');
    c.summary.ours.active_resources[0].moves[0].pp = -10;
    c.summary.field.conditions.push('output-only');
    c.recent_turns[0].events.push('output-only');
    expect(JSON.stringify(t.state)).toBe(stateBefore);
    expect(JSON.stringify(req)).toBe(requestBefore);
    const snapshot = build(t, req);
    const frozenResult = JSON.stringify(snapshot);
    feed(t, '|-damage|p2b: Charizard|1/100', '|move|p2b: Charizard|Heat Wave|p1a: Golisopod');
    req.side.pokemon[0].condition = '0 fnt';
    expect(JSON.stringify(snapshot)).toBe(frozenResult);
    freeze(t.state);
    freeze(req);
    expect(() => build(t, req)).not.toThrow();
  });

  it('不同房间、乃至相同 id 的不同 tracker 实例均不共享历史或摘要', () => {
    const a = feed(new BattleTracker('same-id', 'us'), '|turn|1', '|switch|p2a: A|Pikachu|100/100');
    const b = new BattleTracker('same-id', 'us');
    build(a);
    expect(build(b).recent_turns).toEqual([]);
    expect(build(b).summary.opponent.pokemon).toEqual([]);
  });
});

describe('turn_outcomes 累计结果记录', () => {
  it('记录群攻被广域防守完全挡下的实际结果', () => {
    const t = feed(mkTracker(),
      '|move|p2b: Charizard|Wide Guard|p2b: Charizard',
      '|-singleturn|p2b: Charizard|Wide Guard',
      '|move|p1b: Chandelure|Heat Wave|p2a: Victreebel|[spread] p2a,p2b',
      '|-activate|p2a: Victreebel|move: Wide Guard',
      '|-activate|p2b: Charizard|move: Wide Guard',
    );
    const c = build(t);
    expect(c.turn_outcomes).toEqual([
      'T1 our Chandelure Heat Wave: blocked by foe Wide Guard (protected: Victreebel, Charizard)',
    ]);
    expect(c.turn_outcomes_truncated).toBe(false);
  });

  it('记录单目标被 Protect 挡下与对手无法行动', () => {
    const t = feed(mkTracker(),
      '|move|p2a: Victreebel|Protect|p2a: Victreebel',
      '|move|p1a: Golisopod|Iron Head|p2a: Victreebel',
      '|-activate|p2a: Victreebel|move: Protect',
      '|cant|p2b: Charizard|flinch',
    );
    expect(build(t).turn_outcomes).toEqual([
      'T1 our Golisopod Iron Head: blocked by foe Protect (protected: Victreebel)',
      'T1 foe Charizard could not act (flinch)',
    ]);
  });

  it('记录命中伤害净变化并在击倒时折叠，多段伤害合并', () => {
    const t = feed(mkTracker(),
      '|move|p1b: Chandelure|Heat Wave|p2a: Victreebel|[spread] p2a,p2b',
      '|-damage|p2a: Victreebel|62/100',
      '|-damage|p2a: Victreebel|24/100',
      '|-damage|p2b: Charizard|0 fnt',
      '|faint|p2b: Charizard',
    );
    expect(build(t).turn_outcomes).toEqual([
      'T1 our Chandelure Heat Wave: hit foe Victreebel (100→24), hit foe Charizard (92→0), knocked out',
    ]);
  });

  it('记录未命中、免疫与招式失败', () => {
    const t = feed(mkTracker(),
      '|move|p1a: Golisopod|Drill Run|p2b: Charizard|[miss]',
      '|-miss|p1a: Golisopod|p2b: Charizard',
      '|move|p1a: Golisopod|Iron Head|p2b: Charizard',
      '|-immune|p2b: Charizard',
      '|move|p1a: Golisopod|Protect||[still]',
      '|-fail|p1a: Golisopod',
    );
    expect(build(t).turn_outcomes).toEqual([
      'T1 our Golisopod Drill Run: missed foe Charizard',
      'T1 our Golisopod Iron Head: no effect on foe Charizard (immune)',
      'T1 our Golisopod Protect: move failed',
    ]);
  });

  it('双方结果按 our/foe 归属，窗口外外部伤害与回血不产生记录只调整基线', () => {
    const t = feed(mkTracker(),
      '|-damage|p2a: Victreebel|40/100',
      '|-heal|p2a: Victreebel|70/100|[from] item: Leftovers',
      '|move|p2a: Victreebel|Sludge Bomb|p1b: Chandelure',
      '|-damage|p1b: Chandelure|75/135',
      '|move|p1b: Chandelure|Shadow Ball|p2a: Victreebel',
      '|-damage|p2a: Victreebel|30/100',
    );
    expect(build(t).turn_outcomes).toEqual([
      'T1 foe Victreebel Sludge Bomb: hit our Chandelure (135→75)',
      'T1 our Chandelure Shadow Ball: hit foe Victreebel (70→30)',
    ]);
  });

  it('窗口外的击倒（如异常状态结算）独立记录，孤立伤害不冒充招式结果', () => {
    const t = feed(mkTracker(),
      '|-damage|p2a: Victreebel|40/100',
      '|-damage|p2b: Charizard|0 fnt|[from] brn',
      '|faint|p2b: Charizard',
    );
    expect(build(t).turn_outcomes).toEqual(['T1 foe Charizard knocked out']);
  });

  it('对象没有 HP 基线时不编造伤害数字', () => {
    const t = new BattleTracker('battle-no-baseline', 'us');
    t.state.turn = 1;
    t.state.log = ['|turn|1', '|move|p1a: Golisopod|Iron Head|p9a: Mystery', '|-damage|p9a: Mystery|50/100'];
    expect(build(t).turn_outcomes).toEqual(['T1 our Golisopod Iron Head: hit foe Mystery']);
  });

  it('turn_outcomes 超预算时从最早截断并标记', () => {
    const t = new BattleTracker('battle-outcome-budget', 'us');
    t.state.turn = 80;
    const log: string[] = [];
    for (let turn = 1; turn <= 80; turn++) {
      log.push(`|turn|${turn}`, '|switch|p2a: Victreebel|Victreebel, L50|100/100',
        '|move|p1a: Golisopod|Iron Head|p2a: Victreebel', '|-damage|p2a: Victreebel|50/100');
    }
    t.state.log = log;
    const c = build(t);
    expect(JSON.stringify(c.turn_outcomes).length).toBeLessThanOrEqual(4000);
    expect(c.turn_outcomes_truncated).toBe(true);
    expect(c.turn_outcomes.at(-1)).toBe('T80 our Golisopod Iron Head: hit foe Victreebel (100→50)');
    expect(c.turn_outcomes[0]).not.toMatch(/^T1 /);
  });

  it('回合标记无效时跳过无法归属的记录并标记截断', () => {
    const t = new BattleTracker('battle-outcome-badmarker', 'us');
    t.state.turn = 2;
    t.state.log = ['|turn|bad', '|move|p1a: Golisopod|Iron Head|p2a: Victory', '|-damage|p2a: Victory|50/100'];
    const c = build(t);
    expect(c.turn_outcomes).toEqual([]);
    expect(c.turn_outcomes_truncated).toBe(true);
  });

  it('tracker 日志裁剪时标记结果记录不完整', () => {
    const t = feed(mkTracker(), '|move|p1a: Golisopod|Iron Head|p2a: Victreebel', '|-damage|p2a: Victreebel|50/100');
    t.state.logTruncated = true;
    const c = build(t);
    expect(c.turn_outcomes).toEqual(['T1 our Golisopod Iron Head: hit foe Victreebel (100→50)']);
    expect(c.turn_outcomes_truncated).toBe(true);
  });

  it('注入与非法行不进入 turn_outcomes', () => {
    const t = mkTracker();
    t.state.log.push(
      '|move|p1a: /choose BAD|Iron Head|p2a: Victreebel',
      '|move|p1a: Golisopod|Iron Head|p2a: Victreebel\n|html|INJECT',
      '|move|p1a: Golisopod|Iron Head|p2a: Victreebel|extra|INJECT',
      '|-activate|p2a: Victreebel|move: Wide Guard|[from] <script>INJECT</script>',
    );
    const c = build(t);
    expect(JSON.stringify(c.turn_outcomes)).not.toContain('INJECT');
    expect(c.turn_outcomes_truncated).toBe(true);
  });

  it('外部来源（沙暴/异常）击倒不折叠进招式战果，先收束窗口再独立记录', () => {
    const t = feed(mkTracker(),
      '|move|p1b: Chandelure|Heat Wave|p2a: Victreebel|[spread] p2a,p2b',
      '|-damage|p2a: Victreebel|5/100',
      '|-damage|p2b: Charizard|44/100',
      '|-weather|Sandstorm|[upkeep]',
      '|-damage|p1b: Chandelure|0 fnt|[from] Sandstorm',
      '|faint|p1b: Chandelure',
      '|-damage|p2a: Victreebel|0 fnt|[from] Sandstorm',
      '|faint|p2a: Victreebel',
    );
    const c = build(t);
    expect(c.turn_outcomes).toEqual([
      'T1 our Chandelure Heat Wave: hit foe Victreebel (100→5), hit foe Charizard (92→44)',
      'T1 our Chandelure knocked out',
      'T1 foe Victreebel knocked out',
    ]);
    expect(c.turn_outcomes_truncated).toBe(false);
  });

  it('特性/道具的降能力失败事件进入历史且不误标截断', () => {
    const t = feed(mkTracker(),
      '|-fail|p2a: Victreebel|unboost|atk|[from] ability: Oblivious|[of] p2a: Victreebel',
    );
    const c = build(t);
    expect(c.turn_outcomes).toEqual([]);
    expect(c.turn_outcomes_truncated).toBe(false);
    expect(c.recent_turns.at(-1)!.events).toEqual([
      '|-fail|p2a: Victreebel|unboost|atk|[from] ability: Oblivious|[of] p2a: Victreebel',
    ]);
    expect(c.history_truncated).toBe(false);
  });

  it('招式窗口内的降能力失败提示不写入招式战果', () => {
    const t = feed(mkTracker(),
      '|move|p1a: Golisopod|Iron Head|p2a: Victreebel',
      '|-damage|p2a: Victreebel|50/100',
      '|-fail|p2a: Victreebel|unboost|atk|[from] ability: Oblivious|[of] p2a: Victreebel',
    );
    expect(build(t).turn_outcomes).toEqual(['T1 our Golisopod Iron Head: hit foe Victreebel (100→50)']);
  });
});
