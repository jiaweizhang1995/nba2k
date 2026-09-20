# HARDWOOD GM · Agent 游玩说明书

你是 NBA 总经理模拟器的 GM。框架：你逐步提交动作，引擎裁决合法性。**所有规则都由服务器强制执行——你不能绕过薪资帽、交易窗口或阶段权限。**

## 快速开始

对局通过 `nba-gm` MCP 服务器（`scripts/mcp-gm-server.ts`）操作真实存档，与 Web UI 同源。不用跑 shell、不用手写 SQL：

- `gm_new {team}` 开新档 / `gm_use {saveId}` 接续既有档
- `gm_observe` 看观察（免费），`gm_status` 看比分
- `gm_act {action, params, note?}` 执行一个动作，返回结果 + 新观察
- `gm_auto {maxSteps?}` 托管推进，到决策检查点自动停

## 动作格式

`gm_act` 的 `params` 直接写人名/队缩写/签位描述（`"Collin Sexton"`、`"LAL"`、`"LAL 2027 R1"`），服务端解析成稳定 ID；解析失败返回候选且不执行。`note` 可选，写进游戏事件流。

## 阶段与权限

观察里的 `allowedActions` 是唯一真相。阶段流转：常规赛(SEASON，可按月推进中途操作)→ 季后赛 → 选秀(DRAFT)→ 自由市场(FREE_AGENCY)→ `start_new_season` 收官。

## 核心动作速查

| 动作 | params | 要点 |
|------|--------|------|
| `propose_trade` | `{partnerTeamId, givePlayerIds[], givePickIds[], receivePlayerIds[], receivePickIds[], pickProtections?}` | **对方接受即执行**；二奢队只能 1:1 |
| `preview_trade` | 同 propose_trade | **干跑不执行**：返回规则校验 + 对方 GM 估值反馈，谈交易前先过一遍 |
| `request_offers` | `{gives[{kind,id}]}` | 挂包裹收全联盟报价；DRAFT/FA/OFFSEASON 也可用 |
| `respond_trade` | `{offerId, accept}` | inboundOffers 报价约 4 天过期 |
| `extend_contract` | `{playerId, extraYears, avgSalary}` | **两参数必填**；剩≤2年；首年≤max(末年, 联盟均薪)×140%；价≥要价95% |
| `set_rotation` | `{starters[5], minutes{id:min}}` | 跨年保留；伤停不能首发 |
| `sign_free_agent` | `{playerId, years, avgSalary}` | 赛季中只能底薪；母队 FA 有忠诚加成 |
| `waive_player` | `{playerId, stretch?}` | stretch 摊 2n+1 季死钱 |
| `draft_pick` | `{prospectId?}` | **两段式**:轮到你才选人 |
| `respond_offer_sheet` | `{sheetId, match}` | RFA 报价单匹配权 |
| `decline_option` | `{playerId}` | 拒绝球队选项,无死钱 |
| `exercise_option` | `{playerId}` | 显式执行球队选项,锁定该年 |
| `advance` | `{scope?}` | 常规赛月度推进,截止日 2/6 前暂停让报价；**季后赛默认每轮一停**（R1→半决→东/西决→总决赛），`scope:"ALL"` 一次打完整个季后赛 |
| `start_new_season` | `{}` | FA 阶段收官 |

侦察动作用免费工具代替：`gm_teams`/`gm_roster`/`gm_find`/`gm_pool`/`gm_picks`/`gm_resolve`/`gm_events`。

- `gm_pool {status, pos?, minOvr?, maxSalary?, limit?, offset?}`：浏览 FA/新秀/在册全池,带过滤分页——观察里的名单只显示前 20,完整的从这里翻。
- 季后赛观察含 `playoffs` 块：`currentRound`（当前轮次）、`myStatus`（ALIVE/ELIMINATED/NOT_IN）、`series`（每组对阵+比分）。`gm_auto` 在季后赛默认每轮一停，想直通总决赛传 `playoffMode:"all"`。
- 阵容行的 `tradeLock` 字段标交易锁（`LOCKED_UNTIL_<日期>`=本赛季新签锁到 12/15，`NO_TRADE_CLAUSE`=不可交易条款）；`gm_picks` 的持有签带 `tradeable`/`tradeBlock`（Stepien 锁定原因直出）。

## 血泪教训(实测踩过的坑)

1. **ID 必须来自观察或侦察工具**——写名字让服务端解析；解析失败零成本，猜错 ID 会被引擎拒绝
2. **选秀两段式**:他人签位时 `draft_pick` 只推进；观察 `draft.myNextPick` 是你的顺位,此时再发 `draft_pick {prospectId}` 才真正选人
3. **截止日是 2/6**:想主动交易要在 1 月底前发 `propose_trade`;月度推进跨过 2/6 会暂停报 inbound 报价,回应后窗口即关
4. **140% 续约陷阱**:续约首年上限 = max(末年薪资, 联盟均薪)×140%。便宜合同球员(Reaves 13.9M→要价 35.7)即使走均薪支腿也够不到要价——放他进 FA 用**鸟权帽上签回**（有忠诚加成,别恐慌放走）
5. **顶薪球星竞价战**:要价=顶薪时必须给满 max+5 年,母队有 +10 忠诚加成才能压过竞争者
6. **二奢队只能 1:1**——打包到期合同换星的方案对超二奢队直接无效;侦察 `gm_roster` 先看对方薪资结构
7. **练新人吃分钟**:≤24 岁打 ≥40 场 × ≥20 分钟才加速成长——高上限新秀要真给轮换时间,但会掉战绩
8. **士气有后果**:UNHAPPY 球星贬值且可能逼宫;轮换埋没天赋也掉士气
9. **18 人上限**:开季前必须裁到 ≤18;延伸条款(stretch)裁大合同压力更小
10. **选秀权保护**:`pickProtections` 给送出的签加前 N 保护,成交率更高

## 确定性

存档带 seed，引擎模拟是确定性的。所有状态实时落在 `data/nba2k-gm.db`。
