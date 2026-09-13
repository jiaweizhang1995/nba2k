// GLM 连通性 smoke test（读取 .env.local，走真实 glm.ts 客户端）
import fs from "node:fs";
import { glmChat, getGlmConfig } from "../src/lib/glm";

async function main() {
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  const cfg = getGlmConfig();
  console.log("配置:", { url: cfg.url, model: cfg.model, key: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}` : null });
  const r = await glmChat([{ role: "user", content: "只回复两个字：在线" }], { maxTokens: 16, timeoutMs: 20000 });
  console.log("结果:", r.ok ? `成功（${r.elapsedMs}ms）: ${r.content}` : `失败: ${r.error?.code} ${r.error?.message}`);
  process.exit(r.ok ? 0 : 1);
}
main();
