// 機能 003 の画面の部品：期限の判定・入力の検査・絞り込みと並び・状況の操作の出し分け・端末へのため方
// （R-003-23・27・28・29。DB 側は supabase/tests/21_requests.sql）
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { flush, openOutbox, type Outbox, type Sender } from "../offline";
import { daysUntil, dueLabel, dueState, todayJst } from "./due";
import {
  canEditRequests,
  canSeeAmount,
  filterRequests,
  nextStatuses,
  sortRequests,
  statusMessage,
  STATUS_LABEL,
} from "./format";
import { enqueueObservation } from "./observation";
import type { RequestRow, RequestStatus } from "./types";
import { parseYen, validateCharge, validateObservation, validateRequest } from "./validate";

const TODAY = "2026-11-16";

function req(over: Partial<RequestRow>): RequestRow {
  return {
    id: "r" + Math.random().toString(36).slice(2, 8),
    tenant_id: "t",
    client_id: "c",
    building_id: "b1",
    room_id: null,
    source: "manual",
    category: "other",
    title: "案件",
    detail: null,
    due_date: null,
    assignee_id: null,
    status: "new",
    created_at: "2026-11-01T00:00:00Z",
    deleted_at: null,
    ...over,
  };
}

describe("R-003-23 期限の警告の判定", () => {
  it("R-003-23 日本時間の今日の日付を出す（UTC の15時で日が変わる）", () => {
    expect(todayJst(new Date("2026-11-15T14:59:59Z"))).toBe("2026-11-15");
    expect(todayJst(new Date("2026-11-15T15:00:00Z"))).toBe("2026-11-16");
  });
  it("R-003-23 あと何日（月またぎ・過ぎたもの）", () => {
    expect(daysUntil("2026-11-16", TODAY)).toBe(0);
    expect(daysUntil("2026-12-01", TODAY)).toBe(15);
    expect(daysUntil("2026-11-10", TODAY)).toBe(-6);
    expect(daysUntil(null, TODAY)).toBeNull();
  });
  it("R-003-23 今日より前は期限切れ、今日から3日後までは期限が近い、4日後からは遠い", () => {
    expect(dueState({ due_date: "2026-11-15", status: "new" }, TODAY)).toBe("overdue");
    expect(dueState({ due_date: "2026-11-16", status: "new" }, TODAY)).toBe("soon");
    expect(dueState({ due_date: "2026-11-19", status: "in_progress" }, TODAY)).toBe("soon");
    expect(dueState({ due_date: "2026-11-20", status: "new" }, TODAY)).toBe("later");
  });
  it("R-003-23 完了・取消・期限なしは警告しない", () => {
    expect(dueState({ due_date: "2026-11-01", status: "done" }, TODAY)).toBe("none");
    expect(dueState({ due_date: "2026-11-01", status: "cancelled" }, TODAY)).toBe("none");
    expect(dueState({ due_date: null, status: "new" }, TODAY)).toBe("none");
  });
  it("R-003-23 近い日数は変えられる（定時の処理の引数と同じ）", () => {
    expect(dueState({ due_date: "2026-11-20", status: "new" }, TODAY, 5)).toBe("soon");
  });
  it("R-003-23 画面の文言", () => {
    expect(dueLabel({ due_date: "2026-11-14", status: "new" }, TODAY)).toBe("期限切れ（2日過ぎ）");
    expect(dueLabel({ due_date: "2026-11-16", status: "new" }, TODAY)).toBe("今日が期限");
    expect(dueLabel({ due_date: "2026-11-18", status: "new" }, TODAY)).toBe("期限が近い（あと2日）");
    expect(dueLabel({ due_date: null, status: "new" }, TODAY)).toBe("期限なし");
  });
});

describe("R-003-28 入力の検査（DB の check と同じ決まり）", () => {
  const ok = { title: "水漏れ", building_id: "b1", client_id: "c1" };
  it("R-003-28 題名・建物・依頼元が必要", () => {
    expect(validateRequest(ok)).toEqual({});
    expect(validateRequest({ ...ok, title: "" }).title).toBeTruthy();
    expect(validateRequest({ ...ok, title: "   " }).title).toBeTruthy();
    expect(validateRequest({ ...ok, building_id: "" }).building_id).toBeTruthy();
    expect(validateRequest({ ...ok, client_id: "" }).client_id).toBeTruthy();
  });
  it("R-003-28 題名は100字まで、内容は2000字まで", () => {
    expect(validateRequest({ ...ok, title: "あ".repeat(100) })).toEqual({});
    expect(validateRequest({ ...ok, title: "あ".repeat(101) }).title).toBeTruthy();
    expect(validateRequest({ ...ok, detail: "あ".repeat(2001) }).detail).toBeTruthy();
  });
  it("R-003-28 分類は決まった値だけ。期限は正しい日付だけ（空はよい）", () => {
    expect(validateRequest({ ...ok, category: "repair" })).toEqual({});
    expect(validateRequest({ ...ok, category: "x" }).category).toBeTruthy();
    expect(validateRequest({ ...ok, due_date: "" })).toEqual({});
    expect(validateRequest({ ...ok, due_date: "2026-11-30" })).toEqual({});
    expect(validateRequest({ ...ok, due_date: "2026-02-30" }).due_date).toBeTruthy();
    expect(validateRequest({ ...ok, due_date: "11/30" }).due_date).toBeTruthy();
  });
  it("R-003-28 気づき：建物と題名だけが必須", () => {
    expect(validateObservation({ title: "しみ", building_id: "b1" })).toEqual({});
    expect(validateObservation({ title: "", building_id: "" })).toMatchObject({ title: expect.any(String), building_id: expect.any(String) });
  });
  it("R-003-28 金額は0以上の整数（円・カンマ・全角はよい）", () => {
    expect(validateCharge({ amount: "0" })).toEqual({});
    expect(validateCharge({ amount: "12,000円" })).toEqual({});
    expect(parseYen("１２０００")).toBe(12000);
    expect(validateCharge({ amount: "" }).amount).toBeTruthy();
    expect(validateCharge({ amount: "-1" }).amount).toBeTruthy();
    expect(validateCharge({ amount: "1.5" }).amount).toBeTruthy();
    expect(validateCharge({ amount: "abc" }).amount).toBeTruthy();
    expect(validateCharge({ amount: "99999999999" }).amount).toBeTruthy();
  });
});

describe("R-003-27 絞り込みと並び", () => {
  const rows = [
    req({ id: "over", due_date: "2026-11-10", status: "in_progress", building_id: "b1", assignee_id: "m1" }),
    req({ id: "soon", due_date: "2026-11-18", building_id: "b2", assignee_id: "m2" }),
    req({ id: "week", due_date: "2026-11-22", building_id: "b1" }),
    req({ id: "later", due_date: "2026-12-30", building_id: "b1", assignee_id: "m1" }),
    req({ id: "none", due_date: null, building_id: "b2" }),
    req({ id: "done", due_date: "2026-11-01", status: "done", building_id: "b1" }),
    req({ id: "cancel", due_date: null, status: "cancelled", building_id: "b1" }),
  ];
  const ids = (xs: RequestRow[]) => xs.map((r) => r.id);

  it("R-003-27 初めは、完了・取消を出さない", () => {
    expect(ids(filterRequests(rows, {}, TODAY))).toEqual(["over", "soon", "week", "later", "none"]);
  });
  it("R-003-27 状況で絞る（すべて・完了・取消も出せる）", () => {
    expect(ids(filterRequests(rows, { status: "all" }, TODAY))).toHaveLength(7);
    expect(ids(filterRequests(rows, { status: "done" }, TODAY))).toEqual(["done"]);
    expect(ids(filterRequests(rows, { status: "in_progress" }, TODAY))).toEqual(["over"]);
  });
  it("R-003-27 期限で絞る（期限切れ・近い・今週・期限なし）", () => {
    expect(ids(filterRequests(rows, { due: "overdue" }, TODAY))).toEqual(["over"]);
    expect(ids(filterRequests(rows, { due: "soon" }, TODAY))).toEqual(["soon"]);
    expect(ids(filterRequests(rows, { due: "week" }, TODAY))).toEqual(["soon", "week"]);
    expect(ids(filterRequests(rows, { due: "none" }, TODAY))).toEqual(["none"]);
  });
  it("R-003-27 建物・担当で絞る（担当なしも）", () => {
    expect(ids(filterRequests(rows, { building_id: "b2" }, TODAY))).toEqual(["soon", "none"]);
    expect(ids(filterRequests(rows, { assignee_id: "m1" }, TODAY))).toEqual(["over", "later"]);
    expect(ids(filterRequests(rows, { assignee_id: "none" }, TODAY))).toEqual(["week", "none"]);
  });
  it("R-003-27 条件は重ねられる", () => {
    expect(ids(filterRequests(rows, { building_id: "b1", assignee_id: "m1", due: "overdue" }, TODAY))).toEqual(["over"]);
  });
  it("R-003-27 並びは、期限切れ → 近い → 遠い → 期限なし。同じ中は期限の早い順、次に新しい順", () => {
    const more = [
      ...rows,
      req({ id: "later2", due_date: "2026-12-01" }),
      req({ id: "none-new", due_date: null, created_at: "2026-11-15T00:00:00Z" }),
      req({ id: "over2", due_date: "2026-11-05" }),
    ];
    expect(ids(sortRequests(filterRequests(more, {}, TODAY), TODAY))).toEqual([
      "over2", "over", "soon", "week", "later2", "later", "none-new", "none",
    ]);
  });
  it("R-003-27 並べ替えは元の配列を変えない", () => {
    const before = ids(rows);
    sortRequests(rows, TODAY);
    expect(ids(rows)).toEqual(before);
  });
});

describe("R-003-29 状況の操作の出し分け（DB の set_request_status と同じ決まり）", () => {
  const editor = { editor: true, assignee: false };
  const staff = { editor: false, assignee: true };
  const nobody = { editor: false, assignee: false };
  it("R-003-29 管理者・社員は、許された切り替えを出す", () => {
    expect(nextStatuses("new", editor)).toEqual(["in_progress", "done", "cancelled"]);
    expect(nextStatuses("in_progress", editor)).toEqual(["new", "done", "cancelled"]);
    expect(nextStatuses("done", editor)).toEqual(["in_progress"]);
    expect(nextStatuses("cancelled", editor)).toEqual(["new"]);
  });
  it("R-003-29 担当のスタッフには、進める切り替えだけを出す（取消・戻しは出さない）", () => {
    expect(nextStatuses("new", staff)).toEqual(["in_progress", "done"]);
    expect(nextStatuses("in_progress", staff)).toEqual(["done"]);
    expect(nextStatuses("done", staff)).toEqual([]);
    expect(nextStatuses("cancelled", staff)).toEqual([]);
  });
  it("R-003-29 担当でないスタッフ・外部の人には何も出さない", () => {
    for (const s of ["new", "in_progress", "done", "cancelled"] as RequestStatus[]) expect(nextStatuses(s, nobody)).toEqual([]);
  });
  it("R-003-29 金額と案件の編集は、権限を持つ人にだけ出す", () => {
    expect(canSeeAmount(["amount.read", "request.edit"])).toBe(true);
    expect(canSeeAmount(["field.record"])).toBe(false);
    expect(canEditRequests(["request.edit"])).toBe(true);
    expect(canEditRequests(["field.record", "amount.read"])).toBe(false);
  });
  it("R-003-29 切り替えの結果を日本語にする", () => {
    expect(statusMessage({ ok: true, changed: true, status: "done" })).toBe(`状況を「${STATUS_LABEL.done}」にしました`);
    expect(statusMessage({ ok: true, changed: false, status: "done" })).toBe("すでにその状況です");
    expect(statusMessage({ ok: false, reason: "billed" })).toContain("請求書");
    expect(statusMessage({ ok: false, reason: "forbidden_transition" })).toContain("管理者・社員");
    expect(statusMessage({ ok: false, reason: "invalid_transition", from: "done", to: "cancelled" })).toBe("「完了」から「取消」には変えられません");
  });
});

describe("R-003-15 現場の気づきを端末にためる", () => {
  let box: Outbox;
  let n = 0;
  const scope = { tenantId: "t-a", membershipId: "m-staff" };
  const sent: Array<{ target: string; id: string; payload: Record<string, unknown> }> = [];
  const okSender: Sender = {
    async send(it) {
      sent.push({ target: it.target, id: it.id, payload: it.payload });
      return { ok: true };
    },
  };
  const offline: Sender = { async send() { return { ok: false, kind: "network", message: "Failed to fetch" }; } };

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    sent.length = 0;
    box = await openOutbox(`req-outbox-${n++}`);
  });

  it("R-003-15 電波がない間は、RPC と引数を端末にため、送れるまで消さない", async () => {
    await enqueueObservation(box, scope, { building_id: "b1", title: " 天井のしみ ", detail: "3階" });
    expect(await box.pendingCount()).toBe(1);
    const r = await flush(box, offline);
    expect(r.offline).toBe(true);
    expect(await box.pendingCount()).toBe(1);
  });
  it("R-003-15 電波が戻ると、端末の uuid（p_id）つきで create_request_from_observation を送る", async () => {
    const item = await enqueueObservation(box, scope, { building_id: "b1", title: "しみ", category: "repair" });
    await flush(box, okSender);
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toBe("create_request_from_observation");
    expect(sent[0].id).toBe(item.id);
    expect(sent[0].payload).toMatchObject({ p_building_id: "b1", p_title: "しみ", p_category: "repair", p_detail: null, p_room_id: null });
    expect(await box.pendingCount()).toBe(0);
  });
  it("R-003-15 同じ uuid を二度ためても、1件", async () => {
    await enqueueObservation(box, scope, { id: "same-id", building_id: "b1", title: "しみ" });
    await enqueueObservation(box, scope, { id: "same-id", building_id: "b1", title: "しみ" });
    expect(await box.pendingCount()).toBe(1);
  });
});
