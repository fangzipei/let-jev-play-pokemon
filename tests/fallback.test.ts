import {describe, expect, it} from 'vitest';
import {
  fallbackActions, fallbackSwitchActions, fallbackTeamPreview, fallbackTurnActions,
} from '../src/decide/fallback.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

const dex = mkDex();

describe('fallbackTeamPreview', () => {
  it('按队伍顺序 1-6', () => {
    expect(fallbackTeamPreview()).toEqual({kind: 'team', order: [1, 2, 3, 4, 5, 6]});
  });
});

describe('fallbackTurnActions', () => {
  it('每槽位选粗估伤害最大的招式并指定敌位', () => {
    // 槽位 1：Iron Head vs Victreebel ≈69%（≥ Leech Life 69% 并列取前，> Sucker Punch 40%）→ Foe A
    // 槽位 2：Heat Wave spread vs Victreebel ≈123%（> Shadow Ball 69%）→ spread 不指定目标
    const actions = fallbackTurnActions({dex, request: mkRequest(), tracker: mkTracker()});
    expect(actions).toEqual([
      {kind: 'move', slot: 1, moveIndex: 1, target: '+1'},
      {kind: 'move', slot: 2, moveIndex: 2},
    ]);
  });

  it('spread 招式不指定目标', () => {
    const request = mkRequest();
    request.active![1].moves = [request.active![1].moves[1]]; // 只留 Heat Wave
    const actions = fallbackTurnActions({dex, request, tracker: mkTracker()});
    const slot2 = actions.find(a => a.kind === 'move' && a.slot === 2) as {kind: 'move'; moveIndex: number; target?: string};
    expect(slot2.moveIndex).toBe(1);
    expect(slot2.target).toBeUndefined();
  });

  it('全部招式不可用时输出 slot-default', () => {
    const request = mkRequest();
    for (const active of request.active!) for (const mv of active.moves) mv.disabled = true;
    const actions = fallbackTurnActions({dex, request, tracker: mkTracker()});
    expect(actions).toEqual([
      {kind: 'slot-default', slot: 1},
      {kind: 'slot-default', slot: 2},
    ]);
  });

  it('fainted 槽位不产生动作（服务器 auto-pass，动作会错位到下一个参战位）', () => {
    const request = mkRequest();
    request.side.pokemon[0].condition = '0 fnt';
    const actions = fallbackTurnActions({dex, request, tracker: mkTracker()});
    expect(actions).toEqual([{kind: 'move', slot: 2, moveIndex: 2}]);
  });

  it('残局只剩一个对手时适应力把本系加成计入兜底评分', () => {
    const normalTracker = mkTracker();
    normalTracker.state.sides.p2.pokemon[0].fainted = true; // 只留 Charizard
    const normal = fallbackTurnActions({dex, request: mkRequest(), tracker: normalTracker});
    // 无适应力：Iron Head 31% < Sucker Punch 36% → Sucker Punch
    expect(normal.find(a => a.kind === 'move' && a.slot === 1)).toMatchObject({moveIndex: 4});
    const request = mkRequest();
    request.side.pokemon[0].ability = 'adaptability';
    const adaptTracker = mkTracker();
    adaptTracker.state.sides.p2.pokemon[0].fainted = true;
    const adapt = fallbackTurnActions({dex, request, tracker: adaptTracker});
    // 适应力：Iron Head 41% > Sucker Punch 36% → Iron Head
    expect(adapt.find(a => a.kind === 'move' && a.slot === 1)).toMatchObject({moveIndex: 1});
  });

  it('上一回合守过后兜底直接跳过保护类招式', () => {
    const request = mkRequest();
    request.active![0].moves = [
      {move: 'Protect', id: 'protect', pp: 8, maxpp: 8, target: 'self'},
      {move: 'Trick Room', id: 'trickroom', pp: 5, maxpp: 5, target: 'all'},
    ];
    const chained = mkTracker();
    chained.handleLine('|move|p1a: Golisopod|Protect|p1a: Golisopod');
    chained.handleLine('|turn|2');
    const actions = fallbackTurnActions({dex, request, tracker: chained});
    // 保护类不在候选 → 只剩 Trick Room
    expect(actions.find(a => a.kind === 'move' && a.slot === 1)).toMatchObject({moveIndex: 2});
    const fresh = fallbackTurnActions({dex, request, tracker: mkTracker()});
    // 未连续时 Protect（0.9）优先于其他状态招式（0.5）
    expect(fresh.find(a => a.kind === 'move' && a.slot === 1)).toMatchObject({moveIndex: 1});
  });

  it('连续保护跳过时不回退到保护（无其他可用招式时走 slot-default）', () => {
    const request = mkRequest();
    request.active![0].moves = [
      {move: 'Protect', id: 'protect', pp: 8, maxpp: 8, target: 'self'},
      {move: 'Iron Head', id: 'ironhead', pp: 0, maxpp: 15, target: 'normal'},
    ];
    const chained = mkTracker();
    chained.handleLine('|move|p1a: Golisopod|Protect|p1a: Golisopod');
    chained.handleLine('|turn|2');
    // 降权实现会回退到 Protect（0.1）；跳过实现没有候选 → slot-default
    const actions = fallbackTurnActions({dex, request, tracker: chained});
    expect(actions.find(a => 'slot' in a && a.slot === 1)).toMatchObject({kind: 'slot-default'});
  });

  it('间隔一回合后兜底恢复优先保护类招式（stall 计数已清除）', () => {
    const request = mkRequest();
    request.active![0].moves = [
      {move: 'Protect', id: 'protect', pp: 8, maxpp: 8, target: 'self'},
      {move: 'Trick Room', id: 'trickroom', pp: 5, maxpp: 5, target: 'all'},
    ];
    const stale = mkTracker();
    stale.handleLine('|move|p1a: Golisopod|Protect|p1a: Golisopod');
    stale.handleLine('|turn|2');
    stale.handleLine('|turn|3');
    // 上一回合未守 → Protect 恢复常规优先（0.9 > Trick Room 0.5）
    expect(fallbackTurnActions({dex, request, tracker: stale}).find(a => a.kind === 'move' && a.slot === 1)).toMatchObject({moveIndex: 1});
  });
});

describe('fallbackSwitchActions', () => {
  it('选“血最厚且被克制最少”的替补，其余槽位 pass', () => {
    const request = mkRequest();
    request.active = undefined;
    request.forceSwitch = [true, false];
    // Tyranitar（岩石/恶）吃草 2x；Salamence（龙/飞）最差只有 1x → 选槽位 4
    const actions = fallbackSwitchActions({dex, request, tracker: mkTracker()});
    expect(actions).toEqual([
      {kind: 'switch', slot: 1, teamIndex: 4},
      {kind: 'pass', slot: 2},
    ]);
  });

  it('双槽位同时换人时选择两只不同替补', () => {
    const request = mkRequest();
    request.active = undefined;
    request.forceSwitch = [true, true];
    const actions = fallbackSwitchActions({dex, request, tracker: mkTracker()});
    expect(actions).toEqual([
      {kind: 'switch', slot: 1, teamIndex: 4},
      {kind: 'switch', slot: 2, teamIndex: 3},
    ]);
  });
});

describe('fallbackActions', () => {
  it('team preview', () => {
    const request = mkRequest({teamPreview: true});
    request.active = undefined;
    expect(fallbackActions({dex, request, tracker: mkTracker()})).toEqual([{kind: 'team', order: [1, 2, 3, 4, 5, 6]}]);
  });

  it('force switch', () => {
    const request = mkRequest();
    request.active = undefined;
    request.forceSwitch = [true, false];
    expect(fallbackActions({dex, request, tracker: mkTracker()})[0].kind).toBe('switch');
  });

  it('无 active 也无 forceSwitch 时 default', () => {
    const request = mkRequest();
    request.active = undefined;
    request.wait = true;
    expect(fallbackActions({dex, request, tracker: mkTracker()})).toEqual([{kind: 'default'}]);
  });
});
