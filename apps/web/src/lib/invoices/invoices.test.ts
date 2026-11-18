// 機能 011 の画面の部品（R-011-32〜36）：合計の計算・インボイスの書き方・CSV・期日超過・絞り込み・入力の検査・理由の文面
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calcInvoice } from "./calc";
import { csvCell, CSV_BOM, invoicesCsv, isExportable, linesCsv, toCsv } from "./csv";
import {
  actionMessage, balanceText, draftResultMessage, filterInvoices, invoiceStatusLabel, isOverdue, periodLabel, periodToMonth, statusText,
} from "./format";
import { buildInvoiceDocument } from "./print";
import type { CompanyInfo, Invoice, InvoiceLine } from "./types";
import { monthToPeriod, validateDraftHeader, validateLineEdit, validatePayment, validatePeriod } from "./validate";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
interface Case {
  name: string;
  tax_rate: number;
  lines: Array<{ qty: number; unit_price: number }>;
  expected: { subtotal: number; tax: number; total: number };
}
const { cases } = JSON.parse(readFileSync(`${root}supabase/tests/fixtures/invoice_totals.json`, "utf8")) as { cases: Case[] };

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "i1", tenant_id: "t", client_id: "c1", period: "2026-10-01", number: "I-2026-0001", issue_date: "2026-11-01", due_date: "2026-11-30", tax_rate: 0.1,
  subtotal: 40000, tax: 4000, total: 44000, status: "issued", previous_id: null, note: null, issued_at: "2026-11-01T00:00:00Z", sent_at: null, cancelled_at: null,
  cancel_reason: null, created_at: "2026-11-01T00:00:00Z", deleted_at: null, ...over,
});
const line = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
  id: "l1", tenant_id: "t", invoice_id: "i1", service_key: "k", service_month: "2026-10-01", work_id: null, request_id: null, name: "ひまわりビル 定期清掃", qty: 1, unit: "月",
  unit_price: 30000, amount: 30000, sort: 1, deleted_at: null, ...over,
});
const company = (over: Partial<CompanyInfo> = {}): CompanyInfo => ({ name: "A清掃", address: "東京都1-1", phone: "03-0000-0000", invoice_reg_no: "T1234567890123", ...over });

describe("R-011-32 画面の合計は、DB の発行と同じテストのデータで一致する", () => {
  it("すべてのケースで、小計・税・合計が期待値と同じ", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const c of cases) {
      const r = calcInvoice(c.lines, c.tax_rate);
      expect({ name: c.name, subtotal: r.subtotal, tax: r.tax, total: r.total }, c.name).toEqual({ name: c.name, ...c.expected });
    }
  });
  it("R-011-15 税は請求書1枚に1回（明細ごとに税をかけた合計とは違う）", () => {
    const r = calcInvoice([{ qty: 1, unit_price: 99 }, { qty: 1, unit_price: 99 }], 0.1);
    expect(r.tax).toBe(19);
  });
});

describe("R-011-33 請求書（インボイスの書き方）の中身", () => {
  const lines = [line(), line({ id: "l2", name: "ひまわりビル 窓清掃（10/5）", qty: 2, unit: "回", unit_price: 5000, amount: 10000, sort: 2 })];
  it("番号・発行日・請求月・支払期日・宛先・明細・税率ごとの対象額と消費税・合計・会社・登録番号が出る", () => {
    const d = buildInvoiceDocument({ invoice: inv(), lines, tenant: company(), client: "青空管理株式会社" });
    expect(d.title).toBe("請求書");
    expect(d.mark).toBeNull();
    expect(d.number).toBe("I-2026-0001");
    expect(d.issueDate).toBe("2026年11月1日");
    expect(d.period).toBe("2026年10月分");
    expect(d.dueDate).toBe("2026年11月30日");
    expect(d.addressee).toBe("青空管理株式会社");
    expect(d.rows.map((r) => [r.name, r.qty, r.unit, r.unitPrice, r.amount])).toEqual([
      ["ひまわりビル 定期清掃", "1", "月", "¥30,000", "¥30,000"],
      ["ひまわりビル 窓清掃（10/5）", "2", "回", "¥5,000", "¥10,000"],
    ]);
    expect(d.taxRows).toEqual([{ label: "10%対象", base: "¥40,000", taxLabel: "消費税（10%）", tax: "¥4,000" }]);
    expect(d.subtotal).toBe("¥40,000");
    expect(d.total).toBe("¥44,000");
    expect(d.company).toEqual({ name: "A清掃", address: "東京都1-1", phone: "03-0000-0000", registration: "登録番号 T1234567890123" });
  });
  it("登録番号が未登録なら、その行は出さない", () => {
    expect(buildInvoiceDocument({ invoice: inv(), lines, tenant: company({ invoice_reg_no: null }), client: "x" }).company.registration).toBeNull();
    expect(buildInvoiceDocument({ invoice: inv(), lines, tenant: company({ invoice_reg_no: "  " }), client: "x" }).company.registration).toBeNull();
  });
  it("下書きは「下書き」の印と、明細から画面で計算した合計。取消は「取消」の印", () => {
    const d = buildInvoiceDocument({ invoice: inv({ status: "draft", number: null, issue_date: null, due_date: null, subtotal: 0, tax: 0, total: 0 }), lines, tenant: company(), client: "x" });
    expect(d.mark).toBe("下書き");
    expect(d.number).toContain("発行のときに付きます");
    expect(d.total).toBe("¥44,000");
    expect(buildInvoiceDocument({ invoice: inv({ status: "cancelled" }), lines: [], tenant: company(), client: "x" }).mark).toBe("取消");
  });
  it("発行した請求書は、DB が確定した合計を載せる（明細から計算し直さない）", () => {
    const d = buildInvoiceDocument({ invoice: inv({ subtotal: 1, tax: 0, total: 1 }), lines, tenant: company(), client: "x" });
    expect(d.total).toBe("¥1");
  });
  it("備考がなければ null", () => {
    expect(buildInvoiceDocument({ invoice: inv({ note: " " }), lines, tenant: company(), client: "x" }).note).toBeNull();
    expect(buildInvoiceDocument({ invoice: inv({ note: "振込手数料は先方負担" }), lines, tenant: company(), client: "x" }).note).toBe("振込手数料は先方負担");
  });
});

describe("R-011-34 会計ソフトに渡す CSV", () => {
  it("区切り・引用符・改行を含む値は引用符で囲み、引用符は二重にする", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('ビル"A"')).toBe('"ビル""A"""');
    expect(csvCell("1行目\n2行目")).toBe('"1行目\n2行目"');
    expect(csvCell("ふつう")).toBe("ふつう");
    expect(csvCell(null)).toBe("");
    expect(csvCell(1234)).toBe("1234");
    expect(csvCell(-5)).toBe("-5");
  });
  it("数式として読まれる先頭の文字は、無害にする", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+81-3")).toBe("'+81-3");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("	=1")).toBe("'	=1"); // タブで始まるものも、先頭に ' を付ける
  });
  it("改行は CRLF、末尾も CRLF。BOM は UTF-8 の印", () => {
    expect(toCsv([["a", 1], ["b", 2]])).toBe("a,1\r\nb,2\r\n");
    expect(CSV_BOM).toBe("﻿");
  });
  const invoices = [
    inv({ id: "a", number: "I-2026-0002", status: "partial", total: 22000, subtotal: 20000, tax: 2000 }),
    inv({ id: "b", number: "I-2026-0001", status: "paid" }),
    inv({ id: "d", number: null, status: "draft" }),
    inv({ id: "x", number: "I-2026-0003", status: "cancelled" }),
  ];
  it("下書き・取消は含めず、番号の順に、請求書ごとの1行になる", () => {
    expect(invoices.filter(isExportable).map((v) => v.id)).toEqual(["a", "b"]);
    const csv = invoicesCsv({ invoices, clients: { c1: "青空管理" }, balances: { a: { paid: 10000, balance: 12000 }, b: { paid: 44000, balance: 0 } }, statusLabel: invoiceStatusLabel });
    expect(csv.split("\r\n")).toEqual([
      "請求書番号,発行日,支払期日,取引先,請求月,税率,小計,消費税,合計,入金額,残高,状況",
      "I-2026-0001,2026-11-01,2026-11-30,青空管理,2026-10,10%,40000,4000,44000,44000,0,入金済み",
      "I-2026-0002,2026-11-01,2026-11-30,青空管理,2026-10,10%,20000,2000,22000,10000,12000,一部入金",
      "",
    ]);
  });
  it("明細ごとの1行（請求書の番号の順、明細の並び順）。取消・下書き・外した明細は含めない", () => {
    const csv = linesCsv({
      invoices,
      clients: { c1: "青空管理" },
      lines: [
        line({ id: "l2", invoice_id: "a", sort: 2, name: "窓,清掃", qty: 2.5, unit: "回", unit_price: 1000, amount: 2500 }),
        line({ id: "l1", invoice_id: "a", sort: 1 }),
        line({ id: "l3", invoice_id: "b", sort: 1, name: "定期清掃" }),
        line({ id: "l4", invoice_id: "d" }),
        line({ id: "l5", invoice_id: "x" }),
        line({ id: "l6", invoice_id: "b", sort: 2, deleted_at: "2026-11-02T00:00:00Z" }),
      ],
    });
    expect(csv.split("\r\n")).toEqual([
      "請求書番号,請求月,取引先,品名,数量,単位,単価,金額,税率",
      "I-2026-0001,2026-10,青空管理,定期清掃,1,月,30000,30000,10%",
      "I-2026-0002,2026-10,青空管理,ひまわりビル 定期清掃,1,月,30000,30000,10%",
      'I-2026-0002,2026-10,青空管理,"窓,清掃",2.5,回,1000,2500,10%',
      "",
    ]);
  });
});

describe("R-011-35 期日超過・状況の言葉・一覧の絞り込み", () => {
  it("期日を過ぎて残高がある（発行・送付・一部入金）ものだけが期日超過", () => {
    expect(isOverdue(inv({ status: "issued" }), 44000, "2026-12-01")).toBe(true);
    expect(isOverdue(inv({ status: "sent" }), 44000, "2026-12-01")).toBe(true);
    expect(isOverdue(inv({ status: "partial" }), 100, "2026-12-01")).toBe(true);
    expect(isOverdue(inv({ status: "issued" }), 44000, "2026-11-30")).toBe(false); // 期日の当日はまだ
    expect(isOverdue(inv({ status: "paid" }), 0, "2026-12-01")).toBe(false);
    expect(isOverdue(inv({ status: "issued" }), 0, "2026-12-01")).toBe(false);
    expect(isOverdue(inv({ status: "cancelled" }), 44000, "2026-12-01")).toBe(false);
    expect(isOverdue(inv({ status: "draft", due_date: null }), 0, "2026-12-01")).toBe(false);
  });
  it("状況の言葉と、入金額・残高・請求月の見せ方", () => {
    expect(["draft", "issued", "sent", "partial", "paid", "cancelled"].map(invoiceStatusLabel)).toEqual(["下書き", "発行", "送付", "一部入金", "入金済み", "取消"]);
    expect(statusText(inv({ status: "sent" }), 44000, "2026-12-01")).toBe("送付（期日超過）");
    expect(statusText(inv({ status: "sent" }), 44000, "2026-11-01")).toBe("送付");
    expect(balanceText({ paid: 10000, balance: 12000 })).toBe("入金 ¥10,000／残高 ¥12,000");
    expect(balanceText(undefined)).toBe("");
    expect(periodLabel("2026-10-01")).toBe("2026年10月分");
    expect(periodToMonth("2026-10-01")).toBe("2026-10");
  });
  it("番号・取引先の言葉（空白で区切った語はすべて含むもの）・状況・月で絞る", () => {
    const list = [
      inv({ id: "1", number: "I-2026-0001", client_id: "c1", status: "paid", period: "2026-09-01" }),
      inv({ id: "2", number: "I-2026-0002", client_id: "c2", status: "issued", period: "2026-10-01" }),
      inv({ id: "3", number: null, client_id: "c2", status: "draft", period: "2026-10-01" }),
    ];
    const names = { c1: "青空管理株式会社", c2: "ひまわりオーナー" };
    const f = (q: string, status = "", month = "") => filterInvoices(list, names, { q, status, month }).map((i) => i.id);
    expect(f("")).toEqual(["1", "2", "3"]);
    expect(f("青空")).toEqual(["1"]);
    expect(f("ひまわり オーナー")).toEqual(["2", "3"]);
    expect(f("0002")).toEqual(["2"]);
    expect(f("", "draft")).toEqual(["3"]);
    expect(f("", "", "2026-10")).toEqual(["2", "3"]);
    expect(f("ひまわり", "issued", "2026-10")).toEqual(["2"]);
    expect(f("ＩＩ")).toEqual([]);
  });
});

describe("R-011-36 入力の検査と理由の文面", () => {
  it("月は 2026-10 の形だけ。請求する月の1日にする", () => {
    expect(monthToPeriod("2026-10")).toBe("2026-10-01");
    expect(monthToPeriod("2026-13")).toBeNull();
    expect(monthToPeriod("")).toBeNull();
    expect(validatePeriod("")).toHaveProperty("period");
    expect(validatePeriod("2026-10")).toEqual({});
  });
  it("下書きの税率と期日", () => {
    expect(validateDraftHeader({ tax_percent: "10", due_date: "2026-12-31" })).toEqual({});
    expect(validateDraftHeader({ tax_percent: "10", due_date: "" })).toEqual({});
    expect(validateDraftHeader({ tax_percent: "abc" })).toHaveProperty("tax_percent");
    expect(validateDraftHeader({ tax_percent: "101" })).toHaveProperty("tax_percent");
    expect(validateDraftHeader({ tax_percent: "10", due_date: "12/31" })).toHaveProperty("due_date");
  });
  it("明細の品名・数量・単位", () => {
    expect(validateLineEdit({ name: "清掃", qty: "0.5", unit: "月" })).toEqual({});
    expect(validateLineEdit({ name: " ", qty: "1", unit: "月" })).toHaveProperty("name");
    expect(validateLineEdit({ name: "x", qty: "0", unit: "月" })).toHaveProperty("qty");
    expect(validateLineEdit({ name: "x", qty: "1.234", unit: "月" })).toHaveProperty("qty");
    expect(validateLineEdit({ name: "x", qty: "1", unit: "" })).toHaveProperty("unit");
  });
  it("入金：日付・金額・残高を超えない", () => {
    expect(validatePayment({ paid_on: "2026-11-30", amount: "10000" }, 12000)).toEqual({});
    expect(validatePayment({ paid_on: "", amount: "10000" })).toHaveProperty("paid_on");
    expect(validatePayment({ paid_on: "11/30", amount: "10000" })).toHaveProperty("paid_on");
    expect(validatePayment({ paid_on: "2026-11-30", amount: "" })).toHaveProperty("amount");
    expect(validatePayment({ paid_on: "2026-11-30", amount: "0" })).toHaveProperty("amount");
    expect(validatePayment({ paid_on: "2026-11-30", amount: "1.5" })).toHaveProperty("amount");
    expect(validatePayment({ paid_on: "2026-11-30", amount: "12001" }, 12000).amount).toContain("12,000");
  });
  it("RPC が断った理由は日本語。知らない理由も、そのまま出す", () => {
    for (const r of ["no_lines", "zero_total", "due_before_issue", "not_draft", "not_issued", "has_payments", "draft", "cancelled", "overpaid", "invalid_amount", "paid_on_required", "period_required"]) {
      expect(actionMessage(r), r).not.toContain("できませんでした（");
    }
    expect(actionMessage("new_reason")).toBe("できませんでした（new_reason）");
    expect(actionMessage(undefined)).toBe("できませんでした");
  });
  it("下書きを作った結果の文", () => {
    expect(draftResultMessage({ created: 2, added: 9, locked: 0 })).toBe("下書きを 2 枚作りました。明細を 9 件入れました");
    expect(draftResultMessage({ created: 0, added: 1, locked: 1 })).toContain("明細を 1 件入れました");
    expect(draftResultMessage({ created: 0, added: 0, locked: 1 })).toContain("飛ばしました");
    expect(draftResultMessage({ created: 0, added: 0, locked: 0 })).toContain("請求するものはありませんでした");
  });
});
