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
