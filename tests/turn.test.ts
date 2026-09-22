import {describe, expect, it} from 'vitest';
import {buildTurnPlans} from '../src/decide/turn.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

const dex = mkDex();

describe('buildTurnPlans', () => {
  it('每个参战槽位一个问题；spread 招式标注 hits both foes', () => {
    const plans = buildTurnPlans({dex, request: mkRequest(), tracker: mkTracker()});
    expect(plans.map(p => p.slot)).toEqual([1, 2]);
    expect(plans.map(p => p.questionName)).toEqual(['action_slot_1', 'action_slot_2']);
    // Heat Wave 的真实协议 target 是 allAdjacentFoes（复数，data/moves.ts）→ 单选项、不写目标
    const heatWave = plans[1].options.find(o => o.key === 'move_2');
    expect(heatWave?.action).toEqual({kind: 'move', slot: 2, moveIndex: 2});
    expect(heatWave?.label).toContain('hits both foes');
    // 单目标招式（Iron Head）为两个对手各生成一个选项
    const slot1Keys = plans[0].options.map(o => o.key);
    expect(slot1Keys).toContain('move_1_foe_a');
    expect(slot1Keys).toContain('move_1_foe_b');
  });

  it('fainted 槽位不提问（服务器 auto-pass，提问会生成错位动作）', () => {
    const request = mkRequest();
    request.side.pokemon[0].condition = '0 fnt';
    const plans = buildTurnPlans({dex, request, tracker: mkTracker()});
    expect(plans.map(p => p.slot)).toEqual([2]);
  });
});
