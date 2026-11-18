// 期限のお知らせの定時の処理の判断（R-003-26）。DB は偽物に差し替える。
// 誰に・いつ作るかの本体は DB の関数で、supabase/tests/21_requests.sql が確かめる。
import { describe, expect, it } from "vitest";
import { DEFAULT_DAYS, runRequestDue, type RequestDueStore } from "../../../../../supabase/functions/_shared/requestDue";
import { DUE_SOON_DAYS } from "./due";

interface Call {
  fn: string;
  args: unknown[];
}

function fakeStore(opts: { tenants: string[]; failNotify?: string[]; busy?: string[]; failFinish?: boolean }) {
  const calls: Call[] = [];
  const store: RequestDueStore = {
    async tenants() {
      calls.push({ fn: "tenants", args: [] });
      return opts.tenants;
    },
    async startRun(t) {
      calls.push({ fn: "startRun", args: [t] });
      return opts.busy?.includes(t) ? null : `run-${t}`;
    },
    async notify(t, run, days) {
      calls.push({ fn: "notify", args: [t, run, days] });
      if (opts.failNotify?.includes(t)) throw new Error("boom " + "x".repeat(40));
      return { requests: 2, notified: 3 };
    },
    async finishRun(t, run, status, counts, error) {
      calls.push({ fn: "finishRun", args: [t, run, status, counts, error] });
      if (opts.failFinish) throw new Error("finish failed");
    },
  };
  return { store, calls };
}

describe("R-003-26 期限のお知らせの定時の処理", () => {
  it("R-003-26 会社ごとに、記録を始め → お知らせを作り → 記録を閉じる", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"] });
    const s = await runRequestDue(store);
    expect(s).toEqual({ tenants: 2, skipped: 0, failedTenants: 0, requests: 4, notified: 6 });
    expect(calls.map((c) => `${c.fn}:${c.args[0] ?? ""}`)).toEqual([
      "tenants:", "startRun:tA", "notify:tA", "finishRun:tA", "startRun:tB", "notify:tB", "finishRun:tB",
    ]);
    expect(calls.find((c) => c.fn === "finishRun")!.args).toEqual(["tA", "run-tA", "success", { requests: 2, notified: 3 }, null]);
  });
  it("R-003-26 会社の ID は、会社の一覧から取ったものだけを使う（呼び出し側から渡さない）", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA"] });
    await runRequestDue(store);
    for (const c of calls.filter((x) => x.fn !== "tenants")) expect(c.args[0]).toBe("tA");
  });
  it("R-003-26 近い日数は既定 3 日（画面の部品と同じ）で、変えられる", async () => {
    expect(DEFAULT_DAYS).toBe(DUE_SOON_DAYS);
    const { store, calls } = fakeStore({ tenants: ["tA"] });
    await runRequestDue(store);
    await runRequestDue(store, 5);
    const days = calls.filter((c) => c.fn === "notify").map((c) => c.args[2]);
    expect(days).toEqual([3, 5]);
  });
  it("R-003-26 1つの会社の失敗は、その会社の記録に残り、ほかの会社を止めない", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"], failNotify: ["tA"] });
    const s = await runRequestDue(store);
    expect(s.failedTenants).toBe(1);
    expect(s.notified).toBe(3);
    const fin = calls.filter((c) => c.fn === "finishRun");
    expect(fin[0].args.slice(0, 3)).toEqual(["tA", "run-tA", "failure"]);
    expect(fin[1].args.slice(0, 3)).toEqual(["tB", "run-tB", "success"]);
  });
  it("R-003-26 失敗の記録に、長い鍵のような文字列を出さない", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA"], failNotify: ["tA"] });
    await runRequestDue(store);
    const fin = calls.find((c) => c.fn === "finishRun")!;
    expect(String(fin.args[4])).not.toContain("x".repeat(32));
  });
  it("R-003-26 すでに動いている会社は、飛ばす", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"], busy: ["tA"] });
    const s = await runRequestDue(store);
    expect(s.skipped).toBe(1);
    expect(calls.some((c) => c.fn === "notify" && c.args[0] === "tA")).toBe(false);
    expect(s.notified).toBe(3);
  });
  it("R-003-26 記録を閉じるのに失敗しても、次の会社へ進む", async () => {
    const { store } = fakeStore({ tenants: ["tA", "tB"], failNotify: ["tA", "tB"], failFinish: true });
    const s = await runRequestDue(store);
    expect(s.failedTenants).toBe(2);
  });
  it("R-003-26 対象の会社がなければ、何もしない", async () => {
    const { store, calls } = fakeStore({ tenants: [] });
    const s = await runRequestDue(store);
    expect(s).toEqual({ tenants: 0, skipped: 0, failedTenants: 0, requests: 0, notified: 0 });
    expect(calls).toHaveLength(1);
  });
});
