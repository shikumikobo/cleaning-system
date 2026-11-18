// 画面の部品：状況・金額・期日超過・一覧の絞り込み・RPC が断った理由の文面（R-011-35・36）
import { formatDateJa, formatYen } from "../quotes/format";
import type { Balance, Invoice, InvoiceStatus } from "./types";

export { formatDateJa, formatPercent, formatYen, todayJst } from "../quotes/format";

const STATUS: Record<InvoiceStatus, string> = {
  draft: "下書き",
  issued: "発行",
  sent: "送付",
  partial: "一部入金",
  paid: "入金済み",
  cancelled: "取消",
};
export const invoiceStatusLabel = (s: string) => STATUS[s as InvoiceStatus] ?? s;

/** 2026-10-01 → 2026年10月分 */
export function periodLabel(period: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})/.exec(period ?? "");
  return m ? `${Number(m[1])}年${Number(m[2])}月分` : (period ?? "");
}

/** 2026-10-01 → 2026-10（月の入力の値） */
export const periodToMonth = (period: string) => period.slice(0, 7);

/** 入金の期日を過ぎて、残高がある（発行・送付・一部入金）か。today は日本時間の今日（YYYY-MM-DD） */
export function isOverdue(inv: Pick<Invoice, "status" | "due_date">, balance: number, today: string): boolean {
  if (!["issued", "sent", "partial"].includes(inv.status)) return false;
  return !!inv.due_date && inv.due_date < today && balance > 0;
}

/** 一覧に出す状況の言葉（期日超過なら足す） */
export function statusText(inv: Pick<Invoice, "status" | "due_date">, balance: number, today: string): string {
  const base = invoiceStatusLabel(inv.status);
  return isOverdue(inv, balance, today) ? `${base}（期日超過）` : base;
}

/** 支払期日の見せ方（下書きは、発行のときに決まる） */
export const dueLabel = (due: string | null | undefined) => (due ? formatDateJa(due) : "発行のときに決まります");

/** 請求書の入金額・残高の見せ方：「入金 ¥10,000／残高 ¥12,000」 */
export function balanceText(b: Pick<Balance, "paid" | "balance"> | undefined): string {
  if (!b) return "";
  return `入金 ${formatYen(b.paid)}／残高 ${formatYen(b.balance)}`;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** 一覧の絞り込み：番号・取引先の名前の一部（空白で区切った語は、すべて含むもの）・状況・月（2026-10） */
export function filterInvoices(
  invoices: Invoice[],
  clients: Record<string, string>,
  f: { q: string; status: string; month: string },
): Invoice[] {
  const tokens = norm(f.q).split(/\s+/).filter(Boolean);
  return invoices.filter((i) => {
    if (f.status && i.status !== f.status) return false;
    if (f.month && periodToMonth(i.period) !== f.month) return false;
    if (tokens.length === 0) return true;
    const hay = norm([i.number ?? "", clients[i.client_id] ?? ""].join(" "));
    return tokens.every((t) => hay.includes(t));
  });
}

const ACTION_TEXT: Record<string, string> = {
  period_required: "請求する月を選んでください",
  no_lines: "明細が1つもありません。明細のある下書きだけ発行できます",
  zero_total: "合計が 0 円なので、発行できません",
  due_before_issue: "支払期日が発行日より前になっています。期日を直してください",
  not_draft: "下書きではないので、できません",
  not_issued: "発行した請求書だけが、送付・入金にできます",
  has_payments: "入金のある請求書は、できません。先に入金を消してください",
  draft: "下書きは取り消せません。「この下書きを消す」を使ってください",
  cancelled: "取り消した請求書には、できません",
  overpaid: "入金の合計が請求の合計を超えます",
  invalid_amount: "金額は 0 より大きい整数（円）にしてください",
  paid_on_required: "入金日を入れてください",
};

/** RPC が断った理由（reason）を、利用者に見せる日本語にする */
export function actionMessage(reason: string | undefined): string {
  if (!reason) return "できませんでした";
  return ACTION_TEXT[reason] ?? `できませんでした（${reason}）`;
}

/** 下書きを作った結果の文 */
export function draftResultMessage(r: { created?: number; added?: number; locked?: number }): string {
  const created = r.created ?? 0;
  const added = r.added ?? 0;
  const locked = r.locked ?? 0;
  const parts: string[] = [];
  if (created > 0) parts.push(`下書きを ${created} 枚作りました`);
  if (added > 0) parts.push(`明細を ${added} 件入れました`);
  if (locked > 0) parts.push(`発行済みの請求書がある取引先 ${locked} 件は、飛ばしました（直すときは取り消して出し直します）`);
  if (parts.length === 0) return "この月に、請求するものはありませんでした（すでにすべて請求書に載っています）";
  return parts.join("。");
}
