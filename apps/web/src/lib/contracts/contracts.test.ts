// 契約の画面の部品（R-010-26〜31）
import { describe, expect, it } from "vitest";
import { buildChanges, contractActionMessage, filterContracts, filterWorks, recurrenceLabel, sortServices, timeRange, validateStart } from "./format";
import type { Contract, ContractService, Work } from "./types";

const contract = (over: Partial<Contract>): Contract => ({
  id: "c1", tenant_id: "t", client_id: "cl1", building_id: "b1", source: "quote", quote_id: "q1", kind: "recurring",
  start_date: "2026-11-01", end_date: null, status: "active", created_at: "", deleted_at: null, ...over,
});
const service = (over: Partial<ContractService>): ContractService => ({
  id: "s1", tenant_id: "t", contract_id: "c1", service_key: "k1", service_kind: "base", name: "定期清掃", amount: 30000, billing: "monthly",
  recurrence: "FREQ=WEEKLY;BYDAY=MO", start_time: null, end_time: null, valid_from: "2026-11-01", valid_to: null, deleted_at: null, ...over,
});
const work = (over: Partial<Work>): Work => ({
  id: "w1", tenant_id: "t", building_id: "b1", contract_service_id: "s1", request_id: null, title: "定期清掃", scheduled_date: "2026-11-20",
  start_time: null, end_time: null, status: "scheduled", deleted_at: null, ...over,
});

describe("R-010-26 契約の一覧の絞り込み", () => {
  const names = { clients: { cl1: "青空管理株式会社", cl2: "星ビル" }, buildings: { b1: "ひまわりマンション", b2: "つばきビル" } };
  const list = [contract({ id: "a" }), contract({ id: "b", client_id: "cl2", building_id: "b2", status: "ended", end_date: "2026-12-01" })];
  it("取引先・建物の名前の一部（空白区切りはすべて含む）で絞る", () => {
    expect(filterContracts(list, names, { q: "青空", status: "" }).map((c) => c.id)).toEqual(["a"]);
    expect(filterContracts(list, names, { q: "星 つばき", status: "" }).map((c) => c.id)).toEqual(["b"]);
    expect(filterContracts(list, names, { q: "青空 つばき", status: "" })).toEqual([]);
  });
  it("状況で絞る", () => {
    expect(filterContracts(list, names, { q: "", status: "ended" }).map((c) => c.id)).toEqual(["b"]);
    expect(filterContracts(list, names, { q: "", status: "" })).toHaveLength(2);
  });
});

describe("R-010-27 頻度は日本語で出す", () => {
  it("毎月 第2火曜・3か月に1回・毎週月曜", () => {
    expect(recurrenceLabel("FREQ=MONTHLY;BYDAY=2TU")).toBe("毎月 第2火曜");
    expect(recurrenceLabel("FREQ=MONTHLY;INTERVAL=3")).toBe("3か月に1回");
    expect(recurrenceLabel("FREQ=WEEKLY;BYDAY=MO")).toBe("毎週 月曜");
  });
  it("単発は「1回だけ」。読めない形は元の文字列", () => {
    expect(recurrenceLabel("FREQ=DAILY;COUNT=1")).toBe("1回だけ（単発）");
    expect(recurrenceLabel("FREQ=SECONDLY")).toBe("FREQ=SECONDLY");
  });
  it("時刻は 09:00〜11:30。なければ空", () => {
    expect(timeRange("09:00:00", "11:30:00")).toBe("09:00〜11:30");
    expect(timeRange(null, null)).toBe("");
  });
});

describe("R-010-28 清掃の中身の並び", () => {
  it("今の中身を先に、閉じた古い行は開始日の新しい順", () => {
    const old1 = service({ id: "o1", valid_from: "2026-01-01", valid_to: "2026-05-31" });
    const old2 = service({ id: "o2", valid_from: "2026-06-01", valid_to: "2026-10-31" });
    const cur = service({ id: "cur", valid_from: "2026-11-01" });
    expect(sortServices([old1, cur, old2]).map((s) => s.id)).toEqual(["cur", "o2", "o1"]);
  });
});

describe("R-010-29 見積から契約を作る入力の検査と、断った理由の文面", () => {
  it("開始日が空・終了日が開始日より前は、理由を返す", () => {
    expect(validateStart("", "")).toBe("開始日を入れてください");
    expect(validateStart("2026-11-10", "2026-11-09")).toBe("終了日は開始日より後にしてください");
    expect(validateStart("2026-11-10", "")).toBeNull();
    expect(validateStart("2026-11-10", "2026-11-10")).toBeNull();
  });
  it("RPC の理由を日本語にする。知らない理由は理由の記号を添える", () => {
    expect(contractActionMessage("not_approved")).toBe("承認された見積からだけ、契約を作れます");
    expect(contractActionMessage("invoiced")).toContain("請求書に載っている");
    expect(contractActionMessage("zzz")).toBe("できませんでした（zzz）");
    expect(contractActionMessage(undefined)).toBe("できませんでした");
  });
});

describe("R-010-30 変更の入力は、変えたところだけの差分にする", () => {
  const cur = { name: "定期清掃", amount: 30000, recurrence: "FREQ=WEEKLY;BYDAY=MO" };
  it("金額だけ変えたら、金額だけ入る", () => {
    expect(buildChanges(cur, { name: "定期清掃", amount: "35000", recurrence: "FREQ=WEEKLY;BYDAY=MO" })).toEqual({ changes: { amount: 35000 }, error: null });
  });
  it("何も変えなければ差分は空", () => {
    expect(buildChanges(cur, { name: " 定期清掃 ", amount: "30000", recurrence: cur.recurrence }).changes).toEqual({});
  });
  it("名前が空・金額が整数でない・頻度の形が違うときは、理由を返す", () => {
    expect(buildChanges(cur, { name: " ", amount: "1", recurrence: cur.recurrence }).error).toBe("名前を入れてください");
    expect(buildChanges(cur, { name: "a", amount: "-1", recurrence: cur.recurrence }).error).toContain("金額");
    expect(buildChanges(cur, { name: "a", amount: "1.5", recurrence: cur.recurrence }).error).toContain("金額");
    expect(buildChanges(cur, { name: "a", amount: "1", recurrence: "" }).error).toBe("頻度を選んでください");
  });
});

describe("R-010-31 予定の一覧", () => {
  const works = [
    work({ id: "w3", scheduled_date: "2026-11-22" }),
    work({ id: "w1", scheduled_date: "2026-11-20", start_time: "13:00:00" }),
    work({ id: "w2", scheduled_date: "2026-11-20", start_time: "09:00:00" }),
    work({ id: "wc", scheduled_date: "2026-11-21", status: "cancelled" }),
    work({ id: "wb", scheduled_date: "2026-11-21", building_id: "b2" }),
  ];
  it("日付・時刻の順に並べ、取消は指定がなければ出さない", () => {
    expect(filterWorks(works, { status: "", building: "" }).map((w) => w.id)).toEqual(["w2", "w1", "wb", "w3"]);
  });
  it("状況・建物で絞れる", () => {
    expect(filterWorks(works, { status: "cancelled", building: "" }).map((w) => w.id)).toEqual(["wc"]);
    expect(filterWorks(works, { status: "", building: "b2" }).map((w) => w.id)).toEqual(["wb"]);
  });
});

describe("R-010-33 外部の人の専用ページの、作業の予定の区画", () => {
  it("登録すると登録簿に入り、何度登録しても1つ", async () => {
    const { portalSections } = await import("../files/portal");
    const { registerWorksPortalSection } = await import("./portal");
    registerWorksPortalSection();
    registerWorksPortalSection();
    expect(portalSections().filter((s) => s.id === "works")).toHaveLength(1);
  });
  it("建物の作業の日と状況だけを取る（作業の名前・担当・金額の列は取らず、取消は除く）", async () => {
    const { fakeClient } = await import("../../../tests/fakeClient");
    const { PORTAL_WORK_COLUMNS, worksPortalSection } = await import("./portal");
    const rows = [{ id: "w1", scheduled_date: "2026-11-20", status: "scheduled" }];
    const { client, calls } = fakeClient({ tables: { works: { data: rows } } });
    const items = await worksPortalSection.load(client, "b1");
    expect(items).toEqual([{ key: "w1", label: "2026年11月20日", detail: "予定" }]);
    const chain = calls.find((c) => c.kind === "from" && c.name === "works")!.chain!;
    expect(chain).toContainEqual(["eq", ["building_id", "b1"]]);
    expect(chain).toContainEqual(["neq", ["status", "cancelled"]]);
    expect(PORTAL_WORK_COLUMNS).toBe("id, scheduled_date, status");
  });
});
