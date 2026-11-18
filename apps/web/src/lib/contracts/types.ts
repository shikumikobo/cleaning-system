// 機能 010 の行の形（data-model.md の 010 の章）
export type ContractStatus = "active" | "ended";
export type ContractKind = "recurring" | "one_time";
export type ServiceKind = "base" | "option" | "special";
export type Billing = "monthly" | "per_visit";
export type WorkStatus = "scheduled" | "in_progress" | "done" | "skipped" | "cancelled";

export interface Contract {
  id: string;
  tenant_id: string;
  client_id: string;
  building_id: string;
  source: "quote" | "import";
  quote_id: string | null;
  kind: ContractKind;
  start_date: string;
  end_date: string | null;
  status: ContractStatus;
  created_at: string;
  deleted_at: string | null;
}

export interface ContractService {
  id: string;
  tenant_id: string;
  contract_id: string;
  service_key: string;
  service_kind: ServiceKind;
  name: string;
  amount: number;
  billing: Billing;
  recurrence: string;
  start_time: string | null;
  end_time: string | null;
  valid_from: string;
  valid_to: string | null;
  deleted_at: string | null;
}

export interface Work {
  id: string;
  tenant_id: string;
  building_id: string;
  contract_service_id: string | null;
  request_id: string | null;
  title: string;
  scheduled_date: string;
  start_time: string | null;
  end_time: string | null;
  status: WorkStatus;
  deleted_at: string | null;
}

/** RPC（契約を作る・変える・終える）の戻り */
export interface ContractResult {
  ok: boolean;
  reason?: string;
  already?: boolean;
  id?: string;
  services?: number;
  cancelled?: number;
  end_date?: string;
}
