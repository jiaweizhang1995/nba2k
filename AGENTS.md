<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Playing the game as an agent

To play this NBA GM simulator yourself, use the `nba-gm` MCP server (`.devin/mcp_config.json` → `scripts/mcp-gm-server.ts`) — it drives **real saves** through `src/server/engine.ts` directly. `gm_observe`/`gm_teams`/`gm_roster`/`gm_find`/`gm_pool`/`gm_picks`/`gm_resolve`/`gm_events`/`gm_saves`/`gm_status` are read-only, `gm_act` executes one validated action with name→ID resolution (`preview_trade` dry-runs a trade without executing — use it before `propose_trade`), `gm_auto` advances until a decision checkpoint, `gm_use`/`gm_new`/`gm_delete` manage saves. For rules and pitfalls (draft two-step, Feb-6 deadline, 140% extension trap, bird rights), read `docs/agent-playbook.md`.
