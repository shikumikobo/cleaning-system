// 外部の人の専用ページ（機能 005）に出す、見積の区画（機能 004。R-005-28 の登録簿に足す）。
// 外部の人が読めるのは、許された建物の、提出・承認の見積と、その明細だけ（DB の権限が最後の守り）。金額も見える。
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerPortalSection, type PortalItem, type PortalSection } from "../files/portal";
import { formatDateJa, formatYen, quoteKindLabel, statusLabel } from "./format";

interface PortalQuoteRow {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  issue_date: string | null;
  valid_until: string | null;
  subtotal: number;
  tax: number;
  total: number;
  note: string | null;
}
interface PortalLineRow {
  id: string;
  quote_id: string;
  name: string;
  qty: number;
  unit: string;
  unit_price: number;
  amount: number;
}

/** 専用ページが見積から取る列（作った人・決めた人・案件・取引先の列は取らない） */
export const PORTAL_QUOTE_COLUMNS = "id, number, kind, status, issue_date, valid_until, subtotal, tax, total, note";
export const PORTAL_LINE_COLUMNS = "id, quote_id, name, qty, unit, unit_price, amount";

export const quotesPortalSection: PortalSection = {
  id: "quotes",
  title: "見積（提出・承認）",
  async load(sb: SupabaseClient, buildingId: string): Promise<PortalItem[]> {
    const q = await sb
      .from("quotes")
      .select(PORTAL_QUOTE_COLUMNS)
      .eq("building_id", buildingId)
      .in("status", ["submitted", "approved"])
      .is("deleted_at", null)
      .order("issue_date", { ascending: false });
    if (q.error) throw new Error(q.error.message);
    const quotes = (q.data ?? []) as PortalQuoteRow[];
    if (quotes.length === 0) return [];
    const l = await sb
      .from("quote_lines")
      .select(PORTAL_LINE_COLUMNS)
      .in("quote_id", quotes.map((x) => x.id))
      .is("deleted_at", null)
      .order("sort");
    if (l.error) throw new Error(l.error.message);
    const lines = (l.data ?? []) as PortalLineRow[];
    return quotes.map((x) => ({
      key: x.id,
      label: `${x.number ?? "（番号なし）"}（${statusLabel(x.status)}・${quoteKindLabel(x.kind)}）`,
      detail:
        `合計 ${formatYen(x.total)}（税抜 ${formatYen(x.subtotal)}・消費税 ${formatYen(x.tax)}）` +
        (x.issue_date ? `・発行 ${formatDateJa(x.issue_date)}` : "") +
        (x.valid_until ? `・有効期限 ${formatDateJa(x.valid_until)}` : ""),
      children: lines
        .filter((ln) => ln.quote_id === x.id)
        .map((ln) => ({ key: ln.id, label: ln.name, detail: `${ln.qty} ${ln.unit} × ${formatYen(ln.unit_price)} = ${formatYen(ln.amount)}` })),
    }));
  },
};

/** 専用ページの登録簿に足す（同じ id なら置き換わるので、何度呼んでもよい） */
export function registerQuotesPortalSection(): void {
  registerPortalSection(quotesPortalSection);
}
