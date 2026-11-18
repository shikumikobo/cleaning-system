// 機能 004 の行の形（data-model.md の 004 の章）
export type QuoteStatus = "draft" | "submitted" | "approved" | "rejected";
export type QuoteKind = "request" | "recurring" | "special";
export type LineKind = "base" | "option" | "one_time";

export interface Item {
  id: string;
  tenant_id: string;
  name: string;
  unit: string;
  unit_price: number;
  kind: LineKind;
  deleted_at: string | null;
}

export interface Quote {
  id: string;
  tenant_id: string;
  client_id: string;
  building_id: string;
  request_id: string | null;
  kind: QuoteKind;
  number: string | null;
  issue_date: string | null;
  valid_until: string | null;
  tax_rate: number;
  subtotal: number;
  tax: number;
  total: number;
  status: QuoteStatus;
  previous_id: string | null;
  note: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface QuoteLine {
  id: string;
  tenant_id: string;
  quote_id: string;
  item_id: string | null;
  line_kind: LineKind;
  name: string;
  qty: number;
  unit: string;
  unit_price: number;
  amount: number;
  recurrence: string | null;
  sort: number;
  deleted_at: string | null;
}

/** RPC（提出・承認・不成立・直す）の戻り */
export interface ActionResult {
  ok: boolean;
  reason?: string;
  already?: boolean;
  id?: string;
  number?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  notified?: number;
}

/** 見積書に載せる会社の情報（tenants の列） */
export interface CompanyInfo {
  name: string;
  address: string | null;
  phone: string | null;
  invoice_reg_no: string | null;
}
