// 画面の部品：ラベル・金額・日付・税率・一覧の検索・RPC が断った理由の文面（R-004-30・31）
import type { LineKind, Quote, QuoteKind, QuoteStatus } from "./types";

const STATUS: Record<QuoteStatus, string> = { draft: "下書き", submitted: "提出", approved: "承認", rejected: "不成立" };
const QUOTE_KIND: Record<QuoteKind, string> = { request: "案件", recurring: "定期", special: "特別清掃" };
const LINE_KIND: Record<LineKind, string> = { base: "基本", option: "オプション", one_time: "単発" };

export const statusLabel = (s: string) => STATUS[s as QuoteStatus] ?? s;
export const quoteKindLabel = (k: string) => QUOTE_KIND[k as QuoteKind] ?? k;
export const lineKindLabel = (k: string) => LINE_KIND[k as LineKind] ?? k;

/** 円：¥1,234,567 */
export function formatYen(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.trunc(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}¥${s}`;
}

/** 2026-11-17 → 2026年11月17日 */
export function formatDateJa(d: string | null | undefined): string {
  if (!d) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

/** 0.1 → 10%（小数 4 桁までの税率） */
export function formatPercent(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

/** 「10」「10.5」（%）→ 0.1・0.105（DB の numeric(5,4)） */
export function percentToRate(p: string): number {
  return Number((Number(p.trim()) / 100).toFixed(4));
}

/** 日本時間の今日（YYYY-MM-DD） */
export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** 一覧の絞り込み：番号・取引先・建物の名前の一部（空白で区切った語は、すべて含むもの）と状況 */
export function filterQuotes(
  quotes: Quote[],
  names: { clients: Record<string, string>; buildings: Record<string, string> },
  f: { q: string; status: string },
): Quote[] {
  const tokens = norm(f.q).split(/\s+/).filter(Boolean);
  return quotes.filter((q) => {
    if (f.status && q.status !== f.status) return false;
    if (tokens.length === 0) return true;
    const hay = norm([q.number ?? "", names.clients[q.client_id] ?? "", names.buildings[q.building_id] ?? ""].join(" "));
    return tokens.every((t) => hay.includes(t));
  });
}

const ACTION_TEXT: Record<string, string> = {
  no_lines: "明細が1つもありません。明細を足してから提出してください",
  valid_until_before_issue: "有効期限が今日より前になっています。有効期限を直してください",
  recurring_needs_base: "定期の見積には、種類が「基本」の明細が1つ以上要ります",
  recurrence_missing: "定期の見積は、「基本」と「オプション」のすべてに頻度（繰り返し）が要ります",
  recurrence_not_allowed: "定期でない見積には、頻度のある明細を入れられません（見積の種類を「定期」にするか、頻度を外してください）",
  not_draft: "下書きではないので、提出できません",
  not_submitted: "提出済みの見積だけが、承認・不成立にできます",
  not_revisable: "提出済み・不成立の見積だけが、直せます（承認済みの見積は直せません）",
  already_revised: "この見積からの直した版は、すでに提出されています。新しい版から直してください",
};

/** RPC が断った理由（reason）を、利用者に見せる日本語にする */
export function actionMessage(reason: string | undefined): string {
  if (!reason) return "できませんでした";
  return ACTION_TEXT[reason] ?? `できませんでした（${reason}）`;
}
