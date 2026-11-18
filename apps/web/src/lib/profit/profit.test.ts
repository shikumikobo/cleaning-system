// 機能 016 の画面の部品（R-016-7・8・19・20・21）：集め方・粗利・比べ・月の足し引き・費用の入力の検査・言葉
// 行の数字は、DB のテスト（supabase/tests/24_profit.sql）の 2028 年 5 月と同じ
import { describe, expect, it } from "vitest";
import { compareTotals, delta, groupRows, isMonth, marginPct, monthStart, NO_BUILDING, NO_CLIENT, NO_CONTRACT, prevMonth, prevYearMonth, shiftMonth, sumRows } from "./calc";
import { costErrorMessage, costKindLabel, deltaText, formatYen, monthLabel, pctText } from "./format";
import type { Names, ProfitRow } from "./types";
import { parseAmount, validateCost } from "./validate";

const row = (over: Partial<ProfitRow>): ProfitRow => ({
  tenant_id: "t", month: "2028-05-01", client_id: null, building_id: null, contract_id: null,
  revenue: 0, draft_revenue: 0, petty: 0, outsourcing: 0, material: 0, other_cost: 0, gross: 0, ...over,
});

// DB のテストと同じ 5 月の行
const MAY: ProfitRow[] = [
  row({ client_id: "cP1", building_id: "bP1", contract_id: "ctP1", revenue: 40000, petty: 1500, gross: 38500 }),
  row({ client_id: "cP1", building_id: "bP1", petty: 3000, outsourcing: 12000, gross: -15000 }),
  row({ client_id: "cP2", building_id: "bP2", contract_id: "ctP2", revenue: 20000, material: 4000, gross: 16000 }),
  row({ client_id: "cP1", building_id: "bP3", revenue: 8000, gross: 8000 }),
  row({ client_id: "cP3", building_id: "bP4", contract_id: "ctP3", draft_revenue: 6000 }),
  row({ petty: 2000, other_cost: 1000, gross: -3000 }),
];
const NAMES: Names = {
  clients: { cP1: "取引先1", cP2: "取引先2", cP3: "取引先3" },
  buildings: { bP1: "利益ビル1", bP2: "利益ビル2", bP3: "利益ビル3", bP4: "利益ビル4" },
  contracts: { ctP1: "利益ビル1 定期", ctP2: "利益ビル2 定期", ctP3: "利益ビル4 定期" },
};

describe("R-016-6・19 合計と粗利", () => {
  it("DB の view と同じ数字：売上 68000、小口 6500、手で入れた費用 17000、粗利 44500。下書きは粗利に入らない", () => {
    const t = sumRows(MAY);
    expect(t.revenue).toBe(68000);
    expect(t.petty).toBe(6500);
    expect(t.outsourcing + t.material + t.other_cost).toBe(17000);
    expect(t.cost).toBe(23500);
    expect(t.gross).toBe(44500);
    expect(t.draft_revenue).toBe(6000);
  });
  it("行が空なら、すべて 0", () => {
    expect(sumRows([])).toEqual({ revenue: 0, draft_revenue: 0, petty: 0, outsourcing: 0, material: 0, other_cost: 0, cost: 0, gross: 0 });
  });
  it("粗利は、行の gross の合計と同じ（売上 − 費用）", () => {
    expect(sumRows(MAY).gross).toBe(MAY.reduce((a, r) => a + r.gross, 0));
  });
});

describe("R-016-7 どの切り方でも同じ合計。「なし」の行は消えない", () => {
  for (const by of ["contract", "building", "client"] as const) {
    it(`${by} ごとに集めた売上・費用・粗利の合計が、全体と一致する`, () => {
      const groups = groupRows(MAY, by, NAMES);
      const all = sumRows(MAY);
      expect(groups.reduce((a, g) => a + g.totals.revenue, 0)).toBe(all.revenue);
      expect(groups.reduce((a, g) => a + g.totals.cost, 0)).toBe(all.cost);
      expect(groups.reduce((a, g) => a + g.totals.gross, 0)).toBe(all.gross);
    });
  }
  it("建物ごと：同じ建物の行（契約あり・なし）は1つにまとまり、売上の多い順に並ぶ", () => {
    const g = groupRows(MAY, "building", NAMES);
    expect(g.map((x) => x.label)).toEqual(["利益ビル1", "利益ビル2", "利益ビル3", "利益ビル4", NO_BUILDING]);
    expect(g[0].totals).toMatchObject({ revenue: 40000, petty: 4500, outsourcing: 12000, gross: 23500 });
  });
  it("契約ごと：契約のない分は「契約なし」に入る", () => {
    const g = groupRows(MAY, "contract", NAMES);
    const none = g.find((x) => x.key === null)!;
    expect(none.label).toBe(NO_CONTRACT);
    expect(none.totals.revenue).toBe(8000);
  });
  it("取引先ごと：取引先のない分（共通）は、消えずに「取引先なし」に入る", () => {
    const g = groupRows(MAY, "client", NAMES);
    const none = g.find((x) => x.key === null)!;
    expect(none.label).toBe(NO_CLIENT);
    expect(none.totals).toMatchObject({ petty: 2000, other_cost: 1000, gross: -3000 });
  });
  it("名前が分からない ID も、行は消さずに出す", () => {
    const g = groupRows([row({ building_id: "x", revenue: 1, gross: 1 })], "building", NAMES);
    expect(g[0].label).toBe("（名前の分からない建物）");
  });
});

describe("R-016-19 粗利率", () => {
  it("粗利 ÷ 売上（小数 1 桁）。売上が 0 以下ならば出さない", () => {
    expect(marginPct({ revenue: 68000, gross: 44500 })).toBe(65.4);
    expect(marginPct({ revenue: 0, gross: -3000 })).toBeNull();
    expect(pctText(null)).toBe("―");
    expect(pctText(65.4)).toBe("65.4%");
  });
});

describe("R-016-8 前の月・前の年との比べ", () => {
  it("差と増減の率（小数 1 桁）", () => {
    expect(delta(68000, 30000)).toEqual({ diff: 38000, pct: 126.7 });
    expect(delta(20000, 25000)).toEqual({ diff: -5000, pct: -20 });
  });
  it("比べる側が 0 のときは、率を出さない（0 で割らない）", () => {
    expect(delta(5000, 0)).toEqual({ diff: 5000, pct: null });
    expect(delta(0, 0)).toEqual({ diff: 0, pct: null });
  });
  it("比べる側がマイナスの粗利でも、増えたら率は正（向きは差と同じ）", () => {
    expect(delta(-1000, -4000).pct).toBe(75);
  });
  it("売上・費用・粗利の比べ", () => {
    const cur = sumRows(MAY);
    const prev = sumRows([row({ revenue: 30000, petty: 400, material: 2500, gross: 27100 })]);
    const c = compareTotals(cur, prev);
    expect(c.revenue.diff).toBe(38000);
    expect(c.cost.diff).toBe(23500 - 2900);
    expect(c.gross.diff).toBe(44500 - 27100);
  });
  it("月の足し引き：前の月・前の年の同じ月。年をまたぐ", () => {
    expect(prevMonth("2028-05")).toBe("2028-04");
    expect(prevMonth("2028-01")).toBe("2027-12");
    expect(prevYearMonth("2028-05")).toBe("2027-05");
    expect(shiftMonth("2027-12", 1)).toBe("2028-01");
    expect(monthStart("2028-05")).toBe("2028-05-01");
    expect(() => shiftMonth("2028-13", 1)).toThrow();
  });
  it("月の形の検査", () => {
    expect(isMonth("2028-05")).toBe(true);
    expect(isMonth("2028-5")).toBe(false);
    expect(isMonth("2028-13")).toBe(false);
    expect(isMonth("")).toBe(false);
  });
});

describe("R-016-20 費用の入力の検査", () => {
  const ok = { month: "2028-05", kind: "outsourcing", amount: "12000", building_id: "", contract_id: "", note: "" };
  it("正しい入力は通る", () => {
    expect(validateCost(ok)).toEqual({});
    expect(validateCost({ ...ok, building_id: "b1", contract_id: "c1" }, { c1: "b1" })).toEqual({});
  });
  it("月・種類・金額が正しくなければ止める", () => {
    expect(Object.keys(validateCost({ ...ok, month: "" }))).toEqual(["month"]);
    expect(Object.keys(validateCost({ ...ok, month: "2028-5" }))).toEqual(["month"]);
    expect(Object.keys(validateCost({ ...ok, kind: "travel" }))).toEqual(["kind"]);
    expect(Object.keys(validateCost({ ...ok, amount: "0" }))).toEqual(["amount"]);
    expect(Object.keys(validateCost({ ...ok, amount: "-5" }))).toEqual(["amount"]);
    expect(Object.keys(validateCost({ ...ok, amount: "1.5" }))).toEqual(["amount"]);
    expect(Object.keys(validateCost({ ...ok, amount: "" }))).toEqual(["amount"]);
    expect(Object.keys(validateCost({ ...ok, amount: "999999999999" }))).toEqual(["amount"]);
  });
  it("建物と契約の両方を選んだとき、契約の建物と違えば止める", () => {
    expect(Object.keys(validateCost({ ...ok, building_id: "b2", contract_id: "c1" }, { c1: "b1" }))).toEqual(["contract_id"]);
  });
  it("金額：カンマ・全角の数字・円の印を許す", () => {
    expect(parseAmount("12,000")).toBe(12000);
    expect(parseAmount("￥１２，０００円")).toBe(12000);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("R-016-21 画面の言葉", () => {
  it("種類・月・円・差", () => {
    expect(costKindLabel("outsourcing")).toBe("外注");
    expect(costKindLabel("material")).toBe("材料");
    expect(costKindLabel("other")).toBe("その他");
    expect(monthLabel("2028-05")).toBe("2028年5月");
    expect(formatYen(-15000)).toBe("-¥15,000");
    expect(deltaText({ diff: 38000, pct: 126.7 })).toBe("+¥38,000（+126.7%）");
    expect(deltaText({ diff: -5000, pct: -20 })).toBe("−¥5,000（−20%）");
    expect(deltaText({ diff: 5000, pct: null })).toBe("+¥5,000");
    expect(deltaText({ diff: 0, pct: 0 })).toBe("±¥0（±0%）");
  });
  it("DB が断った理由を日本語にする", () => {
    expect(costErrorMessage({ code: "42501" })).toContain("権限");
    expect(costErrorMessage({ code: "23514" })).toContain("入力");
    expect(costErrorMessage({ code: "23503" })).toContain("見つかりません");
    expect(costErrorMessage({ code: "99999", message: "x" })).toBe("x");
    expect(costErrorMessage(null)).toBe("費用を保存できませんでした");
  });
});
