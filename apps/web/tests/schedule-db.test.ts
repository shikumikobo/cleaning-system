// 予定を作る定時の処理を、本物の DB の関数（PGlite に流したマイグレーション）につないで確かめる（機能 010。R-010-7〜14・17）。
// 判断のコード（_shared/schedule.ts）が、DB の schedule_* 関数を通して、会社ごとに作業を作ることを見る。
// PGlite は、この Vitest のワーカーの中では動かない（メモリの不具合）ので、tools/pglite/schedule-scenario.mjs を
// 別のプロセスで流し、出てきた事実（JSON）を確かめる（見積の合計の突き合わせと同じ形）。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

interface Facts {
  today: string;
  horizon: string;
  first: { tenants: number; failedTenants: number; created: number; existing: number };
  base: string[];
  a1: string[];
  opt: string[];
  crossTenant: number;
  bInA: number;
  runs: Array<{ status: string; created: number }>;
  runIds: number;
  assignA10: { n: number; a: number };
  assignB10: number;
  optCharges: string[];
  baseCharges: number;
  worksBefore: number;
  second: { created: number; existing: number };
  worksAfter: number;
  successRuns: number;
  eff: string;
  change: { ok: boolean; cancelled: number };
  liveAfterChange: number;
  third: { created: number };
  afterRebuild: string[];
  assignRebuilt: { n: number; a: number };
  serviceRows: Array<{ a: string; f: string; t: string }>;
  end: string;
  endResult: { ok: boolean };
  afterEndLater: number;
  afterEndUntil: number;
  invalid: { invalid: number; failedTenants: number };
  invalidRun: { status: string; inv: string };
}

let f: Facts;
beforeAll(() => {
  const r = spawnSync(process.execPath, ["--liftoff-only", `${root}tools/pglite/schedule-scenario.mjs`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  expect(r.status, r.stderr).toBe(0);
  f = JSON.parse(r.stdout) as Facts;
}, 180_000);

const dow = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay(); // 0=日
const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

describe("R-010-7〜12 予定の作成（判断のコード + DB の関数）", () => {
  it("R-010-7 会社ごとに、今日から 2 か月先までの作業を作る（基本は毎週月曜）", () => {
    expect(f.first.failedTenants).toBe(0);
    expect(f.first.tenants).toBe(2);
    expect(f.first.created).toBeGreaterThan(8);
    expect(f.base.every((d) => dow(d) === 1)).toBe(true);
    expect(f.base[0] >= f.today).toBe(true);
    expect(f.base[f.base.length - 1] <= f.horizon).toBe(true);
    // 独立の数え方：今日から 2 か月先までの月曜の数
    let mondays = 0;
    for (let d = f.today; d <= f.horizon; d = addDays(d, 1)) if (dow(d) === 1) mondays++;
    expect(f.base.length).toBe(mondays);
  });

  it("R-010-6 毎月 第2火曜・3か月に1回（起点の 2026-01-01 から数える）も、その形で作る", () => {
    expect(f.a1.length).toBeGreaterThan(0);
    expect(f.a1.every((d) => dow(d) === 2 && Number(d.slice(8)) >= 8 && Number(d.slice(8)) <= 14)).toBe(true);
    expect(f.opt.every((d) => ["01", "04", "07", "10"].includes(d.slice(5, 7)) && d.endsWith("-01"))).toBe(true);
  });

  it("R-010-11 作業の会社は、元の中身の会社と必ず同じ。別の会社の作業は作らない", () => {
    expect(f.crossTenant).toBe(0);
    expect(f.bInA).toBe(0);
  });

  it("R-010-12 会社ごと・1回ごとに、処理の記録（job_runs）が残り、作った件数が入る", () => {
    const firstRuns = f.runs.slice(0, 2);
    expect(firstRuns.every((r) => r.status === "success")).toBe(true);
    expect(firstRuns.reduce((n, r) => n + r.created, 0)).toBe(f.first.created);
    expect(f.runIds).toBe(2);
  });

  it("R-010-9 決まった担当が、作った作業の初めの担当に入る", () => {
    expect(f.assignA10.n).toBeGreaterThan(0);
    expect(f.assignA10.a).toBe(f.assignA10.n * 2); // スタッフ A と社員 A
    expect(f.assignB10).toBeGreaterThan(0);
  });

  it("R-010-10 行った回ごとの中身（オプション）は作業の金額を作り、毎月の中身（基本）は作らない", () => {
    expect(f.optCharges.every((a) => a === "12000")).toBe(true);
    expect(f.baseCharges).toBe(0);
  });

  it("R-010-8 二度動いても重ならない（作った数は 0・同じ数だけ『すでにある』）", () => {
    expect(f.second.created).toBe(0);
    expect(f.second.existing).toBe(f.first.created);
    expect(f.worksAfter).toBe(f.worksBefore);
    expect(f.successRuns).toBe(4);
  });

  it("R-010-14 中身を変えると、適用日以降の予定が取り消され、次の処理が新しい中身（水曜）で作り直す", () => {
    expect(f.change.ok).toBe(true);
    expect(f.change.cancelled).toBeGreaterThan(0);
    expect(f.liveAfterChange).toBe(0);
    expect(f.third.created).toBeGreaterThan(0);
    expect(f.afterRebuild.filter((d) => d < f.eff).every((d) => dow(d) === 1)).toBe(true); // 適用日より前は、元のまま月曜
    const later = f.afterRebuild.filter((d) => d >= f.eff);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((d) => dow(d) === 3)).toBe(true); // 適用日以降は水曜
    expect(f.assignRebuilt.a).toBe(f.assignRebuilt.n * 2); // 決まった担当を引き継いで入る
  });

  it("R-010-13 どの月にいくらだったかが残る（古い行は元の金額・適用日の前日で閉じ、新しい行は新しい金額）", () => {
    expect(f.serviceRows.map((r) => r.a)).toEqual(["30000", "33000"]);
    expect(f.serviceRows[0].t).toBe(addDays(f.eff, -1));
    expect(f.serviceRows[1].f).toBe(f.eff);
    expect(f.serviceRows[1].t).toBe("");
  });

  it("R-010-17 契約を終えると、終了日より後の予定は取り消され、次の処理でも作られない", () => {
    expect(f.endResult.ok).toBe(true);
    expect(f.afterEndLater).toBe(0);
    expect(f.afterEndUntil).toBeGreaterThan(0);
  });

  it("R-010-12 繰り返しが読めない中身があっても、ほかの中身は作る（invalid に数え、会社は成功）", () => {
    expect(f.invalid.invalid).toBe(1);
    expect(f.invalid.failedTenants).toBe(0);
    expect(f.invalidRun).toEqual({ status: "success", inv: "1" });
  });
});
