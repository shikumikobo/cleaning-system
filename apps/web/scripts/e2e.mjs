// 画面のテストを流す：接続先を偽物（127.0.0.1:54321）にして書き出し直し、Playwright のテストを流す。
// 環境変数が空だと画面は「接続の設定なし」になり、全部のテストが待ち続けて TimeoutError になるので、ここで必ず入れる。
import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "e2e-anon",
  // 通知の画面のテスト用の、本物ではない公開鍵（秘密鍵はない。015）
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "BDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyD",
  VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
};

function run(args) {
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const bin = (pkg, file) => new URL(`../node_modules/${pkg}/${file}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
run([bin("next", "dist/bin/next"), "build"]);
run([bin("vitest", "vitest.mjs"), "run", "-c", "vitest.e2e.config.ts"]);
