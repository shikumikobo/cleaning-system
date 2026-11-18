// 会計ソフトに渡す CSV（R-011-34）。請求書ごとの1行と、明細ごとの1行の2つ。
//  - 文字コードは UTF-8（BOM つき。Excel でも文字化けしない）、改行は CRLF
//  - 区切り・引用符・改行を含む値は、引用符で囲む。数式として読まれる先頭の文字（= + - @ とタブ・改行）は、文字の前に ' を付けて無害にする
//  - 数の列は数のまま出す（金額は整数の円）。下書き・取消は含めない
import { periodToMonth } from "./format";
import type { Balance, Invoice, InvoiceLine } from "./types";

export type Cell = string | number | null | undefined;

export const CSV_BOM = "﻿";

/** 会計ソフトに渡す請求書か（発行・送付・一部入金・入金済み） */
export const isExportable = (i: Pick<Invoice, "status">) => ["issued", "sent", "partial", "paid"].includes(i.status);

export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Cell[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const rateText = (r: number) => `${Number((r * 100).toFixed(2))}%`;

export const INVOICE_HEADER = ["請求書番号", "発行日", "支払期日", "取引先", "請求月", "税率", "小計", "消費税", "合計", "入金額", "残高", "状況"];
export const LINE_HEADER = ["請求書番号", "請求月", "取引先", "品名", "数量", "単位", "単価", "金額", "税率"];

export interface InvoiceCsvInput {
  invoices: Invoice[];
  clients: Record<string, string>;
  balances: Record<string, Pick<Balance, "paid" | "balance"> | undefined>;
  /** 状況の言葉（画面と同じ） */
  statusLabel: (s: string) => string;
}

/** 請求書ごとの1行（番号の順） */
export function invoicesCsv(i: InvoiceCsvInput): string {
  const rows = i.invoices
    .filter(isExportable)
    .sort((a, b) => (a.number ?? "").localeCompare(b.number ?? ""))
    .map((v) => {
      const b = i.balances[v.id];
      return [
        v.number, v.issue_date, v.due_date, i.clients[v.client_id] ?? "", periodToMonth(v.period), rateText(v.tax_rate),
        v.subtotal, v.tax, v.total, b?.paid ?? 0, b?.balance ?? v.total, i.statusLabel(v.status),
      ] as Cell[];
    });
  return toCsv([INVOICE_HEADER, ...rows]);
}

/** 明細ごとの1行（請求書の番号の順、明細の並び順） */
export function linesCsv(i: { invoices: Invoice[]; lines: InvoiceLine[]; clients: Record<string, string> }): string {
  const byId = new Map(i.invoices.filter(isExportable).map((v) => [v.id, v]));
  const rows: Cell[][] = i.lines
    .filter((l) => !l.deleted_at && byId.has(l.invoice_id))
    .sort((a, b) => (byId.get(a.invoice_id)!.number ?? "").localeCompare(byId.get(b.invoice_id)!.number ?? "") || a.sort - b.sort)
    .map((l) => {
      const v = byId.get(l.invoice_id)!;
      return [v.number, periodToMonth(v.period), i.clients[v.client_id] ?? "", l.name, l.qty, l.unit, l.unit_price, l.amount, rateText(v.tax_rate)];
    });
  return toCsv([LINE_HEADER, ...rows]);
}
