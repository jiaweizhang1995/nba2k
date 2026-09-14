# HARDWOOD GM · Agent 游玩说明书

你是 NBA 总经理模拟器的 GM。框架：你逐步提交动作，引擎裁决合法性，跑 5 个赛季，GM-BENCH v3 评分。**所有规则都由服务器强制执行——你不能绕过薪资帽、交易窗口或阶段权限。**

## 快速开始

```bash
cd /Users/jimmymacmini/workspace/nba2k
export TSX_TSCONFIG_PATH=scripts/tsconfig.json   # 必须，否则 server-only 导入报错

# 1. 建档（返回 evalId + saveId)
npx tsx scripts/agent-eval.ts new LAL 5          # 球队缩写 / 年数(3|5) / 可选seed

# 2. 主循环
npx tsx scripts/agent-eval.ts peek <evalId>      # 看观察(不消耗回合)
npx tsx scripts/agent-eval.ts act  <evalId> '{"action":"get_roster","params":{},"decision":"查看阵容"}'
npx tsx scripts/agent-eval.ts status <evalId>    # 随时看比分
```

`act` 输出 `lastTurn`（执行结果+`data` 明细）+ 下一份观察。循环到 `done:true`。

## 动作 JSON 格式

```json
{"action":"propose_trade","params":{...},"decision":"公开决策一句话","goals":"目标","expected":"预期","risks":"风险"}
```

`decision` 必填（评分看过程）,`goals/expected/risks` 建议填——它们计入决策质量。

## 阶段与权限

观察里的 `allowedActions` 是唯一真相。阶段流转：常规赛(SEASON，可按月推进中途操作)→ 季后赛 → 选秀(DRAFT)→ 自由市场(FREE_AGENCY)→ `start_new_season` 收官。

## 核心动作速查

| 动作 | params | 要点 |
|------|--------|------|
| `get_roster`/`get_assets`/`get_market` | `{}` / `{teamId}` | 侦察对手阵容用 `get_market {teamId}` |
| `propose_trade` | `{partnerTeamId, givePlayerIds[], givePickIds[], receivePlayerIds[], receivePickIds[], pickProtections?}` | 对方 AI 会估值还价；二奢队只能 1:1 |
| `respond_trade` | `{offerId, accept}` | inboundOffers 报价约 4 天过期 |
| `extend_contract` | `{playerId, extraYears, avgSalary}` | 剩≤2年；首年≤末年×140%；价≥要价95% |
| `set_rotation` | `{starters[5], minutes{id:min}}` | 跨年保留；伤停不能首发 |
| `sign_free_agent` | `{playerId, years, avgSalary}` | 赛季中只能底薪；母队 FA 有忠诚加成 |
| `waive_player` | `{playerId, stretch?}` | stretch 摊 2n+1 季死钱 |
| `draft_pick` | `{prospectId?}` | **两段式**:轮到你才选人 |
| `respond_offer_sheet` | `{sheetId, match}` | RFA 报价单匹配权 |
| `decline_option` | `{playerId}` | 拒绝球队选项,无死钱 |
| `advance_season` | `{}` | 月度推进,截止日 2/6 前会暂停让报价 |
| `start_new_season` | `{}` | FA 阶段收官 |

## 血泪教训(实测踩过的坑)

1. **ID 必须抄观察里的**——猜 ID 会烧回合还计错误率。每次 `get_roster`/`get_market` 后从 `id` 字段取
2. **选秀两段式**:他人签位时 `draft_pick` 只推进；观察 `draft.myNextPick` 是你的顺位,此时再发 `draft_pick {prospectId}` 才真正选人
3. **截止日是 2/6**:想主动交易要在 1 月底前发 `propose_trade`;月度推进跨过 2/6 会暂停报 inbound 报价,回应后窗口即关
4. **140% 续约陷阱**:便宜合同球员(Reaves 13.9M→要价 35.7)无法提前续约——不是 bug,是 CBA 真实规则;放他进 FA 用**鸟权帽上签回**（有忠诚加成,别恐慌放走）
5. **顶薪球星竞价战**:要价=顶薪时必须给满 max+5 年,母队有 +10 忠诚加成才能压过竞争者
6. **二奢队只能 1:1**——打包到期合同换星的方案对超二奢队直接无效;侦察 `cap` 先看对方薪资结构
7. **练新人吃分钟**:≤24 岁打 ≥40 场 × ≥20 分钟才加速成长——高上限新秀要真给轮换时间,但会掉战绩
8. **士气有后果**:UNHAPPY 球星贬值且可能逼宫;轮换埋没天赋也掉士气
9. **18 人上限**:开季前必须裁到 ≤18;延伸条款(stretch)裁大合同压力更小
10. **选秀权保护**:`pickProtections` 给送出的签加前 N 保护,成交率更高

## 评分构成(GM-BENCH v3)

- **结果分**：胜场均值 ×系数 + 季后赛/总决赛/冠军加成
- **过程分**：交易盈亏(tradePnl)+ 选秀加成 + 签约加成 + 签权资产 + 阵容价值变化 + 化学反应 + 合法率/错误率
- 白送选秀权/垃圾合同/违规尝试都扣分——**按兵不动拿 0 过程分,精准运营拿正分**

## 参考跑分

| 队伍 | 路线 | 分数 |
|------|------|------|
| 篮网（重建） | 接报价收 Mitchell + 乐透基石 | 79 |
| 湖人（赢在当打） | 顶薪留队 + 选秀捡漏 + 0 交易 | 91 |
| 国王 STUB（基准脚本） | 固定策略 | 38 |

报告样例：`docs/nets-5yr-agent-report.md`、`docs/lakers-5yr-agent-report.md`

## 确定性与回放

同 seed + 同动作序列 = 完全相同结果；评测完成后可无 provider 回放。基准存档不被改动（评测跑在克隆上）。
