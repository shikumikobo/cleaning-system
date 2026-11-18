// 機能 012 の画面の部品：自分の予定・開始と終了のため方・予定表の組み立て・予実の判定・入力の検査
// （R-012-27〜34。DB 側は supabase/tests/25_schedule.sql。画面の流れは e2e/schedule.e2e.ts）
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { flush, openOutbox, type Outbox, type OutboxItem, type Sender } from "../offline";
import { addDays, daysOf, groupSchedule, monthRange, overlapMap, overlapText, rangeFor, rangeTitle, shiftAnchor, UNASSIGNED, weekStart } from "./calendar";
import { enqueueFinish, enqueueStart, fieldState, myWorks, pendingFor, reportHref, splitToday } from "./field";
import {
  countReview,
  dayLabel,
  filterReview,
  gapLabel,
  GAP_MINUTES,
  minutesLabel,
  reviewFlags,
  scheduleAccess,
  sumMonthly,
  validateNewWork,
  validateReschedule,
  workActionMessage,
} from "./format";
import type { AssignmentRow, MonthlyRow, OverlapRow, PlanActualRow, WorkRecordRow, WorkRow } from "./types";

const TODAY = "2026-11-17";

function work(over: Partial<WorkRow>): WorkRow {
  return {
    id: "w" + Math.random().toString(36).slice(2, 8),
    tenant_id: "t",
    building_id: "b1",
    contract_service_id: "s1",
    request_id: null,
    service_key: "k",
    title: "定期清掃",
    scheduled_date: TODAY,
    start_time: null,
    end_time: null,
    status: "scheduled",
    version: 1,
    run_id: null,
    deleted_at: null,
    ...over,
  };
}
const asg = (workId: string, member: string): AssignmentRow => ({ id: `${workId}-${member}`, tenant_id: "t", work_id: workId, membership_id: member, deleted_at: null });
const rec = (workId: string, over: Partial<WorkRecordRow> = {}): WorkRecordRow => ({
  id: "r-" + workId,
  tenant_id: "t",
  work_id: workId,
  membership_id: "me",
  started_at: "2026-11-17T00:00:00Z",
  ended_at: null,
  deleted_at: null,
  ...over,
});
function pa(over: Partial<PlanActualRow>): PlanActualRow {
  return {
    tenant_id: "t",
    work_id: "w",
    building_id: "b1",
    title: "定期清掃",
    scheduled_date: TODAY,
    start_time: null,
    end_time: null,
    status: "done",
    first_started_at: null,
    last_ended_at: null,
    open_records: null,
    actual_minutes: 0,
    start_gap_min: null,
    end_gap_min: null,
    report_id: null,
    report_status: "submitted",
    items_total: 0,
    items_skipped: 0,
    not_done: false,
    unfinished: false,
    report_missing: false,
    ...over,
  };
}

describe("自分の予定", () => {
  it("R-012-27 自分が担当の、取消でない作業だけが、日付・時刻の順に出る", () => {
    const a = work({ id: "a", scheduled_date: "2026-11-18", start_time: "09:00:00" });
    const b = work({ id: "b", scheduled_date: TODAY, start_time: "13:00:00" });
    const c = work({ id: "c", scheduled_date: TODAY, start_time: "09:00:00" });
    const d = work({ id: "d", scheduled_date: TODAY, status: "cancelled" });
    const e = work({ id: "e", scheduled_date: TODAY });
    const list = myWorks([a, b, c, d, e], new Set(["a", "b", "c", "d"]));
    expect(list.map((w) => w.id)).toEqual(["c", "b", "a"]);
  });
  it("R-012-27 今日の分と、それ以降に分かれる", () => {
    const list = [work({ id: "t1" }), work({ id: "l1", scheduled_date: "2026-11-20" })];
    const s = splitToday(list, TODAY);
    expect(s.today.map((w) => w.id)).toEqual(["t1"]);
    expect(s.later.map((w) => w.id)).toEqual(["l1"]);
  });
  it("R-012-27 日付は 11/17（火）の形で出る", () => {
    expect(dayLabel("2026-11-17")).toBe("11/17（火）");
  });
});

describe("開始・終了のため方", () => {
  let box: Outbox;
  const scope = { tenantId: "t", membershipId: "me", deviceId: "dev-1" };
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    box = await openOutbox("w-" + Math.random());
  });

  it("R-012-28 開始は、呼ぶ RPC と引数を端末にため、電波がなければ残る", async () => {
    const { item, duplicate } = await enqueueStart(box, scope, "w1", new Date("2026-11-17T00:05:00Z"));
    expect(duplicate).toBe(false);
    expect(item.kind).toBe("rpc");
    expect(item.target).toBe("start_work");
    expect(item.payload).toMatchObject({ p_work_id: "w1", p_started_at: "2026-11-17T00:05:00.000Z", p_device_id: "dev-1" });
    const offline: Sender = { send: async () => ({ ok: false, kind: "network", message: "offline" }) };
    const r = await flush(box, offline);
    expect(r.offline).toBe(true);
    expect(await box.pendingCount()).toBe(1);
  });
  it("R-012-28 二度押しても、同じ作業の開始は1件だけ", async () => {
    const a = await enqueueStart(box, scope, "w1");
    const b = await enqueueStart(box, scope, "w1");
    expect(b.duplicate).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    expect(await box.pendingCount()).toBe(1);
    const f1 = await enqueueFinish(box, scope, "w1");
    const f2 = await enqueueFinish(box, scope, "w1");
    expect(f2.duplicate).toBe(true);
    expect(f1.item.id).not.toBe(a.item.id);
    expect(await box.pendingCount()).toBe(2);
  });
  it("R-012-28 電波が戻ると、開始 → 終了の順に、端末の uuid（p_id）つきで送る。開始と終了の印はぶつからない", async () => {
    const s = await enqueueStart(box, scope, "w1");
    const f = await enqueueFinish(box, scope, "w1", new Date("2026-11-17T02:00:00Z"));
    const sent: OutboxItem[] = [];
    const ok: Sender = { send: async (i) => (sent.push(i), { ok: true }) };
    await flush(box, ok);
    expect(sent.map((i) => i.target)).toEqual(["start_work", "finish_work"]);
    expect(sent[0].id).toBe(s.item.id);
    expect(sent[1].id).toBe(f.item.id);
    expect(sent[1].payload).toMatchObject({ p_work_id: "w1", p_ended_at: "2026-11-17T02:00:00.000Z" });
    expect(await box.pendingCount()).toBe(0);
  });
  it("R-012-28 送信待ちは、作業ごとに分かる", async () => {
    await enqueueStart(box, scope, "w1");
    const items = await box.list();
    expect(pendingFor(items, "w1").start).not.toBeNull();
    expect(pendingFor(items, "w1").finish).toBeNull();
    expect(pendingFor(items, "w2").start).toBeNull();
  });

  const none = { start: null, finish: null };
  const fake = (target: string): OutboxItem => ({ id: "x", kind: "rpc", target, tenantId: "t", payload: {}, clientCreatedAt: "", seq: 1, attempts: 0 });
  it("R-012-28 予定の作業には「開始」、自分の記録が開いている作業には「終了」を出す", () => {
    expect(fieldState({ id: "w1", status: "scheduled" }, [], none)).toMatchObject({ action: "start", status: "scheduled", pending: false });
    expect(fieldState({ id: "w1", status: "in_progress" }, [rec("w1")], none)).toMatchObject({ action: "finish", status: "in_progress" });
  });
  it("R-012-28 ほかの人が開始しただけの作業（自分の記録なし）には「開始」を出す", () => {
    expect(fieldState({ id: "w1", status: "in_progress" }, [], none)).toMatchObject({ action: "start", status: "in_progress" });
  });
  it("R-012-28 開始が送信待ちなら、「作業中」と先に見せ、「終了」を出す", () => {
    expect(fieldState({ id: "w1", status: "scheduled" }, [], { start: fake("start_work"), finish: null })).toEqual({ action: "finish", pending: true, status: "in_progress" });
  });
  it("R-012-28 終了が送信待ちなら、「完了」と先に見せ、ボタンは出さない", () => {
    expect(fieldState({ id: "w1", status: "in_progress" }, [rec("w1")], { start: null, finish: fake("finish_work") })).toEqual({ action: null, pending: true, status: "done" });
  });
  it("R-012-28 完了・行わず・取消の作業には、ボタンを出さない", () => {
    for (const status of ["done", "skipped", "cancelled"] as const) expect(fieldState({ id: "w1", status }, [], none).action).toBeNull();
  });
  it("R-012-29 行った項目は、作業の ID を付けた報告書の画面で付ける", () => {
    expect(reportHref("w 1")).toBe("/reports/edit/?work=w%201");
  });
});

describe("予定表", () => {
  it("R-012-30 日・週・月の期間が決まる（週は月曜から）", () => {
    expect(rangeFor("day", "2026-11-17")).toEqual({ from: "2026-11-17", to: "2026-11-17" });
    expect(weekStart("2026-11-22")).toBe("2026-11-16");
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    expect(rangeFor("week", "2026-11-17")).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(rangeFor("month", "2026-11-17")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(monthRange("2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(daysOf("2026-11-16", "2026-11-22")).toHaveLength(7);
  });
  it("R-012-30 前後へ動かせる（月末は、その月の末日に丸める）", () => {
    expect(shiftAnchor("day", "2026-11-17", 1)).toBe("2026-11-18");
    expect(shiftAnchor("week", "2026-11-17", -1)).toBe("2026-11-10");
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftAnchor("month", "2026-01-15", -1)).toBe("2025-12-15");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("R-012-30 期間の見出し", () => {
    expect(rangeTitle("day", "2026-11-17")).toBe("2026年11月17日");
    expect(rangeTitle("week", "2026-11-17")).toBe("2026年11月16日〜11月22日");
    expect(rangeTitle("month", "2026-11-17")).toBe("2026年11月");
  });

  const names = { staff: { s1: "青木", s2: "石田" }, buildings: { b1: "ひまわりマンション", b2: "さくらビル" } };
  const w1 = work({ id: "w1", building_id: "b1", scheduled_date: "2026-11-18", start_time: "13:00:00" });
  const w2 = work({ id: "w2", building_id: "b2", scheduled_date: "2026-11-17", start_time: "09:00:00" });
  const w3 = work({ id: "w3", building_id: "b1", scheduled_date: "2026-11-17" });
  const w4 = work({ id: "w4", building_id: "b1", status: "cancelled" });
  const as = [asg("w1", "s1"), asg("w1", "s2"), asg("w2", "s1")];

  it("R-012-30 スタッフごと：担当が2人の作業は2人の下に出て、担当のない作業は「担当なし」にまとまる。取消は出ない", () => {
    const g = groupSchedule([w1, w2, w3, w4], as, "staff", names);
    expect(g.map((x) => x.label)).toEqual(["青木", "石田", "担当なし"]);
    expect(g[0].works.map((w) => w.id)).toEqual(["w2", "w1"]); // 日付の順
    expect(g[1].works.map((w) => w.id)).toEqual(["w1"]);
    expect(g[2].key).toBe(UNASSIGNED);
    expect(g[2].works.map((w) => w.id)).toEqual(["w3"]);
  });
  it("R-012-30 建物ごと", () => {
    const g = groupSchedule([w1, w2, w3, w4], as, "building", names);
    expect(g.map((x) => x.label)).toEqual(["さくらビル", "ひまわりマンション"]);
    expect(g[1].works.map((w) => w.id)).toEqual(["w3", "w1"]);
  });
  it("R-012-30 時刻の重なりは、警告の文になる。なければ空", () => {
    const o: OverlapRow[] = [{ tenant_id: "t", membership_id: "s1", work_id: "w1", other_work_id: "w2", scheduled_date: "2026-11-18" }];
    const m = overlapMap(o);
    expect(overlapText("w1", m, [w1, w2])).toContain("時刻が重なっています");
    expect(overlapText("w1", m, [w1, w2])).toContain("定期清掃");
    expect(overlapText("w3", m, [w1, w2, w3])).toBe("");
  });
});

describe("作業の操作", () => {
  it("R-012-31 断られた理由が、日本語で出る。版の食い違いは「ほかの人が直しています」", () => {
    expect(workActionMessage("conflict")).toContain("ほかの人が直しています");
    expect(workActionMessage("has_record")).toContain("入れ替えられません");
    expect(workActionMessage("invoiced")).toContain("請求書");
    expect(workActionMessage("duplicate_date")).toContain("同じ中身");
    expect(workActionMessage("unknown_reason")).toContain("unknown_reason");
    expect(workActionMessage(undefined)).toBe("できませんでした");
  });
  it("R-012-31 日付・時刻の変更の入力を、呼ぶ前に確かめる", () => {
    expect(validateReschedule({ date: "", start: "", end: "" })).toBe("日付を入れてください");
    expect(validateReschedule({ date: "2026-11-20", start: "15:00", end: "14:00" })).toContain("終了の時刻");
    expect(validateReschedule({ date: "2026-11-20", start: "09:00", end: "10:00" })).toBeNull();
    expect(validateReschedule({ date: "2026-11-20", start: "", end: "" })).toBeNull();
  });
  it("R-012-32 作業を足す入力を、呼ぶ前に確かめる", () => {
    const base = { source: "service" as const, serviceId: "s", requestId: "", date: "2026-11-20", start: "", end: "" };
    expect(validateNewWork({ ...base, serviceId: "" })).toBe("契約の中身を選んでください");
    expect(validateNewWork({ ...base, source: "request" })).toBe("案件を選んでください");
    expect(validateNewWork({ ...base, date: "" })).toBe("日付を入れてください");
    expect(validateNewWork({ ...base, start: "10:00", end: "09:00" })).toContain("終了の時刻");
    expect(validateNewWork(base)).toBeNull();
    expect(validateNewWork({ ...base, source: "request", serviceId: "", requestId: "r" })).toBeNull();
  });
});

describe("予実", () => {
  it("R-012-33 時刻のずれは 30 分以上で「ずれ」になる", () => {
    expect(GAP_MINUTES).toBe(30);
    expect(reviewFlags(pa({ start_gap_min: 29, end_gap_min: -29 }))).toEqual([]);
    expect(reviewFlags(pa({ start_gap_min: 30 }))).toEqual(["time_gap"]);
    expect(reviewFlags(pa({ start_gap_min: 0, end_gap_min: -45 }))).toEqual(["time_gap"]);
    expect(reviewFlags(pa({ start_gap_min: null, end_gap_min: null }))).toEqual([]);
  });
  it("R-012-33 行っていない・終わっていない・行わなかった項目・出ていない報告書の印が付く", () => {
    expect(reviewFlags(pa({ not_done: true, status: "scheduled" }))).toEqual(["not_done"]);
    expect(reviewFlags(pa({ unfinished: true, status: "in_progress" }))).toEqual(["unfinished"]);
    expect(reviewFlags(pa({ items_total: 3, items_skipped: 2 }))).toEqual(["items_skipped"]);
    expect(reviewFlags(pa({ report_missing: true, report_status: "draft" }))).toEqual(["report_missing"]);
  });
  const rows = [
    pa({ work_id: "a", scheduled_date: "2026-11-05", not_done: true, status: "scheduled" }),
    pa({ work_id: "b", scheduled_date: "2026-11-03", start_gap_min: 40, report_missing: true }),
    pa({ work_id: "c", scheduled_date: "2026-11-04" }),
    pa({ work_id: "d", scheduled_date: "2026-11-06", items_total: 2, items_skipped: 1 }),
  ];
  it("R-012-33 種類で絞る。指定がなければ、印のあるものだけ。日付の順", () => {
    expect(filterReview(rows, "").map((r) => r.work_id)).toEqual(["b", "a", "d"]);
    expect(filterReview(rows, "report_missing").map((r) => r.work_id)).toEqual(["b"]);
    expect(filterReview(rows, "time_gap").map((r) => r.work_id)).toEqual(["b"]);
    expect(filterReview(rows, "items_skipped").map((r) => r.work_id)).toEqual(["d"]);
  });
  it("R-012-33 種類ごとの件数", () => {
    expect(countReview(rows)).toEqual({ not_done: 1, unfinished: 0, time_gap: 1, items_skipped: 1, report_missing: 1 });
  });
  it("R-012-33 月ごとの集計は、建物ごとの行を足して全体にする", () => {
    const m = (over: Partial<MonthlyRow>): MonthlyRow => ({
      tenant_id: "t", month: "2026-11-01", building_id: "b", planned: 0, done: 0, skipped: 0, cancelled: 0, not_done: 0, report_missing: 0, planned_minutes: 0, actual_minutes: 0, ...over,
    });
    expect(sumMonthly([m({ planned: 4, done: 2, planned_minutes: 120, actual_minutes: 150, not_done: 1 }), m({ planned: 3, done: 3, skipped: 1, cancelled: 2, report_missing: 1, planned_minutes: 60, actual_minutes: 30 })])).toEqual({
      planned: 7, done: 5, skipped: 1, cancelled: 2, not_done: 1, report_missing: 1, planned_minutes: 180, actual_minutes: 180,
    });
    expect(sumMonthly([]).planned).toBe(0);
  });
  it("R-012-33 ずれと時間の言い方", () => {
    expect(gapLabel("start", 20)).toBe("開始が20分遅れ");
    expect(gapLabel("end", -10)).toBe("終了が10分早め");
    expect(gapLabel("start", 0)).toBe("開始は予定どおり");
    expect(gapLabel("start", null)).toBe("");
    expect(minutesLabel(90)).toBe("1時間30分");
    expect(minutesLabel(60)).toBe("1時間");
    expect(minutesLabel(0)).toBe("0分");
  });
});

describe("権限の出し分け", () => {
  it("R-012-34 work.assign があれば全部、field.record だけなら自分の予定だけ、どちらもなければ何も出さない", () => {
    expect(scheduleAccess(["work.assign", "field.record"])).toEqual({ manage: true, mine: true });
    expect(scheduleAccess(["field.record"])).toEqual({ manage: false, mine: true });
    expect(scheduleAccess(["request.edit"])).toEqual({ manage: false, mine: false });
    expect(scheduleAccess([])).toEqual({ manage: false, mine: false });
  });
});
