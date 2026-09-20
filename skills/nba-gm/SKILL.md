---
name: nba-gm
description: 与用户协作游玩 NBA GM 模拟器；可开新存档、接续既有存档、观察盘面并逐回合执行动作。
---

# NBA GM 协作游玩

项目目录 `/Users/jimmymacmini/workspace/nba2k`。对局通过 `nba-gm` MCP 服务器操作（`.devin/mcp_config.json` 已注册，stdio 直连 `src/server/engine.ts`，操作**真实存档**——与 Web UI 同源，无评测层、无回合上限）。**不要跑 `npx tsx scripts/agent-eval.ts`，也不要手写 sqlite3**。

默认分工：用户负责交易、选秀、重大签约和球队方向；agent 负责侦察、提出带风险的方案、执行已授权的日常操作。

## 工具速查

| 工具 | 用途 |
|---|---|
| `gm_new {team, name?, seed?}` | 开新存档（真实游戏档），返回 saveId+首份观察并记为当前对局 |
| `gm_saves` / `gm_use {saveId?}` | 列出存档 / 切换当前对局 |
| `gm_delete {saveId, confirm:true}` | 删档（不可恢复） |
| `gm_observe` | 当前盘面：phase/allowedActions/阵容/帽/报价/事件；DRAFT 带选秀板、FA 带自由球员池 |
| `gm_act {action, params, note?}` | 执行动作：阶段白名单+ID 解析校验 → 引擎执行 → 返回结果+新鲜观察；note 写入游戏事件流 |
| `gm_auto {maxSteps?, autoPick?, finishFa?}` | 托管推进，到决策检查点自动停（来报价/轮到我选秀/阶段切换） |
| `gm_teams` / `gm_roster {teamId?}` / `gm_find {query}` / `gm_picks {teamId?}` / `gm_resolve {names[]}` | 侦察：联盟概况/单队阵容+合同+签位/搜人/选秀权/名字→ID 预览 |
| `gm_status` / `gm_events {limit?, category?}` | 战绩+赛程+冠军史 / 游戏事件流 |

所有 saveId 参数可省略（服务器记当前对局，存于 `data/.gm-current.json`）。

## 规则

- `gm_act` 的 params 可直接写人名/缩写/描述（`"Collin Sexton"`、`"LAL"`、`"LAL 2027 R1"`），服务端解析成稳定 ID；解析失败返回候选且不执行。动作必须在观察的 `allowedActions` 内（按存档 phase 过滤）。
- 决策检查点必须停下用中文说明局面 + 推荐方案 + 备选 + 风险，等用户拍板：交易截止日（2/6）前后、轮到我方选秀（draft.myNextPick）、自由市场开启、季后赛、inboundOffers/offerSheets 非空。用户明确说"托管本月/本阶段"后才用 `gm_auto`。
- `gm_auto` 的 `autoPick`（替我选秀）和 `finishFa`（跳过自由市场直接收官）需用户明确授权才开。
- 规则与策略细节（两段式选秀、140% 续约陷阱、鸟权帽上续约、二奢队 1:1、18 人上限、签位保护、底薪赛季中签约等）按需读 `docs/agent-playbook.md`。
- 交易被拒时保留返回里的价值差反馈（`feedback[].verdict.valueDelta`）——那是对方 GM 的精确价差，用来微调下一份报价；不要盲目重复同一报价。
- MCP 服务器若未加载（本会话启动早于配置写入），先告知用户重启会话让 `nba-gm` 工具出现，不要退回到 shell/直读 SQLite。
