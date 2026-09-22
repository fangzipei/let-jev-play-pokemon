#!/usr/bin/env node
import 'dotenv/config';
import {loadConfig} from './config.js';
import {createLogger} from './log/logger.js';
import {runOnlineTeamCheck} from './match/online-check.js';
import {runMatch} from './match/runner.js';
import {loadTeamPaste, packTeam, stripMegaSuffix, unpackSpeciesIds} from './ps/team.js';

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'play';
  if (command === 'play') {
    const result = await runMatch();
    console.log(`==== 结果: ${result.wins} 胜 ${result.losses} 负，总花费 $${result.totalCostUsd.toFixed(6)} ====`);
    return 0;
  }
  if (command === 'validate-team') {
    const online = process.argv.includes('--online');
    const cfg = loadConfig(process.env, {requireApiKey: false});
    const paste = loadTeamPaste(cfg.teamFile);
    const team = packTeam(paste);
    const species = unpackSpeciesIds(team.packed);
    console.log(`队伍（${species.length} 只）: ${species.join(', ')}`);
    console.log(`含 -Mega 形态写法: ${team.hasMegaFormSpecies ? '是' : '否'}`);
    const stripped = packTeam(stripMegaSuffix(paste));
    console.log(`剥离 -Mega 版本: ${unpackSpeciesIds(stripped.packed).join(', ')}`);
    console.log(`packed:\n${team.packed}`);
    if (!online) {
      console.log('离线校验通过。加 --online 可连接服务器检查队伍是否被接受。');
      return 0;
    }
    const logger = createLogger({logDir: cfg.logDir, logLevel: cfg.logLevel});
    const ok = await runOnlineTeamCheck({cfg, packed: team.packed, logger});
    logger.close();
    return ok ? 0 : 1;
  }
  console.error(`未知命令: ${command}（可用: play | validate-team [--online]）`);
  return 1;
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(err => {
    console.error(`运行失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  });
