// tests/extract.test.ts
import {describe, expect, it} from 'vitest';
import {extractObservation} from '../src/learn/extract.js';

const PROTOCOL_LOG = [
  '|player|p1|JevBot1234|1|1500',
  '|player|p2|rival|2|1500',
  '|gametype|doubles',
  '|poke|p1|Golisopod, L50, M|',
  '|poke|p1|Tyranitar, L50, M|',
  '|poke|p2|Rillaboom, L50, M|',
  '|poke|p2|Sneasler, L50, F|',
  '|poke|p2|Incineroar, L50, M|',
  '|poke|p2|Charizard, L50, M|',
  '|poke|p2|Metagross, L50|',
  '|teampreview|4',
  '|start',
  '|switch|p1a: Golisopod|Golisopod, L50, M|150/150',
  '|switch|p2a: Rillaboom|Rillaboom, L50, M|100/100',
  '|switch|p2b: Sneasler|Sneasler, L50, F|100/100',
  '|turn|1',
  '|move|p2b: Sneasler|Fake Out|p1a: Golisopod',
  '|-damage|p1a: Golisopod|132/150',
  '|-ability|p2b: Sneasler|Unburden',
  '|-item|p2b: Sneasler|Grassy Seed',
  '|turn|2',
  '|move|p2a: Rillaboom|Grassy Glide|p1a: Golisopod',
  '|-damage|p1a: Golisopod|92/150',
  '|-enditem|p2a: Rillaboom|Grassy Seed',
  '|-mega|p2b: Sneasler|Sneasler-Mega',
  '|win|JevBot1234',
].join('\n');

const DECISIONS_JSONL = JSON.stringify({
  ts: '2026-09-23T00:00:00.000Z', kind: 'team-preview',
  state: {sides: {ours: {preview: [{ident: 'p1: Golisopod', species: 'Golisopod'}]}, opponent: {}}},
}) + '\n';

describe('extractObservation', () => {
  it('提取胜负、对手 6 只、按物种揭示与首发标记', () => {
    const obs = extractObservation(PROTOCOL_LOG, DECISIONS_JSONL, {battleId: 'battle-x'});
    expect(obs).toMatchObject({battleId: 'battle-x', won: true});
    expect(obs!.opponentSpecies).toEqual(['Rillaboom', 'Sneasler', 'Incineroar', 'Charizard', 'Metagross']);
    expect(obs!.ourSpecies).toEqual(['Golisopod', 'Tyranitar']);
    const sneasler = obs!.revealed.find(r => r.species === 'Sneasler')!;
    expect(sneasler).toMatchObject({item: 'Grassy Seed', ability: 'Unburden', led: true, itemConsumed: false});
    expect(sneasler.moves).toEqual(['Fake Out']);
    const rillaboom = obs!.revealed.find(r => r.species === 'Rillaboom')!;
    expect(rillaboom).toMatchObject({led: true, itemConsumed: true});
    expect(obs!.opponentMegaSpecies).toEqual(['Sneasler-Mega']);
  });
  it('无 win 行与 tie 返回 null', () => {
    const noWin = PROTOCOL_LOG.replace('|win|JevBot1234', '|tie');
    expect(extractObservation(noWin, DECISIONS_JSONL)).toBeNull();
  });
  it('decisions 缺 state 时用 ourSideHint，仍无则 null', () => {
    const noState = JSON.stringify({ts: 'x', kind: 'turn', state: null}) + '\n';
    expect(extractObservation(PROTOCOL_LOG, noState, {ourSideHint: 'p1'})?.won).toBe(true);
    expect(extractObservation(PROTOCOL_LOG, noState)).toBeNull();
    expect(extractObservation(PROTOCOL_LOG, '', {})).toBeNull();
  });
  it('失败局 won=false', () => {
    const lost = PROTOCOL_LOG.replace('|win|JevBot1234', '|win|rival');
    expect(extractObservation(lost, DECISIONS_JSONL, {battleId: 'b'})?.won).toBe(false);
  });
  it('赛后空名 |player| 行不覆盖有效名字', () => {
    const lostWithTail = PROTOCOL_LOG.replace('|win|JevBot1234', '|win|rival') + '\n|player|p2|';
    expect(extractObservation(lostWithTail, DECISIONS_JSONL, {battleId: 'b'})?.won).toBe(false);
    const wonWithTail = PROTOCOL_LOG + '\n|player|p1|';
    expect(extractObservation(wonWithTail, DECISIONS_JSONL)?.won).toBe(true);
  });
});
