import {describe, expect, it} from 'vitest';
import {sceneBriefing} from '../src/decide/scene.js';
import {mkDex, mkRequest, mkTracker} from './helpers.js';

const dex = mkDex();

describe('场上简报 sceneBriefing', () => {
  it('汇总速度线、对手已暴露情报与后排已见对手', () => {
    const tracker = mkTracker();
    tracker.handleLine('|move|p2a: Victreebel|Sludge Bomb|p1a: Golisopod');
    tracker.handleLine('|-item|p2b: Charizard|Choice Scarf');
    tracker.handleLine('|-ability|p2b: Charizard|Blaze');
    tracker.handleLine('|switch|p2a: Kingambit|Kingambit, L50, F|200/200');
    const request = mkRequest();
    const text = sceneBriefing({dex, request, state: tracker.state}) as string;
    // 速度线：我方用队伍精确值，对手只给 base 并标注未知
    expect(text).toContain('Golisopod 60');
    expect(text).toContain('Kingambit base 50');
    expect(text).toMatch(/base stats only/);
    // 对手已暴露：技能、道具、特性
    expect(text).toContain('Sludge Bomb');
    expect(text).toContain('Choice Scarf');
    expect(text).toContain('Blaze');
    // 换下去的对手仍是已见情报（后排已上场过的成员）
    expect(text).toMatch(/benched/i);
    expect(text).toContain('Victreebel');
  });

  it('对手尚无揭示信息时仍给出速度线与未见标注', () => {
    const tracker = mkTracker();
    const request = mkRequest();
    const text = sceneBriefing({dex, request, state: tracker.state}) as string;
    expect(text).toContain('Victreebel base 70');
    expect(text).toContain('no moves revealed');
  });
});
