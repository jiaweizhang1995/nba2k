# HARDWOOD GM

一个可以直接运行的职业篮球经理模拟器。你可以管理一支 NBA 球队，进行交易、续约、选秀、自由市场操作，并推进多个赛季。

A browser-based basketball general manager simulator. Manage an NBA team, make trades, handle contracts, draft players, use free agency, and play through multiple seasons.

## 快速开始 / Quick start

需要 Node.js 20 或更高版本 / Requires Node.js 20 or newer.

```bash
git clone https://github.com/jiaweizhang1995/nba2k.git
cd hardwood-gm
npm install
npm run dev
```

打开 <http://localhost:3000>，开始游戏。

Open <http://localhost:3000> and start playing.

首次启动会自动创建本地 SQLite 数据库和默认真实 NBA 存档。无需 API Key 就能玩核心游戏。

The first launch creates a local SQLite database and a default NBA save automatically. No API key is required for the core game.

## 可选配置 / Optional configuration

如果要启用 AI 简报和谈判文案：

To enable AI briefings and negotiation text:

```bash
cp .env.example .env.local
```

然后在 `.env.local` 中填写 `COMMANDCODE_CHAT_URL`、`COMMANDCODE_MODEL` 和 `COMMANDCODE_API_KEY`。不配置也不影响游戏本体。

Then set `COMMANDCODE_CHAT_URL`, `COMMANDCODE_MODEL`, and `COMMANDCODE_API_KEY` in `.env.local`. The game works without them.

## 常用命令 / Commands

```bash
npm run dev       # 开发模式 / Development server
npm run build     # 生产构建 / Production build
npm run start     # 运行生产版本 / Start production build
npm run lint      # 检查代码 / Lint
npm run typecheck # 类型检查 / Type check
npm test          # 运行测试 / Run tests
```

## 技术栈 / Stack

Next.js · React · TypeScript · Tailwind CSS · Drizzle ORM · SQLite · Vitest

核心模拟逻辑在服务端和 TypeScript domain 模块中运行，数据保存在本地 `data/nba2k-gm.db`。本项目是单机本地游戏，暂不支持多人联机和账号系统。

The simulation runs locally with TypeScript and SQLite. This is a single-player local game; multiplayer and accounts are not included.

## License

暂无正式开源许可证。除非作者另行授权，请不要将本项目用于商业发布。
