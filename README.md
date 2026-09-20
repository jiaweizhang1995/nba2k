# NBA2K

一个给 AI Agent 玩的 NBA 总经理模拟器。Agent 通过 MCP 读取真实存档、分析球队、提出交易、管理阵容、选秀、签约，并和你一起推进多个赛季。

An NBA general manager simulator designed for AI Agents. An agent uses MCP to inspect a real save, make trades, manage the roster, draft players, sign free agents, and play multiple seasons with you.

## Agent 模式 / Agent mode

这是本项目的主要玩法。你不需要自己编辑 MCP 配置，直接把下面这段话发给你正在使用的 AI：

This is the main way to play. You do not need to edit MCP configuration yourself. Send this prompt to your AI:

```text
请帮我配置并运行这个 NBA2K 项目：
1. 在项目根目录安装依赖（npm install）。
2. 把 scripts/mcp-gm-server.ts 注册为名为 nba-gm 的 MCP server，使用 npx tsx 启动，并把工作目录设为这个项目根目录。
3. 如果已有同名配置，请更新它，不要重复创建。
4. 重新加载 MCP 后，调用 gm_saves 或 gm_teams 验证连接。
5. 配置完成后告诉我验证结果，不要修改游戏规则或手写数据库。

配置好以后，开一个湖人存档。先观察阵容、薪资和选秀权，再给我三套交易方向；重大交易和签约等我确认后再执行。
```

完成配置后，AI 就能通过 MCP 直接和你一起玩真实存档：读取球队、分析资产、提出交易、管理阵容、选秀、签约，并推进多个赛季。

Once configured, your AI can play the real save with you through MCP: inspect teams, analyze assets, propose trades, manage the roster, draft players, sign free agents, and advance multiple seasons.

常用工具 / Common tools:

- `gm_new`：新建存档 / start a save
- `gm_saves`、`gm_use`：查看和切换存档 / list and switch saves
- `gm_observe`：查看当前局面和允许动作 / inspect the current state
- `gm_act`：执行一个游戏动作 / execute one game action
- `gm_auto`：推进到下一个决策点 / advance to the next decision point
- `gm_teams`、`gm_roster`、`gm_find`、`gm_picks`：侦察联盟和资产 / scout the league and assets
- `gm_status`、`gm_events`：查看战绩和事件 / inspect results and events

Agent 的完整规则、动作格式和常见陷阱见 [`docs/agent-playbook.md`](docs/agent-playbook.md)。所有规则由服务器强制执行，Agent 不能绕过薪资帽、交易截止日或阶段权限。

See [`docs/agent-playbook.md`](docs/agent-playbook.md) for the full action reference and pitfalls. The server enforces the rules, including the salary cap, trade deadline, and phase permissions.

## 网页界面 / Web UI

网页是可选的辅助界面，不是主要玩法。需要查看或手动操作时运行：

The web UI is optional. Run it only when you want a visual dashboard or manual controls:

```bash
npm run dev
```

然后打开 <http://localhost:3000>。

Then open <http://localhost:3000>.

## 数据与存档 / Data and saves

首次启动或第一次调用 `gm_new` 时，会自动创建本地 SQLite 数据库和默认真实 NBA 数据。存档保存在 `data/nba2k-gm.db`，不需要 API Key。

The first launch or first `gm_new` call creates a local SQLite database with the bundled NBA data. Saves live in `data/nba2k-gm.db`; no API key is required.

## 常用命令 / Commands

```bash
npm run dev       # 网页开发服务器 / web development server
npm run build     # 生产构建 / production build
npm run lint      # 代码检查 / lint
npm run typecheck # 类型检查 / type check
npm test          # 运行测试 / run tests
```

## 技术栈 / Stack

Next.js · React · TypeScript · Drizzle ORM · SQLite · Vitest · MCP

本项目是本地单机模拟器。多人联机、账号系统和在线存档暂未包含。

This is a local single-player simulator. Multiplayer, accounts, and cloud saves are not included.

## License

暂无正式开源许可证。除非作者另行授权，请不要将本项目用于商业发布。

No open-source license has been added yet. Do not use this project for commercial distribution without permission from the author.
