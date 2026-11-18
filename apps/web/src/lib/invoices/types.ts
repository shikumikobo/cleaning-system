// 機能 011 の行の形（data-model.md の 011 の章）
export type InvoiceStatus = "draft" | "issued" | "sent" | "partial" | "paid" | "cancelled";

export interface Invoice {
  id: string;
  tenant_id: string;
  client_id: string;
  /** 請求する月（その月の1日） */
  period: string;
  number: string | null;
  issue_date: string | null;
  due_date: string | null;
  tax_rate: number;
  subtotal: number;
  tax: number;
  total: number;
  status: InvoiceStatus;
  previous_id: string | null;
  note: string | null;
  issued_at: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface InvoiceLine {
  id: string;
  tenant_id: string;
  invoice_id: string;
  service_key: string | null;
  service_month: string | null;
  work_id: string | null;
  request_id: string | null;
  name: string;
  qty: number;
  unit: string;
  unit_price: number;
  amount: number;
  sort: number;
  deleted_at: string | null;
}

export interface Payment {
  id: string;
  tenant_id: string;
  invoice_id: string;
  paid_on: string;
  amount: number;
  note: string | null;
  deleted_at: string | null;
}

/** view invoice_balances の行 */
export interface Balance {
  invoice_id: string;
  total: number;
  paid: number;
  balance: number;
}

export interface CompanyInfo {
  name: string;
  address: string | null;
  phone: string | null;
  invoice_reg_no: string | null;
}

/** RPC（発行・送付・取消・削除・入金）の戻り */
export interface ActionResult {
  ok: boolean;
  reason?: string;
  already?: boolean;
  id?: string;
  number?: string;
  status?: string;
  paid?: number;
  balance?: number;
}

/** 下書きを作る RPC の戻り */
export interface DraftResult {
  ok: boolean;
  reason?: string;
  period?: string;
  created?: number;
  added?: number;
  locked?: number;
  ids?: string[];
}
