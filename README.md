# jev-poke

用 OpenRouter Decisions API（jev 模型，`~typesafe/jev-latest`）自动打 Pokémon Showdown 的机器人：连接官方 WebSocket 协议读取完整对战信息，在每个决策点（team preview / 回合行动 / 强制换人）把结构化问题（noul / choice / score）发给 jev，并把返回值转换为 `/choose` 指令自动对战。

- 赛制：`gen9championsvgc2026regmc`（Champions VGC Reg M-C：双打、6 选 4、每场一次 Mega）
- 每个有效决策点将问题合并为一批交给 jev；重试和 SDK→fetch 回退可能产生多次尝试，mock、取消或本地降级也可能不调用 API；L3 还会先尝试 advisor 分析
- 默认 L2 上下文：完整客观信息 + 条件化战术注解；本地速度估计、属性倍率和粗伤害均标明适用范围与未知项
- jev 超时、答案缺失、动作非法或服务器拒绝时尝试本地兜底；请求更新、战斗结束或断线时取消旧决策。兜底不能保证网络恢复、服务器接受动作或避免计时判负

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
| `JEV_TRANSPORT` | `sdk` | `sdk` = @openrouter/sdk；`fetch` = 直接 POST REST 端点；`chat` = 把决策组装为 Chat Completions 提示词（临时方案，仅 choice 题型，可让任意对话模型如 `google/gemini-3.8-flash` 做决策；Decisions API 只接受 jev 系列模型） |
| `JEV_TIMEOUT_MS` | `20000` | 一次 jev 决策的共享预算（毫秒），包含 SDK 加载、SDK→fetch 回退、响应读取与所有重试，不是每次尝试重新获得 20s |
| `JEV_CONTEXT_LEVEL` | `2` | `1` 完整客观上下文 / `2` 加条件化战术注解 / `3` 再加 advisor 实时分析；非法等级 warn 并回退 2 |
| `JEV_ADVISOR_MODEL` | `google/gemini-3.8-flash` | advisor 的可配置模型起点，不承诺实测延迟或质量 |
| `JEV_ADVISOR_API_KEY` | （空） | 留空或仅空白时复用 `OPENROUTER_API_KEY` |
| `JEV_ADVISOR_TIMEOUT_MS` | `10000` | advisor 本地等待预算（毫秒），同时受决策剩余总预算限制 |
| `JEV_ADVISOR_MAX_TOKENS` | `2048` | advisor 单次输出上限（多数供应方计入推理 token）；不是 120 词本地限制的同义项 |
| `JEV_ADVISOR_REASONING` | （空） | 显式推理强度 `low`/`medium`/`high`；留空或空白则不发送推理参数，仅对确认支持的模型设置 |
| `JEV_DECISION_BUDGET_MS` | `35000` | 当前请求的决策总预算（毫秒），覆盖上下文准备、advisor + jev，不会在进入 jev 时重置 |
| `JEV_MOCK` | `0` | `1` = 跳过 jev 和 advisor，全部走本地启发式；仍可能连接 Showdown 和拉取 dex |
| `JEV_RETRY` | `1` | jev 请求失败后的最多重试次数，与首次尝试共享预算；advisor 不重试 |
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

三个超时/预算变量必须是 `1` 至 `2147483647` 的整数毫秒数；非法值在启动校验时拒绝，不静默回退。`JEV_RETRY` 必须是非负安全整数。`JEV_ADVISOR_MAX_TOKENS` 必须是正安全整数。非空 `JEV_ADVISOR_REASONING` 必须是 `low`、`medium` 或 `high` 之一。非 mock 正常启动仍要求主 API key；独立 advisor key 不能代替 jev 主 key。

## 三级上下文与预算

- **L1：完整客观上下文**。保留当前可获得的我方队伍/在场/替补、招式与请求状态，对手预览与已揭示信息、天气/场地、能力阶级及近期协议记录；增加双向属性倍率、速度估计与已揭示招式的来袭粗估，不添加角色注解或 advisor 建议。“完整”不包含对手隐藏信息，缺失值保持 unknown/null。
- **L2（默认）：L1 + 条件化战术注解**。按当前队伍的招式、道具、特性、HP、天气与 Mega 使用状态生成注解，引导根据对手选择首发；不是无条件粘贴固定六只的战术结论。不会新增 advisor 请求，但不保证 jev 的 token 用量或延迟不变。
- **L3：L2 + OpenRouter advisor 实时分析，再交 jev**。advisor 使用 Chat Completions，读取同一份决策快照及合法选项；有效分析最多保留 120 个英文词，加入状态与问题指令。jev 仍作最终选择，之后继续本地动作合并与校验。advisor 不可用、失败或超时而总预算尚有剩余时，按 L2 上下文继续；总预算耗尽则尝试本地兜底，已取消的旧请求不再发送动作。

我方速度以 request 实际数值为基准，只应用已支持且可确认的修正；**种族速度不能与实际速度直接比较**，对手实际速度与出手顺序保持 unknown。Trick Room 只反转同优先度内的速度顺序；Electroweb 在空间下可能帮助对手先行动。沙暴会结束、被替换或压制；Sucker Punch 依赖目标选择攻击且尚未行动，Focus Sash 依赖满 HP 等条件；Mega 前后特性不能混用。潜在 STAB 仅是属性威胁，不代表对手已知招式；粗伤害即使写成百分比，也不是经过校准的实际 HP% 预测。

默认 advisor 最多等待 10s，随后 jev 最多使用其 20s 共享预算，两者同时受当前请求 35s 总截止时间约束；总预算也适用于 L1/L2。SDK→fetch 和重试均不重置截止时间。这里约束的是本地等待与后续请求启动，不是服务端计时器或端到端发送成功的保证。**本地超时/取消不保证远端停止处理或不计费**；模型可用性、真实延迟、质量和账单须另行验证。

## dex 数据

- 主源为官方 `https://play.pokemonshowdown.com/data/` 下的 `pokedex.js`、`moves.js`、`typechart.js`；前两表失败时分别尝试同站 `pokedex.json`、`moves.json`，不猜测 typechart JSON 或 CDN 路径。
- 三张表独立保留有效线上数据，再由本地 `pokemon-showdown` 按相同 ID 补缺失条目和字段，线上已校验值优先；单表失败不丢弃其他成功表。仍缺失时保持 unknown，缺 Mega 数据不以普通形态冒充。
- `.cache/ps-data` 缓存 TTL 为 24h，保存版本、表名、来源 URL、获取时间及原文，命中时重新解析校验；过期、损坏或来源不匹配的缓存不作为有效结果。
- 单表各远程源及响应体读取共享默认 8s 预算，不按源叠加。远程 JS 只解析允许的数据字面量，不执行脚本、函数或表达式；不保证线上数据与当前赛制完全同步。

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

离线查看指定等级下 jev 实际收到的 team preview 上下文（不调用模型、不产生费用）：

```powershell
$env:DOTENV_CONFIG_PATH='tests/fixtures/nonexistent.env'; npx tsx scripts/demo-context.ts --level=2
```

## 日志

每次对战在 `LOG_DIR` 下生成两个文件：

- `<battleId>.protocol.log`：逐行原始协议，可直接作为回放夹具
- `<battleId>.decisions.jsonl`：完成本地决策时记录 JSON；已取消的旧请求可能没有决策记录，服务器拒绝后的本地修正可能另记一条。主要字段：
  `{ts, kind, turn, rqid, chosen, adjusted, fallback, latency_ms, usage, advisor_usage, advisor_status, advisor_latency_ms, total_latency_ms, context_level, answers, questions, state}`
  - `kind`：`team-preview` / `turn` / `force-switch`
  - `fallback: true` 表示进入整体兜底路径；部分槽位补齐、重复选项修正等还需查看 `adjusted`，不能只凭该布尔值判断
  - `context_level`：配置等级；L3 降级后仍为 `3`，需结合 `advisor_status` 判断是否使用建议
  - `advisor_status`：L3 路径中的 `success` / `unavailable` / `failed`；L1/L2、mock 或未进入 advisor 流程时可省略
  - `latency_ms`：成功返回的 jev 调用耗时；失败/本地兜底可能为 `0`。`advisor_latency_ms`：已返回 advisor 结果的耗时，无结果时可省略。`total_latency_ms`：模型决策流程的本地总耗时，包含 advisor 等待，纯本地路径可省略；不含发送及服务器确认
  - `usage` 与 `advisor_usage`：分别记录 jev / advisor 已返回的 `{cost,input_tokens,output_tokens}`，缺少的值不补算；advisor 用量可省略，mock 的 `usage` 为 `{}`。`state.advisor_analysis` 仅在取得有效建议时包含 `{text,model,latency_ms}`
  - **费用仅统计已知值，不按 token 或模型价目估算**。对局汇总累计已收到的两路有效 `cost`（美元）；超时、失败重试、取消后的迟到结果等可能没有可记录用量，因此汇总不是完整账单，空值或汇总为零不代表远端免费

## 目录结构

```
src/index.ts          CLI（play / validate-team）
src/config.ts         环境变量加载与校验
src/ps/               连接、登录、会话、战斗房间、指令构建、队伍打包
src/state/            协议解析、tracker、request 解析、本地计算、state 序列化
src/decide/           问题模板（preview/turn/force-switch）、答案解析、兜底、编排
src/jev/              Decisions API、OpenRouter advisor、共享截止时间与取消控制
src/dex/              官方 JS/JSON、来源缓存、各表独立本地补字段与空降级
src/match/            多场编排、等待工具、在线队伍检查
```

## 验证记录

`docs/verification.md`：spec §13 不确定项与三级上下文增强两阶段的验证结论与证据（含 L2 上下文注入演示、Champions 世代 Golisopod 基础形态 Bug/Water 的数据事实核对）。
