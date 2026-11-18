// 入力の検査。DB の check 制約と同じ決まりを、保存の前に画面で確かめる（R-004-31）。
// 戻りは「項目の名前 → 日本語のエラー」。空なら通る。
import { parseQty } from "./calc";

export type Errors = Record<string, string>;

const blank = (v: string | undefined | null) => !v || v.trim() === "";
const KINDS = ["base", "option", "one_time"];
const QUOTE_KINDS = ["request", "recurring", "special"];
const RRULE_RE = /^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkYen(v: string | undefined, label: string): string | undefined {
  if (blank(v)) return `${label}を入れてください`;
  const t = v!.trim();
  if (!/^-?\d+$/.test(t)) return `${label}は整数（円）で入れてください`;
  const n = Number(t);
  if (n < 0) return `${label}は 0 以上にしてください`;
  if (n > 100000000) return `${label}は 1 億円以下にしてください`;
  return undefined;
}

export function validateItem(i: { name?: string; unit?: string; unit_price?: string; kind?: string }): Errors {
  const e: Errors = {};
  if (blank(i.name)) e.name = "品名を入れてください";
  if (blank(i.unit)) e.unit = "単位を入れてください（例：回・月・式）";
  const p = checkYen(i.unit_price, "単価");
  if (p) e.unit_price = p;
  if (!KINDS.includes(i.kind ?? "")) e.kind = "種類（基本・オプション・単発）を選んでください";
  return e;
}

export function validateHeader(i: { client_id?: string; building_id?: string; kind?: string; tax_percent?: string; valid_until?: string }): Errors {
  const e: Errors = {};
  if (blank(i.client_id)) e.client_id = "取引先を選んでください";
  if (blank(i.building_id)) e.building_id = "建物を選んでください";
  if (!QUOTE_KINDS.includes(i.kind ?? "")) e.kind = "種類（案件・定期・特別清掃）を選んでください";
  const t = (i.tax_percent ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) > 100) e.tax_percent = "税率は 0〜100 の数（%）で入れてください";
  if (!blank(i.valid_until) && !DATE_RE.test(i.valid_until!.trim())) e.valid_until = "有効期限は 2026-12-31 の形で入れてください";
  return e;
}

export function validateLine(i: { line_kind?: string; name?: string; qty?: string; unit?: string; unit_price?: string; recurrence?: string }): Errors {
  const e: Errors = {};
  if (!KINDS.includes(i.line_kind ?? "")) e.line_kind = "種類（基本・オプション・単発）を選んでください";
  if (blank(i.name)) e.name = "品名を入れてください";
  const q = parseQty(i.qty ?? "");
  if (q === null) e.qty = "数量は、小数 2 桁までの数で入れてください";
  else if (q <= 0) e.qty = "数量は 0 より大きくしてください";
  else if (q > 100000 * 100) e.qty = "数量は 100000 以下にしてください";
  if (blank(i.unit)) e.unit = "単位を入れてください";
  const p = checkYen(i.unit_price, "単価");
  if (p) e.unit_price = p;
  if (!blank(i.recurrence) && !RRULE_RE.test(i.recurrence!.trim())) e.recurrence = "頻度の形が正しくありません";
  return e;
}

/** 提出の RPC が断る理由を、画面で先に調べる（R-004-11・12）。DB が最後に必ず確かめる */
export function submitIssues(
  quote: { kind: string; valid_until: string | null },
  lines: Array<{ line_kind: string; recurrence: string | null }>,
  today: string,
): string[] {
  if (lines.length === 0) return ["no_lines"];
  if (quote.valid_until && quote.valid_until < today) return ["valid_until_before_issue"];
  if (quote.kind === "recurring") {
    if (!lines.some((l) => l.line_kind === "base")) return ["recurring_needs_base"];
    if (lines.some((l) => l.line_kind !== "one_time" && !l.recurrence)) return ["recurrence_missing"];
    return [];
  }
  if (lines.some((l) => l.recurrence)) return ["recurrence_not_allowed"];
  return [];
}
