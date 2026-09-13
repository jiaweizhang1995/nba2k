# HARDWOOD GM — 职业篮球经理模拟器

一个网页端职业篮球 GM 模拟游戏：交易、薪资管理、化学反应、选秀、自由市场与多年重建。
**默认内置真实 NBA 数据**：30 支真实球队 + 539 名真实球员名单，其中 304 名球员带真实
2025-26 赛季场均数据（Wikipedia，CC BY-SA 4.0，已自动署名溯源）。首次启动自动生成
真实数据存档，无需手动导入。

技术栈：Next.js 16（App Router）· TypeScript · Tailwind CSS 4 · Drizzle ORM · SQLite（better-sqlite3）· Vitest。
状态管理使用原生 React，无额外状态库。数值逻辑全部在纯 TypeScript domain 模块中，LLM 不参与任何数值决定。

---

## 快速开始

```bash
npm install
cp .env.example .env.local   # 按需填写；不填也能玩（AI 功能降级）
npm run dev                  # http://localhost:3000
```

打开首页即自动进入默认「真实 NBA 2026-27」存档；**新建存档也默认直接使用真实 NBA 数据**
（30 支真实球队 + 539 名真实球员，选队界面即真实联盟），无需手动导入。
数据库文件默认在 `data/nba2k-gm.db`（首次运行自动建表迁移 + 自动种子真实数据），可用 `NBA2K_DB_PATH` 改路径。
可用 `NBA2K_NO_AUTOSEED=1` 关闭自动种子（测试/CI 用）。

### 常用命令

```bash
npm run dev          # 开发服务器
npm run build        # 生产构建
npm run start        # 生产运行
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm test             # Vitest（含确定性模拟、交易规则、薪资守恒等测试）
npm run db:generate  # 修改 schema.ts 后生成迁移
npm run import -- --save <saveId> --file players.csv --teams teams.csv --season 2027 --source-url https://...
```

---

## 游戏内容

| 页面 | 功能 |
| --- | --- |
| 总经理首页 | 战绩、排名、薪资、化学反应、赛程、GLM 周报 |
| 轮换与阵容 | 2K 式位置槽位（PG/SG/SF/PF/C）：点卡片选人、替补提上首发对换、分钟分配、位置契合与深度图；球员详情含评分依据与置信度 |
| 交易中心 | 双方资产选择、规则校验（薪资配平/人数/不可交易条款/Stepien）、估值分解、AI GM 反馈、成交 |
| 选秀 | 新秀榜、球探报告（潜力区间为估计值）、乐透顺位、模拟选秀 |
| 自由市场 | 报价（年薪×年限）、兴趣度谈判、特例规则、开启新赛季 |
| 比赛模拟 | 推进 1 天 / 1 周 / 1 月 / 常规赛 / 季后赛 / 整季；阶段自动流转 |
| 化学反应 | 7 因子分解（投射空间/球权冲突/球星层级/替补深度/连续性/满意度等）+ GLM 简报 |
| 资产 | 薪资空间、税线与土豪线、未来 7 年选秀权、合同簿 |
| 联盟 | 东西部排名、数据榜、奖项历史 |
| 操作日志 | 全部普通操作与 GOD MODE 操作（可筛选、可撤销最近一次 God 操作） |
| AI 评测 | AI GM 评测模式：配置 Provider/模型/Key/球队/种子/年限，AI 通过受控工具运营球队 3 或 5 年，产出 GM-BENCH 评分、结果面板、决策时间线、回放与模型对比 |
| 设置 | GLM 配置状态与连通性测试、数据导入、数据来源登记、GOD MODE 开关 |

### 模拟引擎（确定性）

- 引擎为纯 TypeScript（`src/domain/`）：`GAME-SIM v1.0`（回合制比赛模拟）、`SEASON-SIM v1.0`
  （赛程/伤病/疲劳/奖项/成长衰退）、`CHEMISTRY v1.0`、`LEAGUE CBA v1.0`（薪资/交易/选秀/自由市场规则）。
- 随机数全部来自 `(save.seed, salt)` 派生的 PRNG：**同一存档种子 + 同一操作序列 = 完全相同结果**（有测试保证）。
- 每次交易/模拟结果都附带“为什么”：有效命中率对比、篮板/失误差距、阵容进攻质量差等。

### 评分说明（重要）

- 「综合评分」由统计计算（`RATING-ENGINE v1.0`）：投射/终结/组织/篮板/防守等子项来自最近赛季
  观测数据的确定性变换，**不是任何官方游戏评分**。
- 每个评分展示：使用的公式版本、样本量与置信度、原始统计。潜力是球探估计区间，不是确定值。

---

## 数据真实性与导入

**默认数据即真实 NBA**：新建存档直接由内置资产 `src/data/real/nba-real-2026-27.json` 建盟
（30 支真实球队 + 539 名真实球员，含真实 2025-26 统计与 377 份真实合同），存档状态为
`IMPORTED`，每条数据带 `provider / sourceUrl / retrievedAt / season / licenseNote / status`
溯源字段。仅当该资产文件缺失时才回退到虚构演示联盟（`DEMO / ILLUSTRATIVE`，此时界面显示
黄色横幅提示）。

接入真实数据的管线（设置页、命令行或一键脚本）：

**真实数据管线（已预置数据，无需手动执行）**：

```bash
npm run data:fetch-rosters   # 抓取 30 队真实名单（Wikipedia，CC BY-SA 4.0）
npm run data:fetch-stats     # 抓取球员真实 2025-26 场均数据（Wikipedia 球员条目）
npm run data:build           # 合并为应用内置资产 src/data/real/nba-real-2026-27.json
npm run data:seed            # 用内置资产生成默认存档（首次启动也会自动执行）
npm run calibrate            # 模拟整季 vs 真实 2025-26 校准报告 → docs/simulation-calibration.md
```

- 名单：姓名/位置/年龄/身高/体重/号码（事实数据）。
- 统计：304 名有 NBA 2025-26 常规赛出场记录的球员带真实场均数据
  （得分/篮板/助攻/抢断/盖帽/命中率/三分率/罚球率/出场数/时间），
  评分由这些真实数据计算（RATING-ENGINE v1.1）；其余为新秀/边缘球员，
  显示「未知」与低置信度，**绝不编造数字**。
- 合同：377 份真实合同来自 ESPN 公开数据端点（当前赛季薪资 + 剩余年数，
  Curry $59.6M/2年、Jokić $55.2M/3年、Dončić $54.1M/3年等），交易薪资配平据此生效；
  未来年份按同等薪资平推（近似）。剩余 122 名双向/无保障球员无任何公开合同记录，显示「未知」——
  如需补全：准备 `name,salary,contract_years` 三列 CSV，在「设置 → 数据导入」勾选
  「仅合并合同」上传（或 `npm run import -- --save <id> --file contracts.csv --merge-contracts`），
  按球员名匹配只更新合同、不动联盟其他数据。
- 溯源（provider=WIKIPEDIA、sourceUrl、retrievedAt、licenseNote）写入每条记录并
  登记在「设置 → 数据来源」。CC BY-SA 4.0 要求署名与相同方式共享，已自动满足署名。

| 适配器 | 用途 | 授权注意 |
| --- | --- | --- |
| `BALLDONTLIE` | 开发/个人测试（免费档） | 数据版权归 BALLDONTLIE 及上游；免费档不含合同/薪资，缺失字段显示「未知」，不会编造 |
| `SPORTRADAR` | 正式授权生产数据 | 商业授权；适配器需在授权字段范围内启用映射，未授权不会抓取任何数据 |
| `CSV_JSON` | 自备数据上传 | 来源与授权由上传方负责，必须提供 sourceUrl 等溯源元数据 |
| `WIKIPEDIA`（scripts/fetch-nba-rosters.ts） | 真实 NBA 球队/球员名单 | CC BY-SA 4.0：使用需署名（已自动写入溯源与数据来源页），衍生物需相同方式共享；不含统计与合同 |

CSV 格式（players.csv）：

```csv
name,position,age,height_cm,weight_kg,draft_year,g,mp,pts,reb,ast,stl,blk,tov,fgm,fga,tpm,tpa,ftm,fta,salary,contract_years
```

导入会：校验溯源元数据 → 按导入统计重新计算可解释评分 → 在事务中替换存档球队/球员 →
登记数据来源与更新时间。原始统计与派生评分在球员详情页均可查看。

**没有授权数据时，本作不会伪造真实球员数据，也不会抓取 NBA.com / Basketball-Reference 等站点。**

---

## GLM / CommandCode 集成

通过环境变量配置 OpenAI 兼容的 Chat Completions 接口（见 `.env.example`）：

```env
COMMANDCODE_CHAT_URL=https://api.commandcode.ai/provider/v1/chat/completions
COMMANDCODE_MODEL=deepseek/deepseek-v4-flash
COMMANDCODE_API_KEY=<你的新 Key>
```

- 仅在服务端调用（`src/lib/glm.ts`），URL 按配置原样使用（不重复拼接路径），Bearer 认证，
  30s 超时，非流式 JSON；响应解析兼容代码围栏。
- API Key 只从环境变量读取；不进入客户端 bundle、日志、README、截图或 Git。
- 启动后可在「设置」页查看配置状态并测试连通性；**接口不可用时游戏核心功能完全可用**，
  AI 功能显示配置错误。
- GLM 只用于：新闻/简报文案、化学反应解释、交易谈判思路、对方 GM 谈判语气。
  GLM 不得生成统计、修改数据库、决定交易成败或替代模拟引擎——交易裁决来自规则引擎，
  AI 仅润色文字（服务端强制）。

### ⚠️ 安全提醒（务必处理）

**本次开发对话中曾出现过明文 API Key——请立即在 CommandCode 平台吊销该 Key 并生成新 Key，
只把新 Key 写入 `.env.local`（已被 .gitignore 排除）。** 任何曾出现在聊天、截图、文档中的 Key
都应视为已泄露。

## God Mode

- 默认关闭；在设置页开启需二次确认，开启后全站显示红色警告横幅。
- 能力：强制成交任意交易（跳过规则校验）、修改球员评分/潜力/年龄/合同/伤情/满意度、
  强制转移球员、授予选秀权、跳转赛季阶段、撤销最近一次 God 操作（操作前自动快照，保留最近 5 份）。
- 所有 God 操作写入审计日志并标记 `GOD MODE ⚡`，在「操作日志」可筛选查看。
- 普通模式规则不受影响：规则校验全部在服务端，God 强制成交需显式传 `force` 并记录。

---

## 工程结构

```
src/
  domain/        # 纯 TS 引擎：rng / ratings / chemistry / salary / trade / draft /
                 # freeagency / aiGm / sim(game, season)——可测试、确定性、无 DB 依赖
  server/        # 引擎编排：事务、事件日志、God Mode、导入管线、路由校验 schema
  db/            # Drizzle schema + 迁移引导
  data/          # DEMO 生成器 + 数据源适配器（BALLDONTLIE / Sportradar / CSV-JSON）
  lib/           # GLM 客户端（server-only）+ AI 文案服务
  app/           # 页面 + Route Handlers（所有写操作经服务端校验与事务）
tests/           # Vitest：确定性、交易规则、薪资守恒、赛季推进、溯源、GLM 协议
```

## AI GM 评测模式（「AI 评测」页）

让任意 OpenAI Chat Completions 兼容模型扮演总经理，通过**受控工具**（查看阵容/市场、提议交易、
签约、选秀、设置策略、推进赛季）运营一支球队 3 或 5 年，用于横向对比不同模型的 GM 能力。

- **隔离**：每次评测克隆基准存档为独立快照（同种子），绝不修改用户存档
- **权限**：动作按阶段白名单裁决（选秀阶段不能签约、常规赛不能选新秀…）；交易/签约全部经
  现有服务器规则（薪资配平、人数、对方意愿）；LLM 不能改数据库、不能 God Mode
- **记录**：模型/Provider/种子/参数、每次工具调用与结果、交易与选秀签约明细、AI 主动提交的
  公开决策摘要/目标/预期/风险（不获取隐藏思维链）、逐赛季战绩/季后赛/冠军、调用数/错误/延迟/token 与成本
- **确定性回放**：同快照+同种子+同动作序列 ⇒ 相同结果；「回放」按钮按记录动作重放，不调用模型
- **评分**：版本化 GM-BENCH v1
  `score = 场均胜场×1.2 + 季后赛×6 + 总决赛×8 + 冠军×25 + 合法率×20 − 错误率×15 + (化学反应−60)×0.15`
- **对比**：模型对比页按同场景（同球队+种子+年限）并排对比
- **Provider**：独立适配器（`src/lib/eval-provider.ts`），支持任意 OpenAI 兼容 URL/模型/Key；
  无真实 Provider 时用 STUB（确定性脚本决策）验证整条链路
- **Key 安全**：API Key 仅服务端使用，数据库存 AES-256-GCM 密文（`NBA2K_EVAL_SECRET` 派生），
  API 只返回掩码；相关接口/测试均断言明文不出现
- **Agent 友好**：观察数据中所有可操作对象（球员/选秀权/球队/新秀）都带稳定 `id`，
  观察附带当前阶段 `allowedActions`；`POST /api/eval/[id]/run` 一键跑完评测
  （服务端循环步进至终态，可选 `{ maxSteps }`），无需手动轮询 `/step`；
  支持 `waive_player` 动作（裁员产生死钱仍占工资帽）

## 验收状态

- ✅ lint / typecheck / 全量测试 / production build 通过
- ✅ 确定性测试：相同种子两次完整赛季推进，比赛结果、伤病、奖项、战绩完全一致
- ✅ 交易规则测试：薪资配平（150%/125%/二土豪线）、人数上下限、不可交易条款、Stepien 规则、
  资产重复/凭空收资产拦截；普通模式拒绝非法交易，God Mode 显式放行并记录
- ✅ 薪资与资产守恒测试：交易后联盟总薪金不变，每名球员有且仅有一个归属
- ✅ 排名与赛季推进测试：82 场/队、战绩更新、季后赛四级对阵、冠军、奖项、选秀→自由市场→新赛季
- ✅ 数据来源与更新时间显示测试；评分版本与置信度展示
- ✅ CommandCode API 配置/错误处理测试（请求格式、Bearer、超时、HTTP 错误、坏响应），
  另有仅在配置真实环境变量时运行的在线 smoke test
- ✅ 真实数据校准（docs/simulation-calibration.md）：模拟整季 1230 场 vs 真实 2025-26——
  联盟平均每队得分 113.1 vs 115.8（差 2.3%）；得分榜由真实球星占据
  （模拟 SGA 33.6 / Jokić 31.2 / Dončić 28.0 vs 真实 31.1 / 27.7 / 33.5）；
  战绩分布接近（最差战绩 0.207 完全一致，胜率标准差 0.142 vs 0.166）
- ✅ AI GM 评测链路测试：Provider 适配器（JSON 协议/错误处理）、阶段权限（越权拒绝）、
  Key 脱敏（响应与数据库均无明文）、同种子确定性（两次独立评测结果一致）、
  评测运行+回放（回放 0 次调用且逐赛季一致）、3 年/5 年结果面板字段
- ✅ 桌面与平板宽度布局人工验证

## 已知边界（未启用/受授权限制）

- 合同/薪资：377 份真实合同已导入（ESPN 公开端点，溯源已登记）；122 名边缘球员薪资未知。
- 235 名年轻/边缘球员的 Wikipedia 条目尚无统计表，评分为低置信度占位。
- 真实名单存档中选秀（新秀）数据为空，需在休赛期前补充导入新秀或使用演示存档体验选秀。
- 多人联机、账号系统、微服务、机器学习训练按需求裁剪未实现。
- GLM 功能需要配置 CommandCode 环境变量；未配置时降级为规则引擎文案。
- 未实现（按需求裁剪）：多人联机、账号系统、微服务、机器学习训练。
