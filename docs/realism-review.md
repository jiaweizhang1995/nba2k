# HARDWOOD GM 代码与真实性 Review（只读）

Review 日期：2026-09-14
范围：领域层规则、比赛/赛季模拟、server 引擎、API、数据导入、测试覆盖
验证：`npm test` 实测通过（13 文件 / 133 测试 / 1 跳过 GLM smoke）；未改任何代码

---

## 总体结论

架构健康：纯函数领域层 + 确定性 PRNG（`xmur3`/`mulberry32`，seed+salt 可回放）+ 服务端事务 + 完整审计日志 + 每步规则校验。对"可回放、可评测"的模拟器是正确选择，测试覆盖在同类项目中属上乘。

真实性层面的主要问题是：若干子系统的规则与现实 NBA 有结构性偏差（交易匹配、乐透、成长），另有 1 个规则绕过漏洞需要优先修。

注意：本项目的 CBA 是**有意简化的虚构规则**（`LEAGUE CBA v1.1`，`src/domain/salary.ts:1-3`），下文区分"内部一致性问题"与"对真实 NBA 的偏差"。

---

## 高优先级：缺陷级

### 1. 交易窗口可被用户 `note` 字段绕过

`src/server/engine.ts:1308-1321`：用 `opts.note === "AI 交易截止日"` / `"AI 休赛期交易"` 判断是否 AI 市场交易 → 跳过 WINDOW 检查并把校验日期换成 `${season}-02-06`。

而 `src/app/api/saves/[id]/trade/route.ts:11` 把用户可控的 `body.note`（schema 允许任意 200 字符）直接传进 `opts.note`。

→ `POST /api/saves/:id/trade` 带 `note: "AI 交易截止日"` 即可在截止日后/季后赛期间成交，普通模式无需 God Mode。`tests/agent-realism.test.ts` 断言"截止日后 WINDOW block"能过，但旁路一直存在。

修法建议：AI 市场调用走不可从 schema 进入的内部 flag（`allowPostDeadline` 已是这种模式），不要用 note 文本做权限判断。

### 2. 工资帽空间在交易中完全不可用

`src/domain/salary.ts:157-159`：

```ts
if (!teamSnapshot.overCap) {
  const limit = round2(out * CBA.tradeBand1 + 0.1);  // 送出 × 1.5 + 0.1
```

`capSpace` 没进公式。帽下 $40M 空间的球队只送选秀权（out=0）只能吃回 $0.1M。真实规则是 `incoming − outgoing ≤ capSpace + 0.1M`——帽下球队可以整份吞下大合同换资产（重建队核心玩法）。当前实现里帽下球队反而比帽上球队更受限制，注释 "practically unlimited by cap room" 与实际行为相反。

`generateTradeOffers` 里 AI 报价侧的 `minOut` 用了同一个 band，AI 也无法发起"空间换资产"交易——规则修正后两处会同时解锁。

---

## 中优先级：真实性差距

### 3. 乐透抽签抽满 14 个顺位

`src/domain/draft.ts:103-130`：真实乐透只抽前 4，5-14 按战绩排。这里 14 个顺位全部不放回加权采样 → **战绩最差队可能跌到第 14 顺位**（现实中最差掉到第 5），摆烂方差远大于真实 NBA。

附带两个小问题：
- 乐透池取"战绩最差 14 队"——两分区不平衡时一支季后赛队可能进乐透（真实规则只有非季后赛队进乐透）。
- `draft.ts:106` `pool` 变量是死代码（`void pool`）。

### 4. 真实球员不会成长——`growthLeft` 是死数据

`src/domain/sim/season.ts:614`：潜力成长分支要求 `p.ratings.potential != null`。真实导入数据该字段恒为 null；`seedDevelopmentEstimates`（`src/server/engine.ts:296-308`）只写了 `development.growthLeft`——而 `applyDevelopment` 从不读这个字段，`season.ts:642` 还会在首个休赛期把它重算为 0。

→ 19 岁真实新星和 28 岁板凳走同一通用分支（40% 概率 +0..2）。只有合成选秀班（`generateDraftClass` 会写 `ratings.potential`）能正常成长——多年模拟里联盟系统性偏向选秀班，真实年轻球员停滞。UI 上展示的"剩余成长空间"对真实球员是误导。

### 5. 底薪签约对用户基本不可用（不对称）

`src/domain/freeagency.ts:35`：合同到期后 `years` 被过滤为空 → `prev` 兜底 5 → anchor ≈ 4.5M。**所有到期球员（含落选秀）要价 ≥4.5M**；叠加 `evaluateOffer` 冷市场 0.75 下限（`freeagency.ts:101-105`）→ 用户开 1.2M 底薪必被拒。

而 AI 的 filler 签约路径（`startFreeAgency` / `runAiFreeAgencyDay`）不经过 `evaluateOffer`，同样的球员 AI 用底薪随便签。用户签底薪只剩赛季中通道（强制底薪）。现实中底薪合同占签约量很大一块。

### 6. Stepien 规则只查本次交易内

`src/domain/trade.ts:271-288`：只检查 `givePicks` 中有无连续年份自家首轮。真实规则是状态性的：已送走 2028 首轮的球队不能再送 2029 首轮。当前实现允许跨交易制造连续两年无首轮——Stepien 防的正是这个。需要把已送出的未来首轮纳入检查。

### 7. 工资帽下限定义了但从未执行

`salary.ts:38` `minTeamSalary: 126`（cap 的 90%），`seasonMoney` 有输出，但全库无任何检查。重建队可长期跑极低阵容零惩罚——真实 NBA 低于下限要补缴差额，摆烂有成本地板。

---

## 低优先级：简化项与可打磨点

| 项 | 位置 | 评估 |
|---|---|---|
| 无背靠背 | `season.ts` `SEASON_MIN_REST_DAYS=2` | 测试里明确作为设计断言；但 B2B/疲劳机制（`backToBack`、stamina 消耗）因此永远触发不了，恢复 +0.25/天远大于比赛消耗，stamina 恒≈1，疲劳系统基本是摆设 |
| 无附加赛 | `maybeEndRegularSeason` | 前 8 直接进季后赛，简化可接受 |
| **Chemistry 分数纯展示** | `chemistry.ts` | `computeChemistry` 只被 `getChemistry`（UI）调用；game/season/aiGm 零引用。注意 morale(satisfaction) 真实影响比赛（`game.ts:336-347`，±~5% 团队效率），但七因子分数本身不影响任何东西——UI 上有个不做任何事的指标 |
| 首轮新秀合同逐年降 5% | `draft.ts:155` `first * (1 - i*0.05)` | 真实新秀合同逐年递增，方向反了；且整份 4 年挂一个 TO，真实是 2 保障 + 2 球队选项 |
| 140% 续约缺第二支腿 | `extendContract` | 真实规则是 max(140% 末年薪, 140% 联盟均薪)；缺后者导致廉价合同的球星无法按市价续约（playbook 已注明是"陷阱"） |
| 总决赛主场按联盟顺序 | `mk("FINALS", winners[0], ...)` | 东区冠军永远有主场优势，不看战绩 |
| 犯规细节 | `game.ts` | 非投篮犯规 5.5%/回合与防守评分无关；团队犯规 bonus 阈值 `>5` 实为第 6 犯起（真实第 5 犯即入 bonus），差一 |
| AI 休赛期重签绕过 Dec-15 冻结 | `prepareDraft` 中 `signedSeason: state.season`（旧赛季号） | 用户休赛期签约 `signedSeason=新赛季` 会被冻结到 12/15，AI 重签不会——不对称 |
| 拒绝球队选项 → 变 RFA | `declineOption` | 真实 NBA 拒选项后是完全自由球员，这里母队仍有匹配权 |
| `makeDraftPick` 用 `pickRow[0]` 销记 | `engine.ts` | 同一持有方同轮多签时 `resolved` 顺位可能记到错的原始签行上，纯账务问题 |
| `deleteSave` 漏删 eval 数据 | `engine.ts:322-336` | `evaluations/evalTurns/evalSeasons` 变孤儿行 |
| `persistState` 每日全量重写 | `engine.ts` | ~500 球员 × ~200 天 ≈ 10 万次 UPDATE/赛季；本地 SQLite 能扛。另外 `seasonStats` 替换时 `teamAbbr: "N/A"`，生涯履历丢球队归属 |
| schema 无外键 | `schema.ts` | 零 `references()`，存档隔离全靠查询层 `saveId` 过滤——单机够用但无参照完整性兜底 |
| AI 报价 suitors 随机比较器排序 | `runAiFreeAgencyDay` | `sort(() => rng.float() - rng.float())` 给定 seed 是确定的，但分布不均匀且依赖 sort 实现 |

---

## 模拟质量：校准报告解读

`docs/simulation-calibration.md`（1230 场 vs 真实 2025-26）：

- 场均得分 113.1 vs 115.8 —— 略低，可接受
- Top5 得分手 28.3 vs 30.1 PPG —— 顶级球星得分被压缩
- 胜率标准差 0.142 vs 0.166 —— **分布偏窄**
- DEN 模拟 75-7 vs 真实 54-28 —— **顶级强队统治力过强**

方向判断：单场层面数据合理（分钟守恒、FGA/三分率/罚球/失误/篮板区间都有质量门），赛季层面缺少把强队拉回人间的方差来源——比赛间状态起伏（体力、手感的跨场记忆）几乎没有，强弱差距几乎完全由静态评分差决定。可考虑加小量跨场状态噪声（近期状态漂移、轮休机制）来收敛胜率分布，比单独调参数更治本。

---

## 建议优先级

1. **交易窗口 note 绕过** —— 改成内部 flag，一行修复
2. **帽下空间交易匹配** —— 改 `inc - out ≤ capSpace + 0.1`，重建玩法立刻打开（含 AI 报价侧）
3. **乐透只抽前 4** + 乐透池改为非季后赛队
4. **`growthLeft`/`potential` 对齐** —— 要么开发路径读 `growthLeft`，要么导入时写 `ratings.potential`
5. **底薪要价兜底** —— 空合同按评分给 floor（而非 4.5M）+ 冷市场底薪豁免
6. **Stepien 改状态性检查**；工资帽下限补一个赛季末结算（低于下限 → 差额罚款/提示）
7. **Chemistry 二选一**：接入 sim（小系数团队效率）或 UI 标注"仅供参考"
8. 疲劳系统激活（允许少量 B2B 或降恢复量）让 stamina 真正起作用
9. 杂项清理：新秀合同递增方向、总决赛主场看战绩、bonus 阈值、AI 重签 Dec-15、`pickRow[0]` 销记、`deleteSave` 孤儿行、`seasonStats.teamAbbr`

---

## 架构与工程观察（非问题，供参考）

- **确定性设计扎实**：`rngFor(seed, ...salt)` 全覆盖，模拟路径无 `Math.random`（仅 `createSave` 生成新 seed 用，合理）；eval 回放复现靠同一 seed+动作序列，测试有端到端 determinism 断言
- **规则校验在服务端强制**：eval/agent 工具全部走 engine 事务，LLM 不做数值裁决——评测可信度有保障
- **测试覆盖好**：确定性、交易合法性、赛程完整性、RFA、保护签兑现、Dec-15、轮换持久化都有回归；缺的是规则状态性检查（Stepien 跨交易）、帽下空间交易、真实球员成长这类"跨步状态"用例
- **数据诚实度高**：缺数据显示"未知"而非编造（provenance + confidence），导入层有来源审计
