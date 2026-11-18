// 004 の見積の区画が、005 の専用ページの登録簿に入ること（R-005-28）と、取る範囲（R-004-23）
import { describe, expect, it } from "vitest";
import { fakeClient } from "../../../tests/fakeClient";
import { portalSections } from "../files/portal";
import { PORTAL_LINE_COLUMNS, PORTAL_QUOTE_COLUMNS, quotesPortalSection, registerQuotesPortalSection } from "./portal";

const B = "22222222-2222-4222-8222-222222222222";

describe("R-005-28 見積の区画", () => {
  it("R-005-28 登録すると、共有ファイルの次に並ぶ。何度登録しても1つ", () => {
    registerQuotesPortalSection();
    registerQuotesPortalSection();
    expect(portalSections().map((s) => s.id)).toEqual(["shared-files", "quotes"]);
  });
  it("R-004-23 建物の提出・承認の、消していない見積と明細を取り、金額も出す。作った人や取引先の列は取らない", async () => {
    const quotes = [{ id: "q1", number: "Q-2026-0001", kind: "recurring", status: "approved", issue_date: "2026-11-01", valid_until: "2026-11-30", subtotal: 30000, tax: 3000, total: 33000, note: null }];
    const lines = [
      { id: "l1", quote_id: "q1", name: "定期清掃（月額）", qty: 1, unit: "月", unit_price: 30000, amount: 30000 },
      { id: "l2", quote_id: "q2", name: "別の見積の明細", qty: 1, unit: "式", unit_price: 1, amount: 1 },
    ];
    const { client, calls } = fakeClient({ tables: { quotes: { data: quotes }, quote_lines: { data: lines } } });
    const items = await quotesPortalSection.load(client, B);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("Q-2026-0001（承認・定期）");
    expect(items[0].detail).toContain("合計 ¥33,000");
    expect(items[0].detail).toContain("有効期限 2026年11月30日");
    expect(items[0].children).toEqual([{ key: "l1", label: "定期清掃（月額）", detail: "1 月 × ¥30,000 = ¥30,000" }]);
    const qc = calls.find((c) => c.kind === "from" && c.name === "quotes")!.chain!;
    expect(qc).toContainEqual(["eq", ["building_id", B]]);
    expect(qc).toContainEqual(["in", ["status", ["submitted", "approved"]]]);
    expect(qc).toContainEqual(["is", ["deleted_at", null]]);
    expect(PORTAL_QUOTE_COLUMNS).not.toMatch(/created_by|decided_by|client|request_id|previous/);
    expect(PORTAL_LINE_COLUMNS).not.toMatch(/created_by|item_id/);
  });
  it("R-005-28 見積がなければ明細は取りに行かない", async () => {
    const { client, calls } = fakeClient({ tables: { quotes: { data: [] } } });
    expect(await quotesPortalSection.load(client, B)).toEqual([]);
    expect(calls.some((c) => c.name === "quote_lines")).toBe(false);
  });
});
