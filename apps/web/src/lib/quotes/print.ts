// 見積書（A4 の印刷）の中身。画面の印刷の画面（/quotes/print/）が、この形をそのまま並べる（R-004-30）。
import { calcQuote } from "./calc";
import { formatDateJa, formatPercent, formatYen, lineKindLabel } from "./format";
import { rruleToJa } from "./rrule";
import type { CompanyInfo, Quote, QuoteLine } from "./types";

export interface PrintRow {
  kind: string;
  name: string;
  qty: string;
  unit: string;
  unitPrice: string;
  amount: string;
  frequency: string;
}

export interface QuoteDocument {
  title: string;
  /** 下書きは「下書き」の印を付ける */
  draft: boolean;
  number: string;
  issueDate: string;
  validUntil: string;
  addressee: { client: string; building: string };
  rows: PrintRow[];
  subtotal: string;
  taxLabel: string;
  tax: string;
  total: string;
  note: string | null;
  company: { name: string; address: string | null; phone: string | null; registration: string | null };
}

const qtyText = (q: number) => String(Number(q));

export function buildQuoteDocument(i: { quote: Quote; lines: QuoteLine[]; tenant: CompanyInfo; client: string; building: string }): QuoteDocument {
  const { quote, tenant } = i;
  const lines = i.lines.filter((l) => !l.deleted_at).sort((a, b) => a.sort - b.sort);
  const draft = quote.status === "draft";
  // 提出した見積は、DB が確定した合計を載せる。下書きは、明細から画面で計算する（R-004-29 で DB と同じ答え）
  const totals = draft ? calcQuote(lines, quote.tax_rate) : { subtotal: quote.subtotal, tax: quote.tax, total: quote.total };
  const reg = tenant.invoice_reg_no?.trim();
  return {
    title: "御見積書",
    draft,
    number: quote.number ?? "（番号は提出のときに付きます）",
    issueDate: formatDateJa(quote.issue_date),
    validUntil: formatDateJa(quote.valid_until),
    addressee: { client: i.client, building: i.building },
    rows: lines.map((l) => ({
      kind: lineKindLabel(l.line_kind),
      name: l.name,
      qty: qtyText(l.qty),
      unit: l.unit,
      unitPrice: formatYen(l.unit_price),
      amount: formatYen(draft ? calcQuote([l], 0).subtotal : l.amount),
      frequency: l.recurrence ? rruleToJa(l.recurrence) : "",
    })),
    subtotal: formatYen(totals.subtotal),
    taxLabel: `消費税（${formatPercent(quote.tax_rate)}）`,
    tax: formatYen(totals.tax),
    total: formatYen(totals.total),
    note: quote.note?.trim() ? quote.note : null,
    company: {
      name: tenant.name,
      address: tenant.address,
      phone: tenant.phone,
      registration: reg ? `登録番号 ${reg}` : null,
    },
  };
}
