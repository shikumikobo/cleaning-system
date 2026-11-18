// 入力の検査。DB の check 制約・RPC と同じ決まりを、保存の前に画面で確かめる（R-011-36）。
// 戻りは「項目の名前 → 日本語のエラー」。空なら通る。
import { parseQty } from "../quotes/calc";

export type Errors = Record<string, string>;

const blank = (v: string | undefined | null) => !v || v.trim() === "";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 月（2026-10）を、請求する月の1日（2026-10-01）にする。形が違えば null */
export function monthToPeriod(month: string): string | null {
  const m = month.trim();
  return MONTH_RE.test(m) ? `${m}-01` : null;
}

export function validatePeriod(month: string): Errors {
  return monthToPeriod(month) ? {} : { period: "請求する月を選んでください（例：2026-10）" };
}

export function validateDraftHeader(i: { tax_percent?: string; due_date?: string }): Errors {
  const e: Errors = {};
  const t = (i.tax_percent ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) > 100) e.tax_percent = "税率は 0〜100 の数（%）で入れてください";
  if (!blank(i.due_date) && !DATE_RE.test(i.due_date!.trim())) e.due_date = "支払期日は 2026-12-31 の形で入れてください";
  return e;
}

export function validateLineEdit(i: { name?: string; qty?: string; unit?: string }): Errors {
  const e: Errors = {};
  if (blank(i.name)) e.name = "品名を入れてください";
  if (blank(i.unit)) e.unit = "単位を入れてください（例：回・月・式）";
  const q = parseQty(i.qty ?? "");
  if (q === null) e.qty = "数量は、小数 2 桁までの数で入れてください";
  else if (q <= 0) e.qty = "数量は 0 より大きくしてください";
  else if (q > 10000000) e.qty = "数量は 100000 以下にしてください";
  return e;
}

/** 入金の入力。残高（入金できる上限）を渡すと、超える入金も止める */
export function validatePayment(i: { paid_on?: string; amount?: string }, limit?: number): Errors {
  const e: Errors = {};
  if (blank(i.paid_on)) e.paid_on = "入金日を入れてください";
  else if (!DATE_RE.test(i.paid_on!.trim())) e.paid_on = "入金日は 2026-12-31 の形で入れてください";
  const a = (i.amount ?? "").trim();
  if (a === "") e.amount = "金額を入れてください";
  else if (!/^\d+$/.test(a)) e.amount = "金額は整数（円）で入れてください";
  else if (Number(a) <= 0) e.amount = "金額は 0 より大きくしてください";
  else if (limit !== undefined && Number(a) > limit) e.amount = `請求の残高（${limit.toLocaleString("ja-JP")}円）を超える入金は記録できません`;
  return e;
}
