import { defineConfig } from "vitest/config";

// 画面のテスト（Playwright）。`pnpm test:e2e` が、接続先を偽物（127.0.0.1:54321）にして out/ を作ってから流す（scripts/e2e.mjs）
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
