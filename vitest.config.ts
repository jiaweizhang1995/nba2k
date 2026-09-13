import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` throws outside React Server Components; stub it for tests.
      "server-only": path.resolve(__dirname, "./tests/server-only-stub.ts"),
    },
  },
});
