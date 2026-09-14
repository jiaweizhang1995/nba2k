---
name: nba-gm
description: 与用户协作游玩 NBA GM 模拟器；可开新局、恢复 AGENT 存档、观察盘面并逐回合执行动作。
---

# NBA GM 协作游玩

项目目录是 `/Users/jimmymacmini/workspace/nba2k`。先读 `docs/agent-playbook.md`，再运行 `scripts/agent-eval.ts`。默认用户负责交易、选秀、重大签约和球队方向；agent 负责侦察、提出带风险的方案和执行已授权的日常操作。

开局：`TSX_TSCONFIG_PATH=scripts/tsconfig.json npx tsx scripts/agent-eval.ts new LAL 5`。
恢复或只读观察：`... resume <evalId>`（返回最新观察，不写动作）。执行动作：`... act <evalId> '<JSON>'`。每次动作都必须抄观察中的稳定 ID，并填写 decision；先检查 allowedActions。不要猜 ID、绕过引擎或连续推进用户约定的决策节点。

遇到交易截止日、选秀、自由市场、季后赛或待处理报价，停下来用中文说明局面、推荐方案、备选方案和风险，等用户决定。用户说“托管本月/本阶段”后才自动推进。跨 CLI 接续时始终使用明确的 evalId；实际状态保存在项目 SQLite 中。

详细动作参数和阶段规则见 `docs/agent-playbook.md`，只在需要时读取。

## 省回合技巧

评测实际运行在 `evaluations.save_id` 指向的克隆存档；不要把 `base_save_id` 当作当前世界。需要直读 SQLite 时，先从 `evaluations` 表按 evalId 取 `save_id`，所有 players/contracts/picks/teams 查询都带这个 save_id。`get_market`、`get_assets` 等侦察动作会各消耗一个回合；能从本地库准确取得的数据先 SELECT，只有需要引擎计算的观察才花回合。每次 `act` 都计入 600 回合硬上限（5 年），要在推进、侦察和试探之间取舍。交易被拒绝时保留返回的 `feedback.valueDelta`：这是对方 GM 的精确价值差，可据此微调下一份报价；不要盲目重复相同报价。
