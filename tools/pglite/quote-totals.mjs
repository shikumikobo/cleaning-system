// 見積の合計の突き合わせ（R-004-29）の DB 側：共通のテストデータ（supabase/tests/fixtures/quote_totals.json）を
// PGlite の提出の RPC（submit_quote）に通し、DB が出した小計・税・合計を JSON で標準出力に出す。
// 画面の計算（apps/web/src/lib/quotes/calc.ts）と同じかどうかは、apps/web/src/lib/quotes/parity.test.ts が比べる。
// 使い方：node --liftoff-only tools/pglite/quote-totals.mjs
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
await db.exec(readFileSync(join(here, "supabase_base.sql"), "utf8"));
await db.exec("set search_path to public, extensions");
await db.exec(readFileSync(join(here, "pgtap_shim.sql"), "utf8"));
const migDir = join(root, "supabase", "migrations");
for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(join(migDir, f), "utf8"));
const testDir = join(root, "supabase", "tests");
for (const f of readdirSync(testDir).filter((x) => x.startsWith("0000") && x.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(testDir, f), "utf8").replace(/create extension if not exists pgtap[^;]*;/i, ""));
}
await db.exec("select tests.seed()");

const { cases } = JSON.parse(readFileSync(join(testDir, "fixtures", "quote_totals.json"), "utf8"));
const out = [];
let i = 0;
for (const c of cases) {
  i++;
  const q = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  await db.query(
    `insert into public.quotes (id, tenant_id, client_id, building_id, kind, tax_rate)
     values ($1, tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'), 'request', $2)`,
    [q, c.tax_rate],
  );
  let n = 0;
  for (const l of c.lines) {
    n++;
    await db.query(
      `insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit, unit_price, sort)
       values (tests.t('A'), $1, 'one_time', $2, $3, '式', $4, $5)`,
      [q, `明細${n}`, l.qty, l.unit_price, n],
    );
  }
  const res = await db.query(`select tests.run_as(tests.u('memberA'), format('select public.submit_quote(%L) as r', $1::uuid)) as j`, [q]);
  const j = res.rows[0].j;
  if (j.error || !j.rows?.[0]?.r?.ok) throw new Error(`提出に失敗：${c.name} ${JSON.stringify(j)}`);
  const r = (await db.query(`select subtotal::text as s, tax::text as t, total::text as g from public.quotes where id = $1`, [q])).rows[0];
  out.push({ name: c.name, subtotal: Number(r.s), tax: Number(r.t), total: Number(r.g) });
}
process.stdout.write(JSON.stringify(out));
