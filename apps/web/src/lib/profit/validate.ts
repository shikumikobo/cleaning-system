// 費用の入力の検査（R-016-20）。DB の check 制約・RLS と同じ決まりを、保存の前に確かめる
import { isMonth } from "./calc";
import type { CostKind } from "./types";

export type Errors = Record<string, string>;

export interface CostInput {
  month: string;
  kind: string;
  amount: string;
  building_id: string;
  contract_id: string;
  note: string;
}

const KINDS: CostKind[] = ["outsourcing", "material", "other"];

/** 金額：1円以上の整数（カンマ・全角の数字・円の印は許す）。形が違えば null */
export function parseAmount(v: string): number | null {
  const s = v
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，¥￥円\s]/g, "");
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** contractBuilding：契約の ID → その契約の建物の ID（建物と契約が合っているかの確かめに使う） */
export function validateCost(i: CostInput, contractBuilding: Record<string, string> = {}): Errors {
  const e: Errors = {};
  if (!isMonth(i.month.trim())) e.month = "月を選んでください（例：2026-10）";
  if (!KINDS.includes(i.kind as CostKind)) e.kind = "種類（外注・材料・その他）を選んでください";
  const a = parseAmount(i.amount);
  if (a === null) e.amount = "金額は、円の整数で入れてください";
  else if (a < 1) e.amount = "金額は 1 円以上にしてください";
  else if (a > 100000000000) e.amount = "金額が大きすぎます";
  if (i.building_id && i.contract_id) {
    const b = contractBuilding[i.contract_id];
    if (b !== undefined && b !== i.building_id) e.contract_id = "選んだ契約は、その建物の契約ではありません";
  }
  return e;
}
