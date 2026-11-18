// 機能 016 の行の形（data-model.md の 016 の行と specs/016-profit/design.md）
export type CostKind = "outsourcing" | "material" | "other";

export interface Cost {
  id: string;
  tenant_id: string;
  /** 月の1日 */
  month: string;
  building_id: string | null;
  contract_id: string | null;
  kind: CostKind;
  amount: number;
  note: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** view profit_monthly の1行（月 × 取引先 × 建物 × 契約）。金額は円の整数 */
export interface ProfitRow {
  tenant_id: string;
  month: string;
  client_id: string | null;
  building_id: string | null;
  contract_id: string | null;
  revenue: number;
  draft_revenue: number;
  petty: number;
  outsourcing: number;
  material: number;
  other_cost: number;
  gross: number;
}

/** 集めた合計 */
export interface Totals {
  revenue: number;
  draft_revenue: number;
  petty: number;
  outsourcing: number;
  material: number;
  other_cost: number;
  /** 費用の合計（小口＋外注＋材料＋その他） */
  cost: number;
  gross: number;
}

export type GroupBy = "contract" | "building" | "client";

export interface Group {
  /** 切り方の中の鍵（建物の ID など。なしは null） */
  key: string | null;
  label: string;
  totals: Totals;
}

/** 名前の引き当て（ID → 名前） */
export interface Names {
  clients: Record<string, string>;
  buildings: Record<string, string>;
  contracts: Record<string, string>;
}

export interface Delta {
  /** 今の月 − 比べる月（円） */
  diff: number;
  /** 増減の率（%、小数 1 桁）。比べる側が 0 のときは null */
  pct: number | null;
}
