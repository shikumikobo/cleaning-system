// 機能 003 の行の形（data-model.md の 003 の章）
export type RequestStatus = "new" | "in_progress" | "done" | "cancelled";
export type RequestCategory = "cleaning" | "repair" | "complaint" | "inquiry" | "other";
export type RequestSource = "manual" | "phone" | "email" | "field" | "import";

export interface RequestRow {
  id: string;
  tenant_id: string;
  client_id: string;
  building_id: string;
  room_id: string | null;
  source: RequestSource;
  category: RequestCategory;
  title: string;
  detail: string | null;
  /** 日本時間の日付（YYYY-MM-DD） */
  due_date: string | null;
  assignee_id: string | null;
  status: RequestStatus;
  created_at: string;
  deleted_at: string | null;
}

export interface RequestCharge {
  id: string;
  tenant_id: string;
  request_id: string;
  amount: number;
  billable: boolean;
  deleted_at: string | null;
}

/** request_assignees の1行 */
export interface Assignee {
  membership_id: string;
  display_name: string;
  role_code: string;
}

/** set_request_status の戻り */
export interface StatusResult {
  ok: boolean;
  changed?: boolean;
  status?: RequestStatus;
  reason?: "invalid_transition" | "forbidden_transition" | "billed";
  from?: RequestStatus;
  to?: RequestStatus;
}

/** create_request_from_observation の戻り */
export interface ObservationResult {
  ok: boolean;
  id: string;
  already: boolean;
}
