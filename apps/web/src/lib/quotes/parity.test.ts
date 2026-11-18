// R-004-29 画面の合計と DB の合計が、同じテストのデータで一致する。
// 共通のデータ（supabase/tests/fixtures/quote_totals.json）を、
//  - 画面の計算（calcQuote）に通した答え
//  - DB の提出の RPC に通した答え（tools/pglite/quote-totals.mjs が PGlite で出す）
// と、データに書いてある期待値の3つが、すべて同じであることを確かめる。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calcQuote } from "./calc";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
interface Case {
  name: string;
  tax_rate: number;
  lines: Array<{ qty: number; unit_price: number }>;
  expected: { subtotal: number; tax: number; total: number };
}
const { cases } = JSON.parse(readFileSync(`${root}supabase/tests/fixtures/quote_totals.json`, "utf8")) as { cases: Case[] };

describe("R-004-29 画面の合計と DB の合計", () => {
  it("画面の計算は、データの期待値と同じ", () => {
    for (const c of cases) {
      const r = calcQuote(c.lines, c.tax_rate);
      expect({ name: c.name, subtotal: r.subtotal, tax: r.tax, total: r.total }, c.name).toEqual({ name: c.name, ...c.expected });
    }
  });

  it("DB の提出の RPC が出す合計も、画面の計算と、すべてのケースで一致する", () => {
    const r = spawnSync(process.execPath, ["--liftoff-only", `${root}tools/pglite/quote-totals.mjs`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const db = JSON.parse(r.stdout) as Array<{ name: string; subtotal: number; tax: number; total: number }>;
    expect(db.length).toBe(cases.length);
    for (const c of cases) {
      const row = db.find((x) => x.name === c.name)!;
      const screen = calcQuote(c.lines, c.tax_rate);
      expect({ subtotal: row.subtotal, tax: row.tax, total: row.total }, `${c.name}（DB と画面）`).toEqual({ subtotal: screen.subtotal, tax: screen.tax, total: screen.total });
      expect({ subtotal: row.subtotal, tax: row.tax, total: row.total }, `${c.name}（DB と期待値）`).toEqual(c.expected);
    }
  }, 180_000);
});
