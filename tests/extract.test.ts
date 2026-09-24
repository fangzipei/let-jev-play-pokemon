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
  '|switch|p2b: Charizard|Charizard, L50, M|100/100',
  '|detailschange|p2b: Charizard|Charizard-Mega-Y, L50, M',
  '|-mega|p2b: Charizard|Charizard|Charizardite Y',
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
    expect(obs!.opponentMegaSpecies).toEqual(['Charizard']);
  });
  it.each(['Indeedee', '小茶杯', 'Rillaboom'])('昵称 %s 的 move 不覆盖 Indeedee-F，重复招式去重', name => {
    const log = [
      '|player|p1|JevBot1234', '|player|p2|rival',
      '|poke|p2|Indeedee-F, L50, F|', '|poke|p2|Rillaboom, L50, M|',
      `|switch|p2a: ${name}|Indeedee-F, L50, F|100/100`,
      '|turn|1',
      `|move|p2a: ${name}|Follow Me|p2a: ${name}`,
      `|move|p2a: ${name}|Follow Me|p2a: ${name}`,
      '|win|JevBot1234',
    ].join('\n');
    const obs = extractObservation(log, DECISIONS_JSONL)!;
    expect(obs.opponentSpecies).toEqual(['Indeedee-F', 'Rillaboom']);
    expect(obs.revealed).toEqual([
      {species: 'Indeedee-F', moves: ['Follow Me'], itemConsumed: false, led: true},
    ]);
  });

  it.each([1, 2, 3])('连续道具与特性事件的第 %i 步仍保留真实物种', count => {
    const events = [
      '|-item|p2a: 小茶杯|Psychic Seed',
      '|-enditem|p2a: 小茶杯|Psychic Seed',
      '|-ability|p2a: 小茶杯|Psychic Surge',
    ];
    const log = [
      '|player|p1|JevBot1234', '|player|p2|rival',
      '|switch|p2a: 小茶杯|Indeedee-F, L50, F|100/100',
      '|turn|1', ...events.slice(0, count), '|win|JevBot1234',
    ].join('\n');
    const expected = {
      species: 'Indeedee-F', moves: [], item: 'Psychic Seed', itemConsumed: count >= 2, led: true,
      ...(count === 3 ? {ability: 'Psychic Surge'} : {}),
    };
    expect(extractObservation(log, DECISIONS_JSONL)!.revealed).toEqual([expected]);
  });

  it.each(['switch', 'drag', 'detailschange', '-formechange', 'formechange'])(
    '%s 的真实形态更新后，move 不恢复旧物种或昵称', event => {
      const log = [
        '|player|p1|JevBot1234', '|player|p2|rival',
        '|switch|p2a: 海豚|Palafin, L50, M|100/100', '|turn|1',
        '|move|p2a: 海豚|Wave Crash|p1a: Golisopod',
        `|${event}|p2a: 海豚|Palafin-Hero, L50, M|100/100`,
        '|move|p2a: 海豚|Jet Punch|p1a: Golisopod', '|win|JevBot1234',
      ].join('\n');
      expect(extractObservation(log, DECISIONS_JSONL)!.revealed).toEqual([
        {species: 'Palafin-Hero', moves: ['Wave Crash', 'Jet Punch'], itemConsumed: false, led: true},
      ]);
    },
  );

  it('标准 -formechange 的裸物种参数可更新物种', () => {
    const log = [
      '|player|p1|JevBot1234', '|player|p2|rival',
      '|switch|p2a: 海豚|Palafin, L50, M|100/100', '|turn|1',
      '|-formechange|p2a: 海豚|Palafin-Hero|[from] ability: Zero to Hero',
      '|win|JevBot1234',
    ].join('\n');
    expect(extractObservation(log, DECISIONS_JSONL)!.revealed).toEqual([
      {species: 'Palafin-Hero', moves: [], itemConsumed: false, led: true},
    ]);
  });

  it.each([
    '|move|p2a: Rillaboom|Follow Me|p2a: Rillaboom',
    '|-item|p2a: Rillaboom|Psychic Seed',
    '|-enditem|p2a: Rillaboom|Psychic Seed',
    '|-ability|p2a: Rillaboom|Psychic Surge',
  ])('未知身份不通过昵称或预览猜测物种：%s', event => {
    const log = [
      '|player|p1|JevBot1234', '|player|p2|rival',
      '|poke|p2|Indeedee-F, L50, F|', '|poke|p2|Rillaboom, L50, M|',
      '|turn|1', event, '|win|JevBot1234',
    ].join('\n');
    const obs = extractObservation(log, DECISIONS_JSONL)!;
    expect(obs.opponentSpecies).toEqual(['Indeedee-F', 'Rillaboom']);
    expect(obs.revealed).toEqual([]);
  });

  it('仅 -ability/-mega 而无真实物种信息时不制造揭示物种', () => {
    const log = [
      '|player|p1|JevBot1234', '|player|p2|rival', '|turn|1',
      '|-ability|p2a: 小火龙|Drought',
      '|-mega|p2a: 小火龙|Charizard|Charizardite Y', '|win|JevBot1234',
    ].join('\n');
    const obs = extractObservation(log, DECISIONS_JSONL)!;
    expect(obs.revealed).toEqual([]);
    expect(obs.opponentMegaSpecies).toEqual(['Charizard']);
  });

  it('Mega 前有 detailschange 时保留真实形态，不被 -mega、特性和招式覆盖', () => {
    const log = [
      '|player|p1|JevBot1234', '|player|p2|rival', '|turn|1',
      '|detailschange|p2a: 小火龙|Charizard-Mega-Y, L50, M',
      '|-mega|p2a: 小火龙|Charizard|Charizardite Y',
      '|-ability|p2a: 小火龙|Drought',
      '|move|p2a: 小火龙|Heat Wave|p1a: Golisopod', '|win|JevBot1234',
    ].join('\n');
    const obs = extractObservation(log, DECISIONS_JSONL)!;
    expect(obs.revealed).toEqual([
      {species: 'Charizard-Mega-Y', ability: 'Drought', moves: ['Heat Wave'], itemConsumed: false, led: false},
    ]);
    expect(obs.opponentMegaSpecies).toEqual(['Charizard']);
  });

  it.each(['switch', 'drag', 'detailschange', '-formechange'])(
    '未知身份的观察由后续 %s 补全物种后仍保留', event => {
      const log = [
        '|player|p1|JevBot1234', '|player|p2|rival', '|turn|1',
        '|move|p2a: 小茶杯|Follow Me|p2a: 小茶杯',
        '|-item|p2a: 小茶杯|Psychic Seed',
        '|-enditem|p2a: 小茶杯|Psychic Seed',
        '|-ability|p2a: 小茶杯|Psychic Surge',
        `|${event}|p2a: 小茶杯|Indeedee-F, L50, F|100/100`,
        '|move|p2a: 小茶杯|Helping Hand|p2b: Sneasler', '|win|JevBot1234',
      ].join('\n');
      expect(extractObservation(log, DECISIONS_JSONL)!.revealed).toEqual([
        {species: 'Indeedee-F', moves: ['Follow Me', 'Helping Hand'], item: 'Psychic Seed',
          ability: 'Psychic Surge', itemConsumed: true, led: false},
      ]);
    },
  );

  it.each(['switch', 'drag'])('%s 缺失 details 时不猜物种，也不覆盖已知物种', event => {
    const header = ['|player|p1|JevBot1234', '|player|p2|rival'];
    const tail = [`|${event}|p2a: 小茶杯`, '|win|JevBot1234'];
    expect(extractObservation([...header, ...tail].join('\n'), DECISIONS_JSONL)!.revealed).toEqual([]);
    const known = [...header, '|switch|p2a: 小茶杯|Indeedee-F, L50, F|100/100', '|turn|1', ...tail];
    expect(extractObservation(known.join('\n'), DECISIONS_JSONL)!.revealed).toEqual([
      {species: 'Indeedee-F', moves: [], itemConsumed: false, led: true},
    ]);
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
