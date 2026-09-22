import {describe, expect, it} from 'vitest';
import {parseRequest} from '../src/state/request.js';

const raw = JSON.stringify({
  active: [
    {moves: [{move: 'Iron Head', id: 'ironhead', pp: 15, maxpp: 15, target: 'normal'}]},
    {moves: [{move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self'}], canMegaEvo: true},
  ],
  side: {
    name: 'JevBot1234', id: 'p1',
    pokemon: [
      {ident: 'p1: Golisopod', details: 'Golisopod, L50, M', condition: '150/150', active: true},
      {ident: 'p1: Chandelure', details: 'Chandelure, L50, F', condition: '135/135', active: true},
    ],
  },
  rqid: 7,
});

describe('parseRequest', () => {
  it('解析正常请求', () => {
    const req = parseRequest(raw);
    expect(req?.rqid).toBe(7);
    expect(req?.active?.[0]?.moves[0]?.id).toBe('ironhead');
    expect(req?.active?.[1]?.canMegaEvo).toBe(true);
    expect(req?.side.pokemon.length).toBe(2);
  });

  it('非法 JSON 返回 null', () => {
    expect(parseRequest('{oops')).toBeNull();
  });

  it('缺少 side 返回 null', () => {
    expect(parseRequest('{"rqid":1}')).toBeNull();
  });
});
