import {describe, expect, it} from 'vitest';
import {buildChooseCommand, validateActions, type ChooseAction} from '../src/ps/choose.js';
import {mkRequest} from './helpers.js';

describe('buildChooseCommand', () => {
  it('双打两个槽位的招式 + 目标 + mega', () => {
    const actions: ChooseAction[] = [
      {kind: 'move', slot: 1, moveIndex: 1, target: '+1', mega: true},
      {kind: 'move', slot: 2, moveIndex: 2},
    ];
    expect(buildChooseCommand(actions, {rqid: 7, sendRqid: true})).toBe('/choose move 1 +1 mega, move 2|7');
  });

  it('槽位顺序保证 1 在前', () => {
    const actions: ChooseAction[] = [
      {kind: 'switch', slot: 2, teamIndex: 3},
      {kind: 'move', slot: 1, moveIndex: 4, target: '-1'},
    ];
    expect(buildChooseCommand(actions)).toBe('/choose move 4 -1, switch 3');
  });

  it('pass 与 default 槽位', () => {
    expect(buildChooseCommand([{kind: 'switch', slot: 1, teamIndex: 5}, {kind: 'pass', slot: 2}])).toBe('/choose switch 5, pass');
    expect(buildChooseCommand([{kind: 'slot-default', slot: 1}, {kind: 'slot-default', slot: 2}])).toBe('/choose default, default');
  });

  it('team preview 发送全部 6 位', () => {
    expect(buildChooseCommand([{kind: 'team', order: [5, 2, 3, 1, 4, 6]}], {rqid: 2})).toBe('/choose team 523146|2');
  });

  it('全体 default 与 rqid 关闭', () => {
    expect(buildChooseCommand([{kind: 'default'}], {rqid: 9, sendRqid: false})).toBe('/choose default');
  });
});

describe('validateActions', () => {
  const request = mkRequest();
  it('合法动作无问题', () => {
    expect(validateActions([
      {kind: 'move', slot: 1, moveIndex: 1, target: '+1', mega: true},
      {kind: 'switch', slot: 2, teamIndex: 3},
    ], request)).toEqual([]);
  });
  it('mega 只能一只', () => {
    const problems = validateActions([
      {kind: 'move', slot: 1, moveIndex: 1, mega: true},
      {kind: 'move', slot: 2, moveIndex: 2, mega: true},
    ], request);
    expect(problems.join()).toMatch(/Mega/);
  });
  it('禁用招式与非法换人目标被拒绝', () => {
    const req = mkRequest();
    req.active![0].moves[0].disabled = true;
    const problems = validateActions([
      {kind: 'move', slot: 1, moveIndex: 1},
      {kind: 'switch', slot: 2, teamIndex: 1},
    ], req);
    expect(problems.join()).toMatch(/不可用/);
    expect(problems.join()).toMatch(/已在场/);
  });
  it('team order 必须 6 位不重复', () => {
    expect(validateActions([{kind: 'team', order: [1, 1, 2, 3, 4, 5]}]).join()).toMatch(/team order/);
  });
  it('两个槽位不能换入同一只替补', () => {
    const problems = validateActions([
      {kind: 'switch', slot: 1, teamIndex: 4},
      {kind: 'switch', slot: 2, teamIndex: 4},
    ], request);
    expect(problems.join()).toMatch(/重复/);
  });
});
