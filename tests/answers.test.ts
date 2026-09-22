import {describe, expect, it} from 'vitest';
import {resolveKey} from '../src/decide/answers.js';
import type {Answer} from '../src/jev/types.js';

const valid = ['move_1_foe_a', 'move_2', 'switch_3'];

describe('resolveKey', () => {
  it('合法 choice 直接返回（adjusted=false）', () => {
    const answer: Answer = {type: 'choice', choice: 'move_2', confidence: 0.8};
    expect(resolveKey(answer, valid)).toEqual({key: 'move_2', confidence: 0.8, adjusted: false});
  });

  it('非法 choice 用 probabilities 取最高合法项（adjusted=true）', () => {
    const answer: Answer = {
      type: 'choice', choice: 'bogus',
      probabilities: {bogus: 0.5, move_2: 0.3, switch_3: 0.2},
    };
    expect(resolveKey(answer, valid)).toEqual({key: 'move_2', confidence: 0, adjusted: true});
  });

  it('answer 缺失 / 非 choice / 无合法概率时返回 null', () => {
    expect(resolveKey(undefined, valid)).toBeNull();
    expect(resolveKey({type: 'noul', noul: 0.7}, valid)).toBeNull();
    expect(resolveKey({type: 'choice', choice: 'bogus', probabilities: {bogus: 1}}, valid)).toBeNull();
  });
});
