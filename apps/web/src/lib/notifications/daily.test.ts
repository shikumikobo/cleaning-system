// 毎日の定時のお知らせの処理の判断（R-015-39・40）。DB は偽物に差し替える。
// 誰に・いつ作るかの本体は DB の関数で、supabase/tests/15_notifications_events.sql が確かめる。
import { describe, expect, it } from "vitest";
import {
  DAILY_TASKS,
  REPORT_MISSING_DAYS,
  runDailyNotify,
  sanitizeError,
  type DailyNotifyStore,
  type DailyTask,
} from "../../../../../supabase/functions/_shared/dailyNotify";

interface Call {
  fn: string;
  args: unknown[];
}

function fakeStore(opts: { tenants: string[]; failNotify?: string[]; busy?: string[]; failFinish?: boolean; failTenants?: boolean }) {
  const calls: Call[] = [];
  const store: DailyNotifyStore = {
    async tenants() {
      calls.push({ fn: "tenants", args: [] });
      if (opts.failTenants) throw new Error("tenants failed");
      return opts.tenants;
    },
    async startRun(t, task) {
      calls.push({ fn: "startRun", args: [t, task] });
      return opts.busy?.includes(`${t}:${task}`) ? null : `run-${t}-${task}`;
    },
    async notify(t, task, run, o) {
      calls.push({ fn: "notify", args: [t, task, run, o.days] });
      if (opts.failNotify?.includes(`${t}:${task}`)) throw new Error("boom " + "x".repeat(40));
      return { works: 2, notified: 3 };
    },
    async finishRun(t, run, task, status, counts, error) {
      calls.push({ fn: "finishRun", args: [t, run, task, status, counts, error] });
      if (opts.failFinish) throw new Error("finish failed");
    },
  };
  return { store, calls };
}
const names = (calls: Call[]) => calls.map((c) => `${c.fn}:${c.args[0] ?? ""}:${c.args[1] ?? ""}`);

describe("R-015-39・40 毎日のお知らせの定時の処理", () => {
  it("R-015-39 会社ごと・処理ごとに、記録を始め → お知らせを作り → 記録を閉じる", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"] });
    const s = await runDailyNotify(store);
    expect(s).toEqual({ tenants: 2, skipped: 0, failed: 0, notified: { work_tomorrow: 6, report_missing: 6, invoice_overdue: 6 } });
    // 会社 A の3つの処理 → 会社 B の3つの処理（会社をまとめて混ぜない）
    const order = names(calls).filter((n) => n.startsWith("startRun"));
    expect(order).toEqual([
      "startRun:tA:work_tomorrow", "startRun:tA:report_missing", "startRun:tA:invoice_overdue",
      "startRun:tB:work_tomorrow", "startRun:tB:report_missing", "startRun:tB:invoice_overdue",
    ]);
    const first = calls.filter((c) => c.args[0] === "tA").slice(0, 3).map((c) => c.fn);
    expect(first).toEqual(["startRun", "notify", "finishRun"]);
    expect(calls.find((c) => c.fn === "finishRun")!.args).toEqual(["tA", "run-tA-work_tomorrow", "work_tomorrow", "success", { works: 2, notified: 3 }, null]);
  });
  it("R-015-39 会社の ID は、会社の一覧から取ったものだけを使う（呼び出し側から渡さない）", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA"] });
    await runDailyNotify(store);
    for (const c of calls.filter((x) => x.fn !== "tenants")) expect(c.args[0]).toBe("tA");
  });
  it("R-015-39 同じ会社・同じ処理が動いている間は見送り、ほかの処理は続ける", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA"], busy: ["tA:report_missing"] });
    const s = await runDailyNotify(store);
    expect(s.skipped).toBe(1);
    expect(s.failed).toBe(0);
    expect(names(calls)).not.toContain("notify:tA:report_missing");
    expect(names(calls)).toContain("notify:tA:invoice_overdue");
    expect(calls.filter((c) => c.fn === "finishRun" && c.args[2] === "report_missing")).toHaveLength(0);
  });
  it("R-015-40 1つの処理の失敗は、その記録に残り、ほかの処理・ほかの会社を止めない", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"], failNotify: ["tA:work_tomorrow"] });
    const s = await runDailyNotify(store);
    expect(s.failed).toBe(1);
    expect(s.notified.work_tomorrow).toBe(3); // B の分だけ
    expect(s.notified.report_missing).toBe(6);
    const fin = calls.find((c) => c.fn === "finishRun" && c.args[0] === "tA" && c.args[2] === "work_tomorrow")!;
    expect(fin.args[3]).toBe("failure");
    expect(String(fin.args[5])).toContain("boom");
  });
  it("R-015-40 失敗の理由に、鍵のような長い文字列は出さない", async () => {
    const secret = "sk_live_" + "A".repeat(40);
    const { store, calls } = fakeStore({ tenants: ["tA"] });
    store.notify = async () => {
      throw new Error("bad key " + secret);
    };
    await runDailyNotify(store, { tasks: ["work_tomorrow"] });
    const fin = calls.find((c) => c.fn === "finishRun")!;
    expect(String(fin.args[5])).not.toContain(secret);
    expect(String(fin.args[5])).toContain("***");
    expect(sanitizeError(new Error("x".repeat(300))).length).toBeLessThanOrEqual(200);
  });
  it("R-015-40 記録を閉じられなくても、次の処理へ進む", async () => {
    const { store } = fakeStore({ tenants: ["tA", "tB"], failFinish: true });
    const s = await runDailyNotify(store);
    expect(s.tenants).toBe(2);
    expect(s.failed).toBe(6); // 成功のあとの閉じ方が失敗すれば、失敗として数える（記録は30分で閉じられる）
  });
  it("R-015-40 会社の一覧が取れなければ、何も作らずエラーを返す（呼び出し側が失敗を知る）", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA"], failTenants: true });
    await expect(runDailyNotify(store)).rejects.toThrow("tenants failed");
    expect(calls.map((c) => c.fn)).toEqual(["tenants"]);
  });
  it("R-015-39 処理を絞れる。出ていない報告書の日数は既定14日で、変えられる", async () => {
    expect(DAILY_TASKS).toEqual(["work_tomorrow", "report_missing", "invoice_overdue"]);
    expect(REPORT_MISSING_DAYS).toBe(14);
    const { store, calls } = fakeStore({ tenants: ["tA"] });
    await runDailyNotify(store, { tasks: ["report_missing"] });
    await runDailyNotify(store, { tasks: ["report_missing"], reportDays: 30 });
    const days = calls.filter((c) => c.fn === "notify").map((c) => c.args[3]);
    expect(days).toEqual([14, 30]);
    const t: DailyTask[] = calls.filter((c) => c.fn === "startRun").map((c) => c.args[1] as DailyTask);
    expect(new Set(t)).toEqual(new Set(["report_missing"]));
  });
});
