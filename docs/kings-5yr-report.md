# 国王队 5 年经营报告（AI GM 实机模拟）

**存档**：真实 NBA 2026-27（种子 20272027，30 队 / 539 名真实球员）
**GM**：Devin（通过游戏 API 执教萨克拉门托国王）
**时间跨度**：2026-27 → 2030-31，共 5 个赛季

---

## 结论

**未能夺冠。5 年 0 次季后赛，队史最佳战绩仅为 35-47。**

| 赛季 | 战绩 | 季后赛 | 该季总冠军 |
|------|------|--------|-----------|
| 2026-27 | 24-58 | 未进 | 俄克拉何马城 雷霆 |
| 2027-28 | 35-47 | 未进 | 俄克拉何马城 雷霆 |
| 2028-29 | 25-57 | 未进 | 俄克拉何马城 雷霆（三连冠） |
| 2029-30 | 32-50 | 未进 | 多伦多 猛龙 |
| 2030-31 | 23-59 | 未进 | 俄克拉何马城 雷霆 |

同期联盟格局：OKC 五年四冠建立王朝（SGA 91 评分），西部第 8 的门槛大约在 40 胜——国王从未接近。

## 操作记录

- **2026 休赛期**：Hunter → 绿军换 Derrick White（81 OVR 控卫，解决全队无 PG 的死穴）
- **2027 休赛期**：底薪签 Ace Bailey（77，21 岁）、MLE 12.8M 签 Mitchell Robinson、3.5M×3 签 Brandon Williams
- **2028 休赛期**：自由市场被 AI 抢空（见下），无收获
- **2029 季中**：Monk + B.Williams + Achiuwa → 火箭换 Jabari Smith Jr.（81）+ Capela + Shamet + 2033 次轮（净胜 +9.46 价值）
- 每季手动设定首发与分钟分配（White/LaVine/Bailey/Jabari/Sabonis 收官版）

## 为什么赢不了（诚实复盘）

1. **起点天花板太低**：国王最强 LaVine 84 / Sabonis 81，而争冠队标配 87+ 超巨（SGA 91、Luka 91、Maxey 91、Wemby 89）。阵容深度补再多 76-79 的球员，顶不动顶层战力差。
2. **交易市场结构性冻结**：休赛期全员续约+自动填员后，所有队都卡在 13 人下限——单球员报价只能换回 1 人，而 15M+ 薪资的"可弃球员"几乎不存在，导致大多数报价返回 0。只有 14 人以上阵容的球队能合法做大包交易，且他们也只愿意出边角料。
3. **自由市场对玩家不公平**：选秀一结束 `startFreeAgency` 原子性地把每支缺人球队自动填到 13 人——2028 年绿军用底薪白捡 Curry + MPJ + Amen Thompson（三人合计 85/85/84 评分，各 1.2M）。等玩家进入 FA 阶段，池子只剩 75 以下的剩菜。
4. **没有新秀池**：真实数据存档不含选秀球员，5 年 4 届选秀全部 60 签位跳过，选秀权沦为纯交易筹码且换不到球星。
5. **核心老化**：收官时 White 37、LaVine 36、Sabonis 35，全部退化到 77-79；唯一的收获是 Jabari 成长到 81 成为队内最佳。

## 顺手修掉的 4 个真 bug（已改代码，typecheck 通过）

1. `submitFaOffer`：`phaseState.userTeamId` 是全量 ID（`saveId:SAC`），`toTradeTeam` 又拼一次前缀 → 任何 FA 报价必报 NO_TEAM。已修为拆短 ID（engine.ts）。
2. `startNewSeason`：`phaseState: null` 把 userTeamId 和 rotation 全清，导致新赛季后"忘记执教球队"。已改为保留 userTeamId。
3. `eval` 熔断器：注释写"连续 3 次失败"，实现却是"累计 3 次"——长跑必死。已改为真正判定连续（eval.ts）。
4. `eval` 观察缺球员 ID：LLM 永远无法合法调用 `sign_free_agent`。已给 get_market 的 FA 列表补上 id；顺带把回合 token 预算 1200→2048 防 reasoning 模型截断。

## 还想吐槽的设计缺陷（未改）

- `startFreeAgency` 的自动填员让 AI 队零成本捡超巨，玩家只能捡剩——FA 阶段对玩家基本无意义。
- `SEASON` 模式一口气推进时不会记录 CHAMPION 奖项（`findChampion` 只在从 PLAYOFFS 进 OFFSEASON 时跑），拆成 REGULAR_SEASON + PLAYOFFS 两段才正常。
- 无裁员机制 + 薪资配平刚性 → 大合同球星（LaVine 47.5M / Sabonis 43.6M）从第二局起实际上不可交易。

*Bottom line：这套引擎里，国王这种"无超巨+深度尚可"的队，在没有选秀产出和公平 FA 的环境下，5 年内无法逆天改命。想夺冠需要开局就有 87+ 核心的队，或者等引擎把交易市场和新秀池做活。*

---

## 附：吐槽过的缺陷已全部修复（本轮修复记录）

1. **SEASON 模式漏记冠军** — `advanceSim` 现在在任何进入 OFFSEASON 的推进中都跑 `findChampion` + `recordAwards`，不再只在 PLAYOFFS 起跑时记录。
2. **FA 抢人 / 阵容冻结** — `startFreeAgency` 的自动填员只签综合 <72 的底薪填充员，优质自由球员保留给玩家窗口；`startNewSeason` 新增市场价补强 pass（工资帽空间 → 中产 12.8M → 仅低评分球员接底薪），AI 球队填到 15 人，交易市场解冻。
3. **裁员机制** — 新增 `POST /api/saves/[id]/roster {action:"waive", playerId}` 与阵容页「裁掉」按钮；剩余保障合同逐年计入 `phaseState.deadCap`，capSnapshot/交易配平/FA 报价都吃死钱，账目诚实。
4. **真实数据选秀池** — 每次进入选秀时确定性生成 60 人合成新秀池（`generateDraftClass`，种子+赛季派生），含位置/评分/潜力区间/球探报告；`getDraftBoard`/`makeDraftPick` 会自愈旧存档的选秀阶段。
5. **AI 评测 agent 化** — 观察数据全量补 ID（阵容/市场/资产/选秀权/新秀），新增 `allowedActions` 提示、`waive_player` 动作与 `POST /api/eval/[id]/run` 一键跑完端点；另修复克隆存档时 awards 表 ID 拼接导致的 UNIQUE 冲突。
