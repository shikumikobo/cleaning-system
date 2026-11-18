// 機能 002 の画面の部品：入力の検査・候補・検索・消せない理由の文面（R-002-23・24）
import { describe, expect, it } from "vitest";
import { validateArea, validateBuilding, validateClient, validateContact, validateRoom } from "./validate";
import {
  closingDayLabel,
  deleteMessage,
  filterByName,
  kindLabel,
  selectableCandidates,
  sortAreas,
  sortRooms,
} from "./format";

describe("R-002-23 入力の検査（DB の check と同じ決まり）", () => {
  it("R-002-23 取引先：正しい入力は通る", () => {
    expect(validateClient({ kind: "owner", name: "テスト商事", email: "a@example.test", closing_day: "31" })).toEqual({});
  });
  it("R-002-23 取引先：名前が空・空白だけならエラー", () => {
    expect(validateClient({ kind: "owner", name: "" }).name).toBeTruthy();
    expect(validateClient({ kind: "owner", name: "   " }).name).toBeTruthy();
  });
  it("R-002-23 取引先：種類が決まった値以外ならエラー", () => {
    expect(validateClient({ kind: "", name: "x" }).kind).toBeTruthy();
    expect(validateClient({ kind: "tenant", name: "x" }).kind).toBeTruthy();
  });
  it("R-002-23 取引先：締め日は 1〜31 の整数（空はよい）", () => {
    expect(validateClient({ kind: "owner", name: "x", closing_day: "" })).toEqual({});
    expect(validateClient({ kind: "owner", name: "x", closing_day: "0" }).closing_day).toBeTruthy();
    expect(validateClient({ kind: "owner", name: "x", closing_day: "32" }).closing_day).toBeTruthy();
    expect(validateClient({ kind: "owner", name: "x", closing_day: "2.5" }).closing_day).toBeTruthy();
    expect(validateClient({ kind: "owner", name: "x", closing_day: "abc" }).closing_day).toBeTruthy();
  });
  it("R-002-23 取引先：メールは @ をはさんで空でない形（空はよい）", () => {
    expect(validateClient({ kind: "owner", name: "x", email: "" })).toEqual({});
    expect(validateClient({ kind: "owner", name: "x", email: "no-at-mark" }).email).toBeTruthy();
    expect(validateClient({ kind: "owner", name: "x", email: "a b@example.test" }).email).toBeTruthy();
  });
  it("R-002-23 担当者：名前が必要", () => {
    expect(validateContact({ name: "" }).name).toBeTruthy();
    expect(validateContact({ name: "担当", email: "bad" }).email).toBeTruthy();
    expect(validateContact({ name: "担当", email: "a@example.test" })).toEqual({});
  });
  it("R-002-23 建物：名前・住所・依頼元が必要", () => {
    const e = validateBuilding({ name: "", address: "", client_id: "" });
    expect(e.name && e.address && e.client_id).toBeTruthy();
    expect(validateBuilding({ name: "マンション", address: "東京都", client_id: "c1" })).toEqual({});
  });
  it("R-002-23 建物：位置は両方か両方空。緯度 -90〜90、経度 -180〜180", () => {
    const base = { name: "x", address: "y", client_id: "c" };
    expect(validateBuilding({ ...base, lat: "35.6", lng: "" }).lat).toBeTruthy();
    expect(validateBuilding({ ...base, lat: "", lng: "139" }).lat).toBeTruthy();
    expect(validateBuilding({ ...base, lat: "91", lng: "139" }).lat).toBeTruthy();
    expect(validateBuilding({ ...base, lat: "35", lng: "181" }).lng).toBeTruthy();
    expect(validateBuilding({ ...base, lat: "35.68", lng: "139.76" })).toEqual({});
    expect(validateBuilding({ ...base, lat: "", lng: "" })).toEqual({});
  });
  it("R-002-23 部屋・場所：部屋番号・名前が必要。階は整数", () => {
    expect(validateRoom({ room_no: " " }).room_no).toBeTruthy();
    expect(validateRoom({ room_no: "101", floor: "1.5" }).floor).toBeTruthy();
    expect(validateRoom({ room_no: "101", floor: "" })).toEqual({});
    expect(validateArea({ name: "" }).name).toBeTruthy();
    expect(validateArea({ name: "階段", sort: "x" }).sort).toBeTruthy();
    expect(validateArea({ name: "階段", sort: "2" })).toEqual({});
  });
});

describe("R-002-23 候補・検索・並び", () => {
  const rooms = [
    { id: "1", room_no: "201", floor: 2, active: true },
    { id: "2", room_no: "101", floor: 1, active: true },
    { id: "3", room_no: "102", floor: 1, active: false },
    { id: "4", room_no: "B1", floor: -1, active: true },
  ];
  it("R-002-12 新しく選ぶ候補に、「使わない」を出さない", () => {
    expect(selectableCandidates(rooms).map((r) => r.id)).toEqual(["1", "2", "4"]);
  });
  it("R-002-12 一覧には「使わない」も残る（印をつけて出す）", () => {
    expect(sortRooms(rooms).map((r) => r.id)).toEqual(["4", "2", "3", "1"]);
  });
  it("R-002-23 場所は並び順、同じなら名前で並べる", () => {
    const areas = [
      { id: "a", name: "屋上", sort: 3, active: true },
      { id: "b", name: "エントランス", sort: 1, active: true },
      { id: "c", name: "階段", sort: 1, active: true },
    ];
    expect(sortAreas(areas).map((a) => a.id)).toEqual(["b", "c", "a"]);
  });
  it("R-002-21 名前の部分一致で絞る（全角半角・大文字小文字・空白区切りの語を同じに扱う）", () => {
    const items = [{ name: "ＡＢＣマンション" }, { name: "abcビル" }, { name: "つきみ荘" }];
    expect(filterByName(items, "abc")).toHaveLength(2);
    expect(filterByName(items, "ＡＢＣ ビル")).toHaveLength(1);
    expect(filterByName(items, "")).toHaveLength(3);
    expect(filterByName(items, "ほしぞら")).toHaveLength(0);
  });
  it("R-002-23 ラベル", () => {
    expect(kindLabel("management_company")).toBe("管理会社");
    expect(kindLabel("owner")).toBe("オーナー");
    expect(closingDayLabel(31)).toBe("月末");
    expect(closingDayLabel(20)).toBe("20日");
    expect(closingDayLabel(null)).toBe("");
  });
});

describe("R-002-24 消せなかったときの理由", () => {
  it("R-002-24 建物があるので消せない取引先：理由と件数を日本語で出す", () => {
    const msg = deleteMessage("client", { ok: false, reason: "in_use", blockers: [{ reason: "has_buildings", table: "buildings", count: 3 }] });
    expect(msg).toContain("消せません");
    expect(msg).toContain("建物");
    expect(msg).toContain("3");
  });
  it("R-002-24 契約と請求書の両方があれば、両方を出す", () => {
    const msg = deleteMessage("client", {
      ok: false,
      reason: "in_use",
      blockers: [
        { reason: "has_contracts", table: "contracts", count: 1 },
        { reason: "has_invoices", table: "invoices", count: 2 },
      ],
    });
    expect(msg).toContain("契約");
    expect(msg).toContain("請求書");
  });
  it("R-002-24 建物：先の予定と有効な契約を出す", () => {
    const msg = deleteMessage("building", {
      ok: false,
      reason: "in_use",
      blockers: [
        { reason: "has_future_works", table: "works", count: 4 },
        { reason: "has_active_contracts", table: "contracts", count: 1 },
      ],
    });
    expect(msg).toContain("先の予定");
    expect(msg).toContain("有効な契約");
  });
  it("R-002-24 使われている部屋・場所は、「使わない」にしたと伝える", () => {
    const msg = deleteMessage("room", {
      ok: true,
      deleted: false,
      deactivated: true,
      blockers: [{ reason: "used_by_photos", table: "photos", count: 5 }],
    });
    expect(msg).toContain("使わない");
    expect(msg).toContain("写真");
  });
  it("R-002-24 消せたときは、消したと伝える", () => {
    expect(deleteMessage("client", { ok: true, deleted: true })).toContain("消しました");
  });
  it("R-002-24 知らない理由でも、件数と表の名前で出す（後の機能が理由を足しても落ちない）", () => {
    const msg = deleteMessage("client", { ok: false, reason: "in_use", blockers: [{ reason: "has_something_new", table: "foo", count: 2 }] });
    expect(msg).toContain("消せません");
    expect(msg).toContain("2");
  });
});
