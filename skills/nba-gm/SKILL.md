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
