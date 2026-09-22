# jev-poke

用 OpenRouter Decisions API（jev 模型，`~typesafe/jev-latest`）自动打 Pokémon Showdown 的机器人：连接官方 WebSocket 协议读取完整对战信息，在每个决策点（team preview / 回合行动 / 强制换人）把结构化问题（noul / choice / score）发给 jev，并把返回值转换为 `/choose` 指令自动对战。

- 赛制：`gen9championsvgc2026regmc`（Champions VGC Reg M-C：双打、6 选 4、每场一次 Mega）
- 每个决策点恰好一次 Decisions API 调用；`state` 为结构化 JSON，选项描述含本地计算结果（属性克制 / 粗估伤害 / 速度对比）
- 全链路兜底：jev 超时、答案缺失、动作非法、服务器拒绝、掉线重连均有本地启发式兜底，不会因决策失败被判负

## 安装

要求 Node.js ≥ 20。

```bash
npm install
cp .env.example .env
```

PowerShell：`Copy-Item .env.example .env`。然后在 `.env` 里填 `OPENROUTER_API_KEY`（只跑 mock 冒烟可不填）。

## 配置（.env）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENROUTER_API_KEY` | （空） | Decisions API 密钥；`JEV_MOCK=1` 时可不填 |
| `JEV_MODEL` | `~typesafe/jev-latest` | 模型 id |
| `JEV_TRANSPORT` | `sdk` | `sdk` = @openrouter/sdk；`fetch` = 直接 POST REST 端点 |
| `JEV_TIMEOUT_MS` | `20000` | 单次请求超时（毫秒） |
| `JEV_MOCK` | `0` | `1` = 完全跳过 API，全部走本地启发式 |
| `JEV_RETRY` | `1` | 请求失败重试次数 |
| `PS_SERVER` | `wss://sim3.psim.us/showdown/websocket` | Showdown WebSocket 地址 |
| `PS_USERNAME` | （空→随机） | 登录名；留空自动生成 `JevBot####` 游客名 |
| `PS_PASSWORD` | （空） | 密码；游客模式留空 |
| `PS_FORMAT` | `gen9championsvgc2026regmc` | 匹配用 format id |
| `TEAM_FILE` | `team.txt` | 队伍 paste 文件路径 |
| `START_MODE` | `ladder` | `ladder` 随机匹配 / `challenge` 挑战指定用户 / `accept` 自动接受挑战 |
| `CHALLENGE_USER` | （空） | `START_MODE=challenge` 时必填 |
| `MAX_BATTLES` | `1` | 打完 N 场后退出 |
| `SEND_RQID` | `1` | `0` = `/choose` 不追加 `\|<rqid>` |
| `LOG_DIR` | `logs` | 日志目录 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` |

## 运行

```bash
npm run play                      # 按 .env 打 MAX_BATTLES 场
npm run validate-team             # 离线检查队伍打包结果
npm run validate-team -- --online # 连服务器验证队伍是否被接受
```

不花 API 费用的整链路冒烟（全走本地启发式）：

```powershell
$env:JEV_MOCK='1'; npm run play
```

```bash
JEV_MOCK=1 npm run play
```

## 测试

```bash
npm test           # vitest：单元测试 + 本地 BattleStream 集成测试
npm run typecheck  # tsc --noEmit
```

## 日志

每次对战在 `LOG_DIR` 下生成两个文件：

- `<battleId>.protocol.log`：逐行原始协议，可直接作为回放夹具
- `<battleId>.decisions.jsonl`：每次决策一条 JSON，字段：
  `{ts, kind, turn, rqid, chosen, adjusted, fallback, latency_ms, usage:{cost,input_tokens,output_tokens}, answers, questions, state}`
  - `kind`：`team-preview` / `turn` / `force-switch`
  - `fallback: true` 表示本次决策（部分或全部）使用了本地启发式
  - `usage.cost` 为本次调用花费（美元）；`JEV_MOCK=1` 时为 `{}`

## 目录结构

```
src/index.ts          CLI（play / validate-team）
src/config.ts         环境变量加载与校验
src/ps/               连接、登录、会话、战斗房间、指令构建、队伍打包
src/state/            协议解析、tracker、request 解析、本地计算、state 序列化
src/decide/           问题模板（preview/turn/force-switch）、答案解析、兜底、编排
src/jev/              Decisions API 客户端（sdk|fetch）
src/dex/              dex 数据加载（线上 data → 本地包 → 空降级）
src/match/            多场编排、等待工具、在线队伍检查
```

## 验证记录

`docs/verification.md`：spec §13 不确定项逐条验证的结论与证据。
