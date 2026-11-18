// 画面の言葉（R-016-19・21）
import { formatYen } from "../quotes/format";
import type { CostKind, Delta } from "./types";

export { formatYen };

export const COST_KINDS: CostKind[] = ["outsourcing", "material", "other"];
const KIND: Record<CostKind, string> = { outsourcing: "外注", material: "材料", other: "その他" };
export const costKindLabel = (k: string) => KIND[k as CostKind] ?? k;

/** 2026-11 → 2026年11月 */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  return m ? `${Number(m[1])}年${Number(m[2])}月` : month;
}

/** 粗利率の言葉。売上がないときは「―」 */
export const pctText = (p: number | null) => (p === null ? "―" : `${p}%`);

/** 差の言葉：+¥12,000（+8.5%）／−¥3,000（−2%）／比べる側が 0 のときは率なし */
export function deltaText(d: Delta): string {
  const sign = d.diff > 0 ? "+" : d.diff < 0 ? "−" : "±";
  const yen = formatYen(Math.abs(d.diff));
  const pct = d.pct === null ? "" : `（${d.pct > 0 ? "+" : d.pct < 0 ? "−" : "±"}${Math.abs(d.pct)}%）`;
  return `${sign}${yen}${pct}`;
}

/** 費用の保存で DB が断った理由（直接の書き込みなので、DB のコードから） */
export function costErrorMessage(e: { code?: string; message?: string } | null | undefined): string {
  switch (e?.code) {
    case "42501":
      return "費用を入れる権限がないか、建物と契約が合っていません";
    case "23514":
      return "月・種類・金額の入力が正しくありません";
    case "23503":
      return "選んだ建物か契約が見つかりません";
    case "23502":
      return "必須の項目が空です";
    default:
      return e?.message || "費用を保存できませんでした";
  }
}
