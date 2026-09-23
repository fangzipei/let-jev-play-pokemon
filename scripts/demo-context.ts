#!/usr/bin/env node
/**
 * 离线演示：给定 JEV_CONTEXT_LEVEL（默认 2）下，jev 在 team preview 实际收到的上下文。
 * 使用本地构造的示例对局（真实队伍 + 示例 stats）与公共 dex 数据，不调用任何模型 API、不产生费用。
 * 运行：npx tsx scripts/demo-context.ts [--level=1|2|3]
 */
import {loadDex} from '../src/dex/index.js';
import {buildPreviewQuestions} from '../src/decide/team-preview.js';
import {buildAnalysisContext} from '../src/state/analysis.js';
import type {BattleRequest} from '../src/state/request.js';
import {buildStatePayload} from '../src/state/serialize.js';
import {BattleTracker} from '../src/state/tracker.js';

const OUR_NAME = 'JevBot1234';

const levelArg = Number(process.argv.find(a => a.startsWith('--level='))?.slice('--level='.length) ?? 2);
const level = levelArg === 1 || levelArg === 3 ? levelArg : 2;

/** 示例对局：我方为 team.txt 固定队伍，对手为强火/格斗压力的预览阵容 */
const PROTOCOL_LINES = [
  '|player|p1|JevBot1234|1|1500',
  '|player|p2|opponent|2|1500',
  '|gametype|doubles',
  '|gen|9',
  '|tier|[Gen 9 Champions] VGC 2026 Reg M-C',
  '|poke|p1|Golisopod, L50, M|',
  '|poke|p1|Tyranitar, L50, M|',
  '|poke|p1|Chandelure, L50, F|',
  '|poke|p1|Excadrill, L50, F|',
  '|poke|p1|Salamence, L50, M|',
  '|poke|p1|Rotom-Wash, L50|',
  '|poke|p2|Charizard, L50, M|',
  '|poke|p2|Victreebel, L50, M|',
  '|poke|p2|Whimsicott, L50, F|',
  '|poke|p2|Kingambit, L50, F|',
  '|poke|p2|Sneasler, L50, F|',
  '|poke|p2|Metagross, L50|',
  '|teampreview|4',
];

/** 队伍来自 team.txt；stats 为离线示例数值（量级贴近 L50 实际值），仅用于演示速度估计链 */
const REQUEST: BattleRequest = {
  teamPreview: true,
  rqid: 1,
  side: {
    name: OUR_NAME,
    id: 'p1',
    pokemon: [
      {ident: 'p1: Golisopod', details: 'Golisopod, L50, M', condition: '167/167', active: false,
        stats: {hp: 167, atk: 206, def: 235, spa: 94, spd: 158, spe: 33},
        moves: ['ironhead', 'drillrun', 'leechlife', 'suckerpunch'], item: 'golisopite', ability: 'emergencyexit', baseAbility: 'emergencyexit'},
      {ident: 'p1: Tyranitar', details: 'Tyranitar, L50, M', condition: '187/187', active: false,
        stats: {hp: 187, atk: 194, def: 138, spa: 121, spd: 130, spe: 82},
        moves: ['rockslide', 'knockoff', 'icepunch', 'firepunch'], item: 'choicescarf', ability: 'sandstream', baseAbility: 'sandstream'},
      {ident: 'p1: Chandelure', details: 'Chandelure, L50, F', condition: '139/139', active: false,
        stats: {hp: 139, atk: 76, def: 96, spa: 222, spd: 116, spe: 100},
        moves: ['shadowball', 'heatwave', 'trickroom', 'protect'], item: 'lifeorb', ability: 'flashfire', baseAbility: 'flashfire'},
      {ident: 'p1: Excadrill', details: 'Excadrill, L50, F', condition: '186/186', active: false,
        stats: {hp: 186, atk: 197, def: 96, spa: 68, spd: 90, spe: 150},
        moves: ['ironhead', 'highhorsepower', 'protect', 'rockslide'], item: 'focussash', ability: 'sandrush', baseAbility: 'sandrush'},
      {ident: 'p1: Salamence', details: 'Salamence, L50, M', condition: '156/156', active: false,
        stats: {hp: 156, atk: 156, def: 100, spa: 176, spd: 100, spe: 167},
        moves: ['protect', 'hypervoice', 'dracometeor', 'flamethrower'], item: 'salamencite', ability: 'intimidate', baseAbility: 'intimidate'},
      {ident: 'p1: Rotom-Wash', details: 'Rotom-Wash, L50', condition: '156/156', active: false,
        stats: {hp: 156, atk: 85, def: 139, spa: 156, spd: 157, spe: 100},
        moves: ['electroweb', 'thunderbolt', 'voltswitch', 'hydropump'], item: 'magnet', ability: 'levitate', baseAbility: 'levitate'},
    ],
  },
};

async function main(): Promise<void> {
  const dex = await loadDex();
  const tracker = new BattleTracker('battle-demo-preview', OUR_NAME);
  for (const line of PROTOCOL_LINES) tracker.handleLine(line);

  const analysis = buildAnalysisContext({dex, state: tracker.state, request: REQUEST, level});
  const payload = buildStatePayload({state: tracker.state, request: REQUEST, dex, analysis});
  const opponentPreviewSpecies = tracker.state.sides.p2?.pokemon.map(p => p.species) ?? [];
  const {questions, descriptionByKey} = buildPreviewQuestions({dex, request: REQUEST, analysis, opponentPreviewSpecies});

  console.log(`JEV_CONTEXT_LEVEL=${level}（stats 为离线示例值）`);
  console.log(`dex.source=${dex.source} species=${Object.keys(dex.species).length} moves=${Object.keys(dex.moves).length}`);
  console.log(`对手预览: ${opponentPreviewSpecies.join(' / ')}`);
  console.log('\n== lead_1 指令（INTRO，jev 读到的完整开头）==');
  console.log(questions.lead_1?.instructions ?? '(缺失)');
  console.log('\n== 六个槽位的候选描述（choice criteria，jev 实际读到的文本）==');
  for (let slot = 1; slot <= 6; slot++) {
    console.log(`[slot_${slot}] ${descriptionByKey[`slot_${slot}`]}`);
  }
  console.log(`\n== team_notes（等级 ${level}，L1 为空属预期）==`);
  for (const note of analysis.teamNotes) console.log(`[${note.slot} ${note.species}] ${note.notes.join(' | ') || '(无注解)'}`);
  const sample = (payload as {sides: {ours: {preview: unknown[]}}}).sides.ours.preview[0];
  console.log('\n== 结构化 payload 采样 sides.ours.preview[0] ==');
  console.log(JSON.stringify(sample, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
