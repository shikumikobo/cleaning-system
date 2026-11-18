// 機能 012 の行の形（data-model.md の 012 の章、specs/012-schedule/design.md）
import type { WorkStatus } from "../contracts/types";

export type { WorkStatus };

/** 作業（010 の works に、012 が版を使う） */
export interface WorkRow {
  id: string;
  tenant_id: string;
  building_id: string;
  contract_service_id: string | null;
  request_id: string | null;
  service_key: string | null;
  title: string;
  scheduled_date: string;
  start_time: string | null;
  end_time: string | null;
  status: WorkStatus;
  version: number;
  run_id: string | null;
  deleted_at: string | null;
}

export interface AssignmentRow {
  id: string;
  tenant_id: string;
  work_id: string;
  membership_id: string;
  deleted_at: string | null;
}

export interface WorkRecordRow {
  id: string;
  tenant_id: string;
  work_id: string;
  membership_id: string;
  started_at: string;
  ended_at: string | null;
  /** 013：了承した開始・終了の位置は 90 日で消える。距離と警告は残る */
  start_lat?: number | null;
  start_lng?: number | null;
  end_lat?: number | null;
  end_lng?: number | null;
  distance_m?: number | null;
  distance_warning?: boolean;
  deleted_at: string | null;
}

/** 担当にできる人（work_staff の戻り） */
export interface StaffRow {
  membership_id: string;
  display_name: string;
  role_code: string;
}

/** 重なり（view work_overlaps の行：各作業から見た相手） */
export interface OverlapRow {
  tenant_id: string;
  membership_id: string;
  work_id: string;
  other_work_id: string;
  scheduled_date: string;
}

/** 担当を付ける前の確かめ（assign_conflicts の戻り） */
export interface ConflictRow {
  work_id: string;
  title: string;
  building_id: string;
  scheduled_date: string;
  start_time: string | null;
  end_time: string | null;
}

export type ReportStatusOrNone = "none" | "draft" | "checked" | "submitted";

/** 予実（view work_plan_actual） */
export interface PlanActualRow {
  tenant_id: string;
  work_id: string;
  building_id: string;
  title: string;
  scheduled_date: string;
  start_time: string | null;
  end_time: string | null;
  status: WorkStatus;
  first_started_at: string | null;
  last_ended_at: string | null;
  open_records: number | null;
  actual_minutes: number;
  start_gap_min: number | null;
  end_gap_min: number | null;
  report_id: string | null;
  report_status: ReportStatusOrNone;
  items_total: number;
  items_skipped: number;
  not_done: boolean;
  unfinished: boolean;
  report_missing: boolean;
}

/** 月ごとの集計（view work_monthly） */
export interface MonthlyRow {
  tenant_id: string;
  month: string;
  building_id: string;
  planned: number;
  done: number;
  skipped: number;
  cancelled: number;
  not_done: number;
  report_missing: number;
  planned_minutes: number;
  actual_minutes: number;
}

/** 作業の RPC の戻り */
export interface WorkResult {
  ok: boolean;
  reason?: string;
  already?: boolean;
  id?: string;
  status?: WorkStatus;
  version?: number;
}
