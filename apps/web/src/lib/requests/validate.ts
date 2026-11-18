// 入力の検査。DB の check 制約と同じ決まりを、保存の前に画面で確かめる（R-003-28）。
export type Errors = Record<string, string>;

const blank = (v: string | undefined | null) => !v || v.trim() === "";

/** 「12,000」「１２０００円」などを整数にする。整数でなければ null */
export function parseYen(v: string): number | null {
  const s = v.normalize("NFKC").replace(/[,\s¥円]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

function validYmd(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export const TITLE_MAX = 100;
export const DETAIL_MAX = 2000;
export const CATEGORIES = ["cleaning", "repair", "complaint", "inquiry", "other"];

function checkTitleDetail(i: { title?: string; detail?: string }, e: Errors) {
  if (blank(i.title)) e.title = "題名を入れてください";
  else if (i.title!.length > TITLE_MAX) e.title = `題名は ${TITLE_MAX} 字までにしてください`;
  if (i.detail && i.detail.length > DETAIL_MAX) e.detail = `内容は ${DETAIL_MAX} 字までにしてください`;
}

export function validateRequest(i: {
  title?: string;
  detail?: string;
  building_id?: string;
  client_id?: string;
  category?: string;
  due_date?: string;
}): Errors {
  const e: Errors = {};
  checkTitleDetail(i, e);
  if (blank(i.building_id)) e.building_id = "建物を選んでください";
  if (blank(i.client_id)) e.client_id = "依頼元の取引先を選んでください";
  if (i.category && !CATEGORIES.includes(i.category)) e.category = "分類を選んでください";
  if (!blank(i.due_date) && !validYmd(i.due_date!.trim())) e.due_date = "期限は日付（年-月-日）で入れてください";
  return e;
}

/** 現場の気づき：建物と題名だけが必須 */
export function validateObservation(i: { title?: string; detail?: string; building_id?: string }): Errors {
  const e: Errors = {};
  checkTitleDetail(i, e);
  if (blank(i.building_id)) e.building_id = "建物を選んでください";
  return e;
}

export function validateCharge(i: { amount?: string }): Errors {
  const e: Errors = {};
  if (blank(i.amount)) e.amount = "金額を入れてください";
  else if (parseYen(i.amount!) === null) e.amount = "金額は 0 以上の整数（円）で入れてください";
  else if (parseYen(i.amount!)! > 2_147_483_647) e.amount = "金額が大きすぎます";
  return e;
}
