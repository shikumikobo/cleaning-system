// 請求書（A4 の印刷）の中身。画面の印刷の画面（/invoices/print/）が、この形をそのまま並べる（R-011-33）。
// インボイス（適格請求書）の書き方：発行者の名前と登録番号、取引の年月日（請求する月と発行日）、取引の内容、
// 税率ごとの対象額と消費税、宛先。登録番号が未登録なら、その行は出さない。
import { calcInvoice } from "./calc";
import { formatDateJa, formatPercent, formatYen, periodLabel } from "./format";
import type { CompanyInfo, Invoice, InvoiceLine } from "./types";

export interface PrintRow {
  name: string;
  qty: string;
  unit: string;
  unitPrice: string;
  amount: string;
}

export interface TaxRow {
  /** 例：10%対象 */
  label: string;
  base: string;
  /** 例：消費税（10%） */
  taxLabel: string;
  tax: string;
}

export interface InvoiceDocument {
  title: string;
  /** 下書き・取消は印を付ける。ほかは null */
  mark: "下書き" | "取消" | null;
  number: string;
  issueDate: string;
  period: string;
  dueDate: string;
  addressee: string;
  rows: PrintRow[];
  taxRows: TaxRow[];
  subtotal: string;
  total: string;
  note: string | null;
  company: { name: string; address: string | null; phone: string | null; registration: string | null };
}

const qtyText = (q: number) => String(Number(q));

export function buildInvoiceDocument(i: { invoice: Invoice; lines: InvoiceLine[]; tenant: CompanyInfo; client: string }): InvoiceDocument {
  const { invoice, tenant } = i;
  const lines = i.lines.filter((l) => !l.deleted_at).sort((a, b) => a.sort - b.sort);
  const draft = invoice.status === "draft";
  // 発行した請求書は、DB が確定した合計を載せる。下書きは、明細から画面で計算する（R-011-32 で DB と同じ答え）
  const totals = draft ? calcInvoice(lines, invoice.tax_rate) : { subtotal: invoice.subtotal, tax: invoice.tax, total: invoice.total };
  const reg = tenant.invoice_reg_no?.trim();
  const rate = formatPercent(invoice.tax_rate);
  return {
    title: "請求書",
    mark: draft ? "下書き" : invoice.status === "cancelled" ? "取消" : null,
    number: invoice.number ?? "（番号は発行のときに付きます）",
    issueDate: invoice.issue_date ? formatDateJa(invoice.issue_date) : "（発行のときに決まります）",
    period: periodLabel(invoice.period),
    dueDate: invoice.due_date ? formatDateJa(invoice.due_date) : "（発行のときに決まります）",
    addressee: i.client,
    rows: lines.map((l) => ({
      name: l.name,
      qty: qtyText(l.qty),
      unit: l.unit,
      unitPrice: formatYen(l.unit_price),
      amount: formatYen(draft ? calcInvoice([l], 0).subtotal : l.amount),
    })),
    taxRows: [{ label: `${rate}対象`, base: formatYen(totals.subtotal), taxLabel: `消費税（${rate}）`, tax: formatYen(totals.tax) }],
    subtotal: formatYen(totals.subtotal),
    total: formatYen(totals.total),
    note: invoice.note?.trim() ? invoice.note : null,
    company: {
      name: tenant.name,
      address: tenant.address,
      phone: tenant.phone,
      registration: reg ? `登録番号 ${reg}` : null,
    },
  };
}
