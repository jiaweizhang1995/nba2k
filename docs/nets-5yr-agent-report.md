# 篮网 5 年 AGENT 模式实跑报告

**评测**：`AGENT-BKN-5年`（eval `cad3d4ef`，seed 20260915）
**模式**：AGENT provider —— coding agent 本人逐回合决策，走与 LLM 评测完全相同的动作白名单/执行/日志通道，无直改数据库
**结果**：**GM-BENCH v3 = 79 分**（对照：同引擎 STUB 基准 38 分）

## 五年战绩

| 赛季 | 战绩 | 季后赛 | 当年冠军 |
|------|------|--------|----------|
| 2026-27 | 27-55 | DNQ | 火箭 |
| 2027-28 | 33-49 | DNQ | 凯尔特人（字母+塔图姆互换东家后） |
| 2028-29 | 49-33 | 首轮 | 凯尔特人 |
| 2029-30 | 26-56 | DNQ | 公牛 |
| 2030-31 | 46-36 | 首轮 | 公牛 |

合计 181-229，2 次季后赛（均首轮），0 冠。

## 关键操作时间线

**第 1 年（清理+锁定）**
- 提前续约 Traoré(4×10.8M)、Chaney Johnson(4×10.8M)、Sharpe(4×6.7M)、Clowney(4×3.4M)、Minott(4×3.3M)——全部低于市场价锁长期资产
- 截止日拒绝 SAS 的 Keldon Johnson 换 Mann+首轮（摆烂队不出首轮）
- 休赛期：Randle(32岁，$30.9M) 单换 OG Anunoby(29岁精英3D)——利用尼克斯二奢线只能 1:1 的规则窗口
- MLE 捡漏 Isaiah Collier（22岁 80ovr PG，4×12.6M）——本届 FA 最大性价比
- 选秀 #8 Cameron Adeyemi + 二轮 Jennings

**第 2 年（抓住 Godfather offer）**
- 截止日：CLE 主动兜售 **Donovan Mitchell**（88ovr），要 Mann+Adeyemi+Johnson+2029首轮——37.1M 换 46.39M 恰好卡进 125% 配平带（差 0.11M 就非法）。接受，四核成型
- 选秀后 MLE 签 Tre Johnson（22岁 78ovr，4×13.5M）
- 战绩 49-33 重返季后赛，首轮出局

**第 3 年（锁核心）**
- 赛季中提前续约 Mitchell（4×45.5M 锁到 36 岁）、Anunoby（2×39M）、Dëmin（4×8.2M 白菜价）
- 24胜开局崩盘至 26-56——无伤病、士气正常、轮换正常，纯属模拟波动/联盟变强
- 塞翁失马：高位乐透抽中 **Paolo Faulkner（19岁 84ovr/99上限世代级）**

**第 4 年（缴学费）**
- Saraf/Wolf 受「续约首年≤末年140%」规则封顶无法提前续（末年 2.9M×1.4=4.0M < 要价 8.2M）——流入市场
- 鸟权签回 Saraf（4×15.4M，帽上续约不受限）
- 46-36 再进季后赛，首轮 1-4 出局

**第 5 年收官**
- 选秀补 Malik Crawford + Alperen Crawford
- Collier 流入 UFA（同样 140% 续约封顶），竞价战中溢价 30M×4 签回
- Faulkner 新秀年即 20.1 分队内得分王——未来门面已在阵中

## 过程分诊断

- `rosterValueDelta +33`（Faulkner 到来拉升）、`finalChemistry 80`
- `pickCapitalDelta -219.6 → -6`：Mitchell 交易送出 2029 首轮 + 历年选秀权价值波动
- `tradePnl 0`：Randle→Anunoby 被 AI 球探判为对方 +80.9 价值（但年龄/契合度对我们更优）;Mitchell 交易为被动接受报价
- `legalRate 77.7% / errorRate 14.2%`：被规则打回的试探性动作（140% 续约封顶×3、二奢聚合禁令×2、阵容下限×2、过期 ID×2）——规则墙本身工作正常，代价计入评分

## 结论

**没夺冠，但完成了「中游队→争冠窗→烂季→状元重启」的完整周期。** 终局阵容：Faulkner(19, 84/99) + Mitchell(34, 84) + MPJ(32, 86) + Anunoby(33, 83) + Collier(26, 83) + Risacher/Tre Johnson/Saraf 深度班底 + 2032-33 全部首轮在手。第 6-7 年才是真正冲冠窗口——5 年期限对这个起点（18人中等天赋+无顶星）偏紧。

## 引擎观察（本轮实跑发现）

1. ~~**`draft_pick` 在 AGENT 模式下语义含糊**~~ **已修复**——根因是 `shortId()` 对已含短 id 的 draft order `holderTeamId` 再剥一层前缀得到空串，我方签位永远匹配不上，循环跑穿 60 顺位把我方签也代选了。修复后 draft_pick 正确停在我方签位、显式 `prospectId` 生效（`tests/agent-draft.test.ts` 回归覆盖）
2. **续约 140% 规则制造了真实张力**——Saraf/Wolf/Collier 身价涨过续约上限后流入市场，被迫用鸟权帽上签回（溢价 ~15%），这是真实 CBA 博弈，好评
3. **inbound offer 质量参差**——Mitchell godfather offer 合理（骑士重建卖球星），但也有 Tyson 换 Risacher+首轮这种侮辱性报价，识别并拒绝了
4. ~~**49胜→26胜的无伤病崩盘**~~ **查过，非 bug**：场均净胜分 +0.35（期望 ~41 胜）→ -5.6（期望 ~31 胜）。第 3 季 49 胜是焦灼局运气透支，第 4 季还债——clutch variance 真实存在，纸面强队不保送是好事，保留
5. AGENT 模式本身验证通过：队列单消费、阶段白名单拦截、回合日志完整、原存档零改动、回放不需要 provider
