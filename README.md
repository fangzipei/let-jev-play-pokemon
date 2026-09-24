# jev-poke

用 OpenRouter Decisions API（jev 模型，`~typesafe/jev-latest`）自动打 Pokémon Showdown 的机器人：连接官方 WebSocket 协议读取完整对战信息，在每个决策点（team preview / 回合行动 / 强制换人）把结构化问题（noul / choice / score）发给 jev，并把返回值转换为 `/choose` 指令自动对战。

- 赛制：`gen9championsvgc2026regmc`（Champions VGC Reg M-C：双打、6 选 4、每场一次 Mega）
- 每个有效决策点将问题合并为一批交给 jev；重试和 SDK→fetch 回退可能产生多次尝试，mock、取消或本地降级也可能不调用 API；L3 还会先尝试 advisor 分析
- 所有等级与决策阶段都明确以整局胜利为目标，每次携带本局累计摘要和近 3 个完整回合＋当前回合的双方事件，不依赖模型自动记住之前的请求
- 默认 L2 上下文：完整客观信息 + 条件化战术注解；本地速度估计、属性倍率和粗伤害均标明适用范围与未知项
- L2 起注入对手上下文：已确认信息与最近动作、统计先验（pokechamdb 每日快照：使用率 top + 英文效果说明）、跨局经验条目；缺失时静默降级
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
| `JEV_PIKA_ENABLED` | `0` | 已停用（决策先验由 pokechamdb 每日快照供应）：默认不拉取、不注入；`1` 临时恢复 play 启动预拉与向对手注入统计假设 |
| `JEV_PIKA_CUTOFF` | `1760` | Pikalytics 使用率 cutoff（仅 `JEV_PIKA_ENABLED=1` 时生效）；须为正安全整数 |
| `JEV_PIKA_DIR` | `.cache/pikalytics` | （仅停用路径使用）Pikalytics 先验缓存目录（按 dataDate 失效，不入库） |
| `JEV_CHAMDB_DIR` | `.cache/pokechamdb` | 决策统计先验来源：物种使用率与英文效果说明快照（不入库）；`npm run chamdb:refresh` 读写，对局期只读 |
| `JEV_CHAMDB_TTL_HOURS` | `24` | 重复运行 `chamdb:refresh` 的最小回源间隔（小时，仅对物种快照生效，notes 文件存在即跳过），须为正数 |
| `JEV_MEMORY_DIR` | `.cache/jev-memory` | 跨局经验库目录（不入库）；`npm run review` 读写 |
| `JEV_REVIEW_MODEL` | （空） | `npm run review` 的复盘模型 id；留空 = 仅规则提取 |
| `JEV_REVIEW_API_KEY` | （空） | 留空或仅空白时复用 `OPENROUTER_API_KEY` |
| `JEV_REVIEW_MAX_TOKENS` | （空） | 复盘单次输出上限（含推理 token）；留空或仅空白 = 不发送 `max_tokens`（不限制）；设置须为正安全整数 |
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

三个超时/预算变量必须是 `1` 至 `2147483647` 的整数毫秒数；非法值在启动校验时拒绝，不静默回退。`JEV_RETRY` 必须是非负安全整数。`JEV_ADVISOR_MAX_TOKENS` 与 `JEV_PIKA_CUTOFF` 必须是正安全整数；非空 `JEV_REVIEW_MAX_TOKENS` 必须是正安全整数（留空或仅空白表示不限制）。非空 `JEV_ADVISOR_REASONING` 必须是 `low`、`medium` 或 `high` 之一。`JEV_CHAMDB_TTL_HOURS` 必须是正数（小时）。非 mock 正常启动仍要求主 API key；独立 advisor key 不能代替 jev 主 key。

## 三级上下文与预算

- **L1：完整客观上下文**。保留当前可获得的我方队伍/在场/替补、招式与请求状态，对手预览与已揭示信息、天气/场地、能力阶级及近期协议记录；增加双向属性倍率、速度估计与已揭示招式的来袭粗估，不添加角色注解或 advisor 建议。“完整”不包含对手隐藏信息，缺失值保持 unknown/null。
- **L2（默认）：L1 + 条件化战术注解**。注解由当前 request 的招式、道具、特性、HP、天气/场地与 Mega 状态真实驱动（含 move 选项级机制注解与队伍级高频战术注解）；并向每只对手注入 `notes`（已确认信息、最近动作、统计先验、跨局经验，见下节），preview 在统计来源提供首发倾向时附加引导。不是无条件粘贴固定六只的战术结论。不会新增 advisor 请求，但不保证 jev 的 token 用量或延迟不变。
- **L3：L2 + OpenRouter advisor 实时分析，再交 jev**。advisor 使用 Chat Completions，读取同一份决策快照及合法选项；有效分析最多保留 120 个英文词，加入状态与问题指令。jev 仍作最终选择，之后继续本地动作合并与校验。advisor 不可用、失败或超时而总预算尚有剩余时，按 L2 上下文继续；总预算耗尽则尝试本地兜底，已取消的旧请求不再发送动作。

每次模型请求的 `state.battle_context` 包含：
- `summary`：本局已确认参战、倒下、揭示招式/道具/特性、道具终止记录、Mega 使用情况与当前场地控速；我方名单、HP、道具与可用 PP 以当前 request 为准。对手实际带入/剩余总数未知时保留 `null`，只报告已确认下界；预览候选和 `teamsize` 不直接当作选出名单。
- `recent_turns`：最近 3 个完整回合及当前未完成回合的双方服务端事件。保留动作、不能行动、伤害/回复、换人和关键效果，过滤聊天、HTML、原始 request 等噪声；本地选择不是成功执行，动作先后也不保证之后的速度顺序。
- 历史有容量限制：每回合最多 48 条、每条最多 240 字符，事件总计最多 8000 字符，历史字段 JSON 最多 10000 字符。裁剪、缺失边界与无历史均明确标注，不补造；长期已揭示事实不依赖近 3 回合窗口。兼容字段 `recent_log` 取清洗后事件的最后 10 条。

选队、出招、强制换人的提示词均要求结合残局目标、关键成员和资源、控速剩余回合判断，而非只追求当前伤害。L2/L3 使用同源状态，并在首次异步等待前固定快照；该功能不新增模型请求，也不保存模型隐藏推理或虚构长期计划，但输入 token 和延迟可能增加，是否改善实战判断需另行验证。

我方速度以 request 实际数值为基准，只应用已支持且可确认的修正；**种族速度不能与实际速度直接比较**，对手实际速度与出手顺序保持 unknown。Trick Room 只反转同优先度内的速度顺序；Electroweb 在空间下可能帮助对手先行动。沙暴会结束、被替换或压制；Sucker Punch 依赖目标选择攻击且尚未行动，Focus Sash 依赖满 HP 等条件；Mega 前后特性不能混用。潜在 STAB 仅是属性威胁，不代表对手已知招式；粗伤害即使写成百分比，也不是经过校准的实际 HP% 预测。

默认 advisor 最多等待 10s，随后 jev 最多使用其 20s 共享预算，两者同时受当前请求 35s 总截止时间约束；总预算也适用于 L1/L2。SDK→fetch 和重试均不重置截止时间。这里约束的是本地等待与后续请求启动，不是服务端计时器或端到端发送成功的保证。**本地超时/取消不保证远端停止处理或不计费**；模型可用性、真实延迟、质量和账单须另行验证。

## 对手先验与跨局经验

L2 起每只对手宝可梦在 `state` 中带上 `notes`（仅非空字段出现）：`confirmed` 局内已确认的配置与形态，`recent_actions` 最近两回合的实际动作与结果，`assumed` 统计先验（pokechamdb 每日快照：使用率 top 与英文效果说明），`memory` 跨局经验条目。先验与经验仅作决策辅助，缺失时静默降级，不影响决策流程。

- **pokechamdb 统计先验（默认）**：`npm run chamdb:refresh` 把双打前 N 名（默认 100）物种的使用率分布（items/abilities/moves）与站点英文效果说明（notes）持久化到 `JEV_CHAMDB_DIR`；play 启动只读本地缓存，对局期零站点访问。先验条目带 `(prior: pokechamdb <season> <format> <date>)` 来源标记，与局内已确认信息严格区分；moves/abilities/items 附使用时占比与效果 gloss，Mega 石按所配形态（X/Y/Z）校验避免多形态误配；该来源暂无首发倾向（leads），preview 不产生对应的先验行。缓存缺失或不足时静默降级。
- **Pikalytics 先验（已停用）**：2026-09-24 起默认关闭（`JEV_PIKA_ENABLED=1` 可临时恢复，经适配器输出同一先验结构）。原行为：play 启动时按 `PS_FORMAT` 与 `JEV_PIKA_CUTOFF` 拉取使用率榜单，详情端点顺序节流补全；缓存按 dataDate 存放于 `JEV_PIKA_DIR`（赛制不符不作为有效结果，仅网络完全不可用时退回最新缓存），preview 附对手首发倾向（leads 占比 top-3）。任何拉取失败都静默降级；先验是统计概括，不代表对手实际配置。
- **跨局经验库**：`npm run review` 扫描 `LOG_DIR` 下的 protocol 日志增量入 `JEV_MEMORY_DIR/memory.json`（规则统计按 battleId 幂等去重），按物种与两两组合累计对局数、胜负与已揭示配置；配置 `JEV_REVIEW_MODEL` 时再由模型提炼模式级经验：默认不发送 `max_tokens`（不限制推理与输出），让模型自由推理后按严格 JSON 输出（每物种/组合至多保留 3 条）。review 不自动执行，`--dry-run` 不写库、不调用模型。
- **模型补跑与计数**：模型进度独立于规则统计；失败或键匹配异常保持待复盘，下一次普通 `review` 自动补跑，成功批次逐批保存。合法空结果标记为“未发现可重复模式”，不反复付费重试；格式错误不会伪装成 0 条成功。日志区分返回、实际新增、重复、未匹配和超限丢弃数量。
- **旧库兼容**：旧库没有模型进度，默认不自动重跑历史对局。`--retry-model` 显式重新提炼全部可读取的有效日志（包括已成功的对局，会产生模型调用费用），不重复累计战绩，可先与 `--dry-run` 合用预览。历史昵称统计不猜测迁移；日志确认的正确物种若缺少统计记录，可单独保存经验并标记“配置统计不可用”。

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
npm run review                    # 规则增量入库；配置模型时补跑待复盘对局
npm run review -- --dry-run       # 只统计本次将处理的对局，不写库、不调用模型
npm run review -- --retry-model --dry-run # 预览全部历史日志的模型补跑范围
npm run review -- --retry-model   # 重新提炼全部有效日志，产生模型费用，不重复累计战绩
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
src/index.ts          CLI（play / validate-team / review）
src/config.ts         环境变量加载与校验
src/ps/               连接、登录、会话、战斗房间、指令构建、队伍打包
src/state/            协议解析、tracker、request 解析、本地计算、state 序列化、对手笔记
src/decide/           问题模板（preview/turn/force-switch）、答案解析、兜底、编排
src/jev/              Decisions API、OpenRouter advisor、共享截止时间与取消控制
src/dex/              官方 JS/JSON、来源缓存、各表独立本地补字段与空降级、pokechamdb 统计先验（Pikalytics 适配保留）
src/learn/            日志观察提取、跨局经验库读写与查询、review 编排
src/match/            多场编排、等待工具、在线队伍检查
```

## 验证记录

`docs/verification.md`（本地资料，不随仓库提交）：spec §13 不确定项与三级上下文增强各阶段的验证结论与证据（含 L2 上下文注入演示、多轮实战对局记录与 Champions 世代数据事实核对）。
