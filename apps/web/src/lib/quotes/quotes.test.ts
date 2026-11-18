import { describe, expect, it } from "vitest";
import { calcQuote, lineAmount, parseQty } from "./calc";
import { buildRrule, parseRecurrence, rruleToJa, type Recurrence } from "./rrule";
import { validateHeader, validateItem, validateLine, submitIssues } from "./validate";
import { actionMessage, filterQuotes, formatDateJa, formatPercent, formatYen, lineKindLabel, percentToRate, quoteKindLabel, statusLabel } from "./format";
import { buildQuoteDocument } from "./print";
import type { Quote, QuoteLine } from "./types";

describe("R-004-9 合計の計算（税は帳票ごとに1回・切り捨て）", () => {
  it("明細の金額は 数量 × 単価。円未満は四捨五入（5 の端数は切り上げ）", () => {
    expect(lineAmount(1, 10000)).toBe(10000);
    expect(lineAmount(2.5, 1000)).toBe(2500);
    expect(lineAmount(1.5, 3333)).toBe(5000); // 4999.5
    expect(lineAmount(0.5, 3)).toBe(2); // 1.5
    expect(lineAmount(0.5, 5)).toBe(3); // 2.5
    expect(lineAmount(0.25, 1000)).toBe(250);
    expect(lineAmount("1.5", "3333")).toBe(5000);
  });
  it("小数の浮動小数点の誤差に引きずられない", () => {
    expect(lineAmount(1.1, 100)).toBe(110);
    expect(lineAmount(0.07, 100)).toBe(7);
    expect(lineAmount(33.33, 3)).toBe(100);
  });
  it("税は小計 × 税率を1回だけ、円未満切り捨て。合計は 小計 ＋ 税", () => {
    const r = calcQuote([{ qty: 1, unit_price: 15 }, { qty: 1, unit_price: 15 }, { qty: 1, unit_price: 15 }], 0.1);
    expect(r).toMatchObject({ subtotal: 45, tax: 4, total: 49 });
    expect(r.amounts).toEqual([15, 15, 15]);
  });
  it("明細が空なら 0", () => {
    expect(calcQuote([], 0.1)).toMatchObject({ subtotal: 0, tax: 0, total: 0 });
  });
  it("大きな金額でも誤差が出ない", () => {
    expect(calcQuote([{ qty: 100000, unit_price: 99999 }], 0.1)).toMatchObject({ subtotal: 9999900000, tax: 999990000, total: 10999890000 });
  });
  it("数量の文字列を 100 倍の整数にする", () => {
    expect(parseQty("2.5")).toBe(250);
    expect(parseQty("1")).toBe(100);
    expect(parseQty("0.01")).toBe(1);
    expect(parseQty("")).toBeNull();
    expect(parseQty("abc")).toBeNull();
    expect(parseQty("1.234")).toBeNull(); // 小数 2 桁まで
    expect(parseQty("-1")).toBeNull();
  });
});

describe("R-004-27 繰り返し（RRULE）を日本語にする", () => {
  const cases: Array<[string, string]> = [
    ["FREQ=MONTHLY;BYDAY=2TU", "毎月 第2火曜"],
    ["FREQ=MONTHLY;BYDAY=-1FR", "毎月 最終金曜"],
    ["FREQ=MONTHLY;BYDAY=1MO,3MO", "毎月 第1・第3月曜"],
    ["FREQ=MONTHLY;BYDAY=1MO,3TH", "毎月 第1月曜・第3木曜"],
    ["FREQ=WEEKLY;BYDAY=MO,TH", "毎週 月曜・木曜"],
    ["FREQ=WEEKLY", "毎週"],
    ["FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "2週間に1回 火曜"],
    ["FREQ=MONTHLY", "毎月"],
    ["FREQ=MONTHLY;INTERVAL=3", "3か月に1回"],
    ["FREQ=MONTHLY;INTERVAL=3;BYDAY=2TU", "3か月に1回 第2火曜"],
    ["FREQ=MONTHLY;BYMONTHDAY=15", "毎月 15日"],
    ["FREQ=MONTHLY;BYMONTHDAY=-1", "毎月 月末"],
    ["FREQ=MONTHLY;BYMONTHDAY=1,15", "毎月 1日・15日"],
    ["FREQ=YEARLY", "毎年"],
    ["FREQ=YEARLY;BYMONTH=4", "毎年 4月"],
    ["FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1", "毎年 4月1日"],
    ["FREQ=DAILY", "毎日"],
    ["RRULE:FREQ=MONTHLY;BYDAY=2TU", "毎月 第2火曜"],
    ["freq=monthly;byday=2tu", "毎月 第2火曜"],
  ];
  for (const [rule, ja] of cases) {
    it(`${rule} → ${ja}`, () => expect(rruleToJa(rule)).toBe(ja));
  }
  it("読めない形のときは、元の文字列をそのまま見せる", () => {
    expect(rruleToJa("every month")).toBe("every month");
    expect(rruleToJa("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU")).toBe("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU");
    expect(rruleToJa("FREQ=HOURLY")).toBe("FREQ=HOURLY");
    expect(rruleToJa("FREQ=MONTHLY;BYDAY=2XX")).toBe("FREQ=MONTHLY;BYDAY=2XX");
    expect(rruleToJa("")).toBe("");
  });
});

describe("R-004-28 画面で選んだ頻度から RRULE を作る（訳すと元に戻る）", () => {
  const list: Array<[Recurrence, string, string]> = [
    [{ type: "weekly", weekdays: ["TU"], interval: 1 }, "FREQ=WEEKLY;BYDAY=TU", "毎週 火曜"],
    [{ type: "weekly", weekdays: ["MO", "TH"], interval: 1 }, "FREQ=WEEKLY;BYDAY=MO,TH", "毎週 月曜・木曜"],
    [{ type: "weekly", weekdays: ["TU"], interval: 2 }, "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "2週間に1回 火曜"],
    [{ type: "monthly_nth", nth: 2, weekday: "TU" }, "FREQ=MONTHLY;BYDAY=2TU", "毎月 第2火曜"],
    [{ type: "monthly_nth", nth: -1, weekday: "FR" }, "FREQ=MONTHLY;BYDAY=-1FR", "毎月 最終金曜"],
    [{ type: "monthly_day", day: 15 }, "FREQ=MONTHLY;BYMONTHDAY=15", "毎月 15日"],
    [{ type: "monthly_day", day: -1 }, "FREQ=MONTHLY;BYMONTHDAY=-1", "毎月 月末"],
    [{ type: "every_months", months: 3 }, "FREQ=MONTHLY;INTERVAL=3", "3か月に1回"],
    [{ type: "every_months", months: 1 }, "FREQ=MONTHLY", "毎月"],
  ];
  for (const [rec, rule, ja] of list) {
    it(`${JSON.stringify(rec)} → ${rule}`, () => {
      expect(buildRrule(rec)).toBe(rule);
      expect(rruleToJa(rule)).toBe(ja);
      expect(parseRecurrence(rule)).toEqual(rec);
    });
  }
  it("作った文字列は、DB の check（FREQ=… で始まる RRULE の形）に合う", () => {
    const re = /^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$/;
    for (const [rec] of list) expect(buildRrule(rec)).toMatch(re);
  });
  it("画面で選べない形は、選択に戻せない（null）", () => {
    expect(parseRecurrence("FREQ=YEARLY")).toBeNull();
    expect(parseRecurrence("nonsense")).toBeNull();
  });
});

describe("R-004-1・3・4 入力の検査", () => {
  it("品名の候補：名前・単価・種類", () => {
    expect(validateItem({ name: "窓清掃", unit: "回", unit_price: "12000", kind: "option" })).toEqual({});
    expect(validateItem({ name: " ", unit: "回", unit_price: "1", kind: "base" }).name).toBeDefined();
    expect(validateItem({ name: "a", unit: "回", unit_price: "-1", kind: "base" }).unit_price).toBeDefined();
    expect(validateItem({ name: "a", unit: "回", unit_price: "1.5", kind: "base" }).unit_price).toBeDefined();
    expect(validateItem({ name: "a", unit: "回", unit_price: "", kind: "base" }).unit_price).toBeDefined();
    expect(validateItem({ name: "a", unit: "回", unit_price: "1", kind: "x" }).kind).toBeDefined();
    expect(validateItem({ name: "a", unit: " ", unit_price: "1", kind: "base" }).unit).toBeDefined();
  });
  it("見積の頭：取引先・建物・種類・税率・有効期限", () => {
    const ok = { client_id: "c", building_id: "b", kind: "request", tax_percent: "10", valid_until: "" };
    expect(validateHeader(ok)).toEqual({});
    expect(validateHeader({ ...ok, client_id: "" }).client_id).toBeDefined();
    expect(validateHeader({ ...ok, building_id: "" }).building_id).toBeDefined();
    expect(validateHeader({ ...ok, kind: "x" }).kind).toBeDefined();
    expect(validateHeader({ ...ok, tax_percent: "101" }).tax_percent).toBeDefined();
    expect(validateHeader({ ...ok, tax_percent: "abc" }).tax_percent).toBeDefined();
    expect(validateHeader({ ...ok, tax_percent: "8" })).toEqual({});
    expect(validateHeader({ ...ok, valid_until: "2026/1/1" }).valid_until).toBeDefined();
    expect(validateHeader({ ...ok, valid_until: "2026-12-31" })).toEqual({});
  });
  it("明細：名前・数量・単価・繰り返し", () => {
    const ok = { line_kind: "one_time", name: "床", qty: "2.5", unit: "回", unit_price: "1000", recurrence: "" };
    expect(validateLine(ok)).toEqual({});
    expect(validateLine({ ...ok, name: "" }).name).toBeDefined();
    expect(validateLine({ ...ok, qty: "0" }).qty).toBeDefined();
    expect(validateLine({ ...ok, qty: "1.234" }).qty).toBeDefined();
    expect(validateLine({ ...ok, qty: "100001" }).qty).toBeDefined();
    expect(validateLine({ ...ok, unit_price: "-5" }).unit_price).toBeDefined();
    expect(validateLine({ ...ok, line_kind: "x" }).line_kind).toBeDefined();
    expect(validateLine({ ...ok, recurrence: "every month" }).recurrence).toBeDefined();
    expect(validateLine({ ...ok, recurrence: "FREQ=MONTHLY" })).toEqual({});
  });
});

describe("R-004-11・12・31 提出できない理由を画面で先に出す", () => {
  const line = (line_kind: string, recurrence: string | null = null) => ({ line_kind, recurrence });
  it("明細がない", () => expect(submitIssues({ kind: "request", valid_until: null }, [], "2026-11-17")).toEqual(["no_lines"]));
  it("有効期限が今日より前", () =>
    expect(submitIssues({ kind: "request", valid_until: "2026-11-16" }, [line("one_time")], "2026-11-17")).toEqual(["valid_until_before_issue"]));
  it("今日と同じ日までは、よい", () =>
    expect(submitIssues({ kind: "request", valid_until: "2026-11-17" }, [line("one_time")], "2026-11-17")).toEqual([]));
  it("定期：基本がない", () =>
    expect(submitIssues({ kind: "recurring", valid_until: null }, [line("option", "FREQ=MONTHLY")], "2026-11-17")).toEqual(["recurring_needs_base"]));
  it("定期：基本・オプションの繰り返しがない", () =>
    expect(submitIssues({ kind: "recurring", valid_until: null }, [line("base", "FREQ=MONTHLY"), line("option")], "2026-11-17")).toEqual(["recurrence_missing"]));
  it("定期：単発は繰り返しなしでよい", () =>
    expect(submitIssues({ kind: "recurring", valid_until: null }, [line("base", "FREQ=MONTHLY"), line("one_time")], "2026-11-17")).toEqual([]));
  it("定期でないのに繰り返しがある", () =>
    expect(submitIssues({ kind: "request", valid_until: null }, [line("one_time", "FREQ=MONTHLY")], "2026-11-17")).toEqual(["recurrence_not_allowed"]));
  it("理由は日本語の文になる", () => {
    for (const r of ["no_lines", "valid_until_before_issue", "recurring_needs_base", "recurrence_missing", "recurrence_not_allowed", "not_draft", "not_submitted", "not_revisable", "already_revised"]) {
      expect(actionMessage(r)).toMatch(/[ぁ-んァ-ン一-龥]/);
    }
    expect(actionMessage("unknown_reason")).toContain("unknown_reason");
  });
});

describe("見せ方（ラベル・金額・日付・税率・検索）", () => {
  it("ラベル", () => {
    expect(statusLabel("draft")).toBe("下書き");
    expect(statusLabel("submitted")).toBe("提出");
    expect(statusLabel("approved")).toBe("承認");
    expect(statusLabel("rejected")).toBe("不成立");
    expect(quoteKindLabel("recurring")).toBe("定期");
    expect(quoteKindLabel("request")).toBe("案件");
    expect(quoteKindLabel("special")).toBe("特別清掃");
    expect(lineKindLabel("base")).toBe("基本");
    expect(lineKindLabel("option")).toBe("オプション");
    expect(lineKindLabel("one_time")).toBe("単発");
  });
  it("金額・日付・税率", () => {
    expect(formatYen(1234567)).toBe("¥1,234,567");
    expect(formatYen(0)).toBe("¥0");
    expect(formatYen(10999890000)).toBe("¥10,999,890,000");
    expect(formatDateJa("2026-11-17")).toBe("2026年11月17日");
    expect(formatDateJa(null)).toBe("");
    expect(formatPercent(0.1)).toBe("10%");
    expect(formatPercent(0.08)).toBe("8%");
    expect(formatPercent(0.105)).toBe("10.5%");
    expect(percentToRate("10")).toBe(0.1);
    expect(percentToRate("8")).toBe(0.08);
    expect(percentToRate("10.5")).toBe(0.105);
  });
  it("一覧の検索：番号・取引先・建物の名前の一部（全角半角・大文字小文字は同じ）と状況", () => {
    const q = (id: string, number: string | null, client_id: string, building_id: string, status: Quote["status"]) =>
      ({ id, number, client_id, building_id, status }) as Quote;
    const quotes = [q("1", "Q-2026-0001", "c1", "b1", "submitted"), q("2", null, "c2", "b2", "draft"), q("3", "Q-2026-0002", "c1", "b2", "approved")];
    const names = { clients: { c1: "青空管理", c2: "ＡＢＣ不動産" }, buildings: { b1: "ひまわりマンション", b2: "第2ビル" } };
    expect(filterQuotes(quotes, names, { q: "", status: "" }).map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(filterQuotes(quotes, names, { q: "青空", status: "" }).map((x) => x.id)).toEqual(["1", "3"]);
    expect(filterQuotes(quotes, names, { q: "abc", status: "" }).map((x) => x.id)).toEqual(["2"]);
    expect(filterQuotes(quotes, names, { q: "0002", status: "" }).map((x) => x.id)).toEqual(["3"]);
    expect(filterQuotes(quotes, names, { q: "ひまわり ー", status: "" }).map((x) => x.id)).toEqual([]);
    expect(filterQuotes(quotes, names, { q: "", status: "draft" }).map((x) => x.id)).toEqual(["2"]);
    expect(filterQuotes(quotes, names, { q: "青空", status: "approved" }).map((x) => x.id)).toEqual(["3"]);
  });
});

describe("R-004-30 見積書（A4 の印刷）の中身", () => {
  const quote = {
    id: "q1", number: "Q-2026-0007", status: "submitted", kind: "recurring", issue_date: "2026-11-17", valid_until: "2026-12-17",
    tax_rate: 0.1, subtotal: 42000, tax: 4200, total: 46200, note: "駐車場は先方で手配", client_id: "c", building_id: "b",
  } as unknown as Quote;
  const lines = [
    { id: "l1", line_kind: "base", name: "定期清掃", qty: 1, unit: "月", unit_price: 30000, amount: 30000, recurrence: "FREQ=MONTHLY;BYDAY=2TU", sort: 1, deleted_at: null },
    { id: "l2", line_kind: "option", name: "窓清掃", qty: 1, unit: "回", unit_price: 12000, amount: 12000, recurrence: "FREQ=MONTHLY;INTERVAL=3", sort: 2, deleted_at: null },
    { id: "l3", line_kind: "one_time", name: "消した行", qty: 1, unit: "式", unit_price: 1, amount: 1, recurrence: null, sort: 3, deleted_at: "2026-11-17T00:00:00Z" },
  ] as unknown as QuoteLine[];
  const tenant = { name: "テスト清掃サービス", address: "東京都A区1-2-3", phone: "03-0000-0000", invoice_reg_no: "T1234567890123" };
  const to = { client: "青空管理株式会社", building: "ひまわりマンション" };

  it("番号・日付・宛先・明細・小計・税（税率つき）・合計・会社の情報が載る", () => {
    const d = buildQuoteDocument({ quote, lines, tenant, ...to });
    expect(d.title).toBe("御見積書");
    expect(d.number).toBe("Q-2026-0007");
    expect(d.issueDate).toBe("2026年11月17日");
    expect(d.validUntil).toBe("2026年12月17日");
    expect(d.addressee).toEqual({ client: "青空管理株式会社", building: "ひまわりマンション" });
    expect(d.rows).toEqual([
      { kind: "基本", name: "定期清掃", qty: "1", unit: "月", unitPrice: "¥30,000", amount: "¥30,000", frequency: "毎月 第2火曜" },
      { kind: "オプション", name: "窓清掃", qty: "1", unit: "回", unitPrice: "¥12,000", amount: "¥12,000", frequency: "3か月に1回" },
    ]);
    expect(d.subtotal).toBe("¥42,000");
    expect(d.taxLabel).toBe("消費税（10%）");
    expect(d.tax).toBe("¥4,200");
    expect(d.total).toBe("¥46,200");
    expect(d.company).toEqual({ name: "テスト清掃サービス", address: "東京都A区1-2-3", phone: "03-0000-0000", registration: "登録番号 T1234567890123" });
    expect(d.note).toBe("駐車場は先方で手配");
    expect(d.draft).toBe(false);
  });
  it("インボイスの登録番号が未登録ならば、その行は出さない", () => {
    const d = buildQuoteDocument({ quote, lines, tenant: { ...tenant, invoice_reg_no: null }, ...to });
    expect(d.company.registration).toBeNull();
    expect(buildQuoteDocument({ quote, lines, tenant: { ...tenant, invoice_reg_no: "  " }, ...to }).company.registration).toBeNull();
  });
  it("下書きは「下書き」の印をつけ、合計は明細から計算して出す", () => {
    const draft = { ...quote, status: "draft", number: null, issue_date: null, valid_until: null, subtotal: 0, tax: 0, total: 0 } as unknown as Quote;
    const d = buildQuoteDocument({ quote: draft, lines, tenant, ...to });
    expect(d.draft).toBe(true);
    expect(d.number).toBe("（番号は提出のときに付きます）");
    expect(d.total).toBe("¥46,200");
    expect(d.subtotal).toBe("¥42,000");
    expect(d.tax).toBe("¥4,200");
  });
  it("頻度のない明細は、頻度の欄を空にする", () => {
    const d = buildQuoteDocument({ quote: { ...quote, kind: "request" } as Quote, lines: [{ ...lines[0], recurrence: null }] as QuoteLine[], tenant, ...to });
    expect(d.rows[0].frequency).toBe("");
  });
});
