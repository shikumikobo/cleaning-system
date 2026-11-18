// PGlite（WASM 版 Postgres）で、マイグレーションと DB のテストを流す仮の検証。
// 使う場面：Docker が使えないとき。本物の検証は supabase test db（CI）。pgTAP の代わりに最小の版を使う。
// 使い方：node tools/pglite/run.mjs [テストのファイル名の一部]   （VERBOSE=1 で通ったものも出す）
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const filter = process.argv[2];

const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
await db.exec(readFileSync(join(here, "supabase_base.sql"), "utf8"));
await db.exec("set search_path to public, extensions");
await db.exec(readFileSync(join(here, "pgtap_shim.sql"), "utf8"));

const migDir = join(root, "supabase", "migrations");
const migrations = process.env.NO_MIGRATIONS ? [] : readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort();
for (const f of migrations) {
  try {
    await db.exec(readFileSync(join(migDir, f), "utf8"));
  } catch (e) {
    console.error(`マイグレーションが失敗：${f}\n${e.message}`);
    process.exit(2);
  }
}
console.log("マイグレーション OK");

const testDir = join(root, "supabase", "tests");
let ok = 0, notOk = 0, errors = 0;
for (const f of readdirSync(testDir).filter((x) => x.endsWith(".sql")).sort()) {
  if (filter && !f.includes(filter) && !f.startsWith("0000")) continue;
  const sql = readFileSync(join(testDir, f), "utf8").replace(/create extension if not exists pgtap[^;]*;/i, "");
  console.log(`\n# ${f}`);
  try {
    const results = await db.exec(sql);
    for (const r of results) {
      for (const row of r.rows ?? []) {
        const v = Object.values(row)[0];
        if (typeof v !== "string") continue;
        if (/^ok \d+/.test(v)) {
          ok++;
          if (process.env.VERBOSE) console.log(v);
        } else if (/^not ok \d+/.test(v)) {
          notOk++;
          console.log(v);
        }
      }
    }
  } catch (e) {
    errors++;
    console.log(`ERROR in ${f}: ${e.message}`);
    try {
      await db.exec("rollback");
    } catch {}
  }
}
console.log(`\n合計：ok ${ok}、not ok ${notOk}、ファイルのエラー ${errors}`);
process.exit(notOk || errors ? 1 : 0);
