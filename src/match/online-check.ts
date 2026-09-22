import type {AppConfig} from '../config.js';
import type {Logger} from '../log/logger.js';
import {PsConnection} from '../ps/connection.js';
import {buildTrnCommand, getAssertion} from '../ps/login.js';
import {parseLine} from '../state/protocol.js';
import {sleep, waitFor} from './wait.js';

/**
 * 连接服务器、登录并上传队伍，观察 8 秒内的 popup/error 判定队伍是否被接受。
 * 用于验证 spec 不确定项 1（`-Mega` 形态写法）与团队打包正确性。
 */
export async function runOnlineTeamCheck(input: {cfg: AppConfig; packed: string; logger: Logger}): Promise<boolean> {
  const {cfg, packed, logger} = input;
  const conn = new PsConnection({serverUrl: cfg.psServer, logger});
  let challstr = '';
  let loggedIn = false;
  let popup: string | undefined;
  let errorText: string | undefined;
  conn.onMessage(msg => {
    if (msg.roomId) return;
    for (const line of msg.lines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (parsed.type === 'challstr') challstr = parsed.args.join('|');
      else if (parsed.type === 'updateuser' && parsed.args[1] === '1') loggedIn = true;
      else if (parsed.type === 'popup') popup = parsed.args.join('|');
      else if (parsed.type === 'error') errorText = parsed.args.join('|');
    }
  });
  try {
    await conn.connect();
    await waitFor(() => challstr.length > 0, 10000, '未收到 challstr');
    const assertion = await getAssertion({name: cfg.psUsername, password: cfg.psPassword, challstr, logger});
    conn.command(buildTrnCommand(cfg.psUsername, assertion));
    await waitFor(() => loggedIn, 15000, '登录超时');
    logger.info('登录成功，上传队伍并观察服务器反馈…');
    conn.command(`/utm ${packed}`);
    await sleep(8000);
  } finally {
    conn.close();
  }
  if (popup) {
    console.log(`服务器 popup: ${popup}`);
    if (/team|invalid|reject/i.test(popup)) {
      console.log('结论: 队伍被服务器拒绝。');
      return false;
    }
  }
  if (errorText) console.log(`服务器 error: ${errorText}`);
  console.log(
    popup || errorText ? '结论: 收到服务器消息，请人工检查上面内容。' : '结论: 8 秒内无队伍相关警告，视为通过。',
  );
  return true;
}
