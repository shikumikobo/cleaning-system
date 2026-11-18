import { describe, expect, it } from "vitest";
import { buildSettingRows, type Kind } from "./kinds";

const kinds: Kind[] = [
  { code: "quote_approved", name: "見積の承認", default_push: true, default_email: true, required_perm: "amount.read", sort: 50 },
  { code: "work_tomorrow", name: "明日の作業", default_push: true, default_email: false, required_perm: null, sort: 20 },
  { code: "work_changed", name: "予定の変更", default_push: true, default_email: false, required_perm: null, sort: 10 },
];

describe("受け取る種類の設定の合成", () => {
  it("R-015-27 選んでいない種類は、初めの値を出し、初めの値のままと分かる", () => {
    const rows = buildSettingRows(kinds, [], ["amount.read"]);
    expect(rows.map((r) => r.code)).toEqual(["work_changed", "work_tomorrow", "quote_approved"]); // 並び順（sort）
    expect(rows[0]).toEqual({ code: "work_changed", name: "予定の変更", push: true, email: false, pushIsDefault: true, emailIsDefault: true });
    expect(rows[2]).toMatchObject({ push: true, email: true });
  });

  it("R-015-27 選んだ値は、初めの値より先に出す（通知とメールは別々）", () => {
    const rows = buildSettingRows(
      kinds,
      [
        { kind: "work_changed", channel: "push", enabled: false },
        { kind: "work_tomorrow", channel: "email", enabled: true },
      ],
      [],
    );
    expect(rows.find((r) => r.code === "work_changed")).toMatchObject({ push: false, pushIsDefault: false, email: false, emailIsDefault: true });
    expect(rows.find((r) => r.code === "work_tomorrow")).toMatchObject({ push: true, pushIsDefault: true, email: true, emailIsDefault: false });
  });

  it("R-015-27 自分の権限で受け取れない種類は出さない", () => {
    expect(buildSettingRows(kinds, [], ["field.record"]).map((r) => r.code)).toEqual(["work_changed", "work_tomorrow"]);
    expect(buildSettingRows(kinds, [], new Set(["amount.read"])).map((r) => r.code)).toContain("quote_approved");
  });

  it("R-015-27 ほかの種類の設定が混ざっても、知らない種類は無視される", () => {
    const rows = buildSettingRows(kinds, [{ kind: "nokind", channel: "push", enabled: false }], []);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.pushIsDefault)).toBe(true);
  });
});
