// 機能 009 の行の形（data-model.md の 009 の章・supabase/migrations/20261121010000_reports_tables.sql）
export type ReportStatus = "draft" | "checked" | "submitted";

export interface TemplateRow {
  id: string;
  tenant_id: string;
  building_id: string;
  name: string;
  active: boolean;
  deleted_at: string | null;
}

export interface TemplateItemRow {
  id: string;
  tenant_id: string;
  template_id: string;
  area_id: string | null;
  name: string;
  sort: number;
  active: boolean;
  deleted_at: string | null;
}

export interface ReportRow {
  id: string;
  tenant_id: string;
  work_id: string;
  template_id: string | null;
  status: ReportStatus;
  remarks: string;
  checked_by: string | null;
  checked_at: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  version: number;
  created_at: string;
  deleted_at: string | null;
}

export interface ReportItemRow {
  id: string;
  tenant_id: string;
  report_id: string;
  template_item_id: string | null;
  area_id: string | null;
  name: string;
  sort: number;
  done: boolean;
  note: string;
  deleted_at: string | null;
}

/** 端末から送る報告書の行（届いた時刻・作った人などは DB が入れる） */
export interface NewReportRow {
  id: string;
  tenant_id: string;
  work_id: string;
  template_id: string | null;
  remarks: string;
  client_created_at: string;
  device_id: string | null;
}

/** 端末から送る項目の行 */
export interface NewReportItemRow {
  id: string;
  tenant_id: string;
  report_id: string;
  template_item_id: string | null;
  area_id: string | null;
  name: string;
  sort: number;
  done: boolean;
  note: string;
  client_created_at: string;
  device_id: string | null;
}

/** 端末で組み立てる、報告書の下書き（報告書と項目） */
export interface ReportDraft {
  report: NewReportRow;
  items: NewReportItemRow[];
}

/** 確認・差し戻し・提出の RPC の戻り */
export interface ReportActionResult {
  ok: boolean;
  reason?: string;
  already?: boolean;
  status?: ReportStatus;
  version?: number;
}

export interface Blocker {
  reason: string;
  table: string;
  count: number;
}
/** ひな形・項目を消す RPC の戻り */
export interface TemplateDeleteResult {
  ok: boolean;
  deleted?: boolean;
  deactivated?: boolean;
  already?: boolean;
  blockers?: Blocker[];
}
