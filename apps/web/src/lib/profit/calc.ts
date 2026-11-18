// 売上と粗利の計算（R-016-7・8・19）。純粋な関数。DB の view の合計と同じ数字になる
import type { Delta, Group, GroupBy, Names, ProfitRow, Totals } from "./types";

export const NO_BUILDING = "建物なし（共通）";
export const NO_CONTRACT = "契約なし";
export const NO_CLIENT = "取引先なし（共通）";

export const emptyTotals = (): Totals => ({ revenue: 0, draft_revenue: 0, petty: 0, outsourcing: 0, material: 0, other_cost: 0, cost: 0, gross: 0 });

/** 行を足し合わせる。費用と粗利は、足した列から出し直す（粗利＝売上−費用） */
export function sumRows(rows: ProfitRow[]): Totals {
  const t = emptyTotals();
  for (const r of rows) {
    t.revenue += r.revenue;
    t.draft_revenue += r.draft_revenue;
    t.petty += r.petty;
    t.outsourcing += r.outsourcing;
    t.material += r.material;
    t.other_cost += r.other_cost;
  }
  t.cost = t.petty + t.outsourcing + t.material + t.other_cost;
  t.gross = t.revenue - t.cost;
  return t;
}

const keyOf = (r: ProfitRow, by: GroupBy) => (by === "contract" ? r.contract_id : by === "building" ? r.building_id : r.client_id);

export function groupLabel(by: GroupBy, key: string | null, names: Names): string {
  if (by === "contract") return key === null ? NO_CONTRACT : (names.contracts[key] ?? "（名前の分からない契約）");
  if (by === "building") return key === null ? NO_BUILDING : (names.buildings[key] ?? "（名前の分からない建物）");
  return key === null ? NO_CLIENT : (names.clients[key] ?? "（名前の分からない取引先）");
}

/** 契約・建物・取引先のどれかで集める。売上の多い順（同じなら、名前のあるものを先に、名前の順）。「なし」の行も消さずに出す */
export function groupRows(rows: ProfitRow[], by: GroupBy, names: Names): Group[] {
  const buckets = new Map<string | null, ProfitRow[]>();
  for (const r of rows) {
    const k = keyOf(r, by);
    const list = buckets.get(k);
    if (list) list.push(r);
    else buckets.set(k, [r]);
  }
  const out: Group[] = [];
  for (const [key, list] of buckets) out.push({ key, label: groupLabel(by, key, names), totals: sumRows(list) });
  return out.sort((a, b) => b.totals.revenue - a.totals.revenue || Number(a.key === null) - Number(b.key === null) || a.label.localeCompare(b.label, "ja"));
}

/** 粗利率（%、小数 1 桁）。売上が 0 以下のときは出さない（null） */
export function marginPct(t: Pick<Totals, "revenue" | "gross">): number | null {
  return t.revenue > 0 ? Math.round((t.gross / t.revenue) * 1000) / 10 : null;
}

/** 比べる：差と増減の率。比べる側が 0 のときは、率は出さない（0 で割らない） */
export function delta(cur: number, base: number): Delta {
  return { diff: cur - base, pct: base === 0 ? null : Math.round(((cur - base) / Math.abs(base)) * 1000) / 10 };
}

export interface Comparison {
  revenue: Delta;
  cost: Delta;
  gross: Delta;
}
export function compareTotals(cur: Totals, base: Totals): Comparison {
  return { revenue: delta(cur.revenue, base.revenue), cost: delta(cur.cost, base.cost), gross: delta(cur.gross, base.gross) };
}

// ---- 月の足し引き（'2026-11' の形）----
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const isMonth = (m: string) => MONTH_RE.test(m);

export function shiftMonth(month: string, by: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`月の形が違う：${month}`);
  const n = Number(m[1]) * 12 + (Number(m[2]) - 1) + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
}
export const prevMonth = (month: string) => shiftMonth(month, -1);
export const prevYearMonth = (month: string) => shiftMonth(month, -12);
/** 月（2026-11）→ その月の1日（2026-11-01） */
export const monthStart = (month: string) => `${month}-01`;
