// Supabase を呼ぶ薄い層（機能 012）。権限と会社は RLS と RPC が決める。
// 状況・日時の変更は RPC だけ（画面は works を直接書かない）。担当の付ける・外すは work_assignments への直接の書き込み（work.assign）。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignmentRow, ConflictRow, MonthlyRow, OverlapRow, PlanActualRow, StaffRow, WorkRecordRow, WorkResult, WorkRow } from "./types";

function fail<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data as T;
}

/** 期間の作業（取消も含む。まとめるときに画面で除く） */
export async function listWorksInRange(sb: SupabaseClient, tenantId: string, from: string, to: string): Promise<WorkRow[]> {
  return fail(await sb.from("works").select("*").eq("tenant_id", tenantId).is("deleted_at", null).gte("scheduled_date", from).lte("scheduled_date", to).order("scheduled_date"));
}
export async function getWorkRow(sb: SupabaseClient, tenantId: string, id: string): Promise<WorkRow | null> {
  return fail(await sb.from("works").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}
export async function listAssignments(sb: SupabaseClient, tenantId: string, workIds: string[]): Promise<AssignmentRow[]> {
  if (workIds.length === 0) return [];
  return fail(await sb.from("work_assignments").select("*").eq("tenant_id", tenantId).in("work_id", workIds).is("deleted_at", null));
}
/** 自分が担当の作業（の割り当て） */
export async function listMyAssignments(sb: SupabaseClient, tenantId: string, membershipId: string): Promise<AssignmentRow[]> {
  return fail(await sb.from("work_assignments").select("*").eq("tenant_id", tenantId).eq("membership_id", membershipId).is("deleted_at", null));
}
export async function listWorksByIds(sb: SupabaseClient, tenantId: string, ids: string[], from: string): Promise<WorkRow[]> {
  if (ids.length === 0) return [];
  return fail(await sb.from("works").select("*").eq("tenant_id", tenantId).in("id", ids).is("deleted_at", null).gte("scheduled_date", from).order("scheduled_date"));
}
/** 自分の実績（終わっていないもの） */
export async function listMyOpenRecords(sb: SupabaseClient, tenantId: string, membershipId: string): Promise<WorkRecordRow[]> {
  return fail(await sb.from("work_records").select("*").eq("tenant_id", tenantId).eq("membership_id", membershipId).is("ended_at", null).is("deleted_at", null));
}
export async function listRecordsOfWork(sb: SupabaseClient, tenantId: string, workId: string): Promise<WorkRecordRow[]> {
  return fail(await sb.from("work_records").select("*").eq("tenant_id", tenantId).eq("work_id", workId).is("deleted_at", null).order("started_at"));
}
export async function listOverlaps(sb: SupabaseClient, tenantId: string, from: string, to: string): Promise<OverlapRow[]> {
  return fail(await sb.from("work_overlaps").select("*").eq("tenant_id", tenantId).gte("scheduled_date", from).lte("scheduled_date", to));
}
export async function listPlanActual(sb: SupabaseClient, tenantId: string, from: string, to: string): Promise<PlanActualRow[]> {
  return fail(await sb.from("work_plan_actual").select("*").eq("tenant_id", tenantId).gte("scheduled_date", from).lte("scheduled_date", to).order("scheduled_date"));
}
export async function listMonthly(sb: SupabaseClient, tenantId: string, month: string): Promise<MonthlyRow[]> {
  return fail(await sb.from("work_monthly").select("*").eq("tenant_id", tenantId).eq("month", month));
}
export async function listStaff(sb: SupabaseClient, tenantId: string): Promise<StaffRow[]> {
  return fail(await sb.rpc("work_staff", { p_tenant: tenantId })) as StaffRow[];
}
export async function assignConflicts(sb: SupabaseClient, workId: string, membershipId: string): Promise<ConflictRow[]> {
  return fail(await sb.rpc("assign_conflicts", { p_work: workId, p_membership: membershipId })) as ConflictRow[];
}

// ---- 担当の付ける・外す（work.assign。RLS が権限と、社内の人だけを守る）----
export async function addAssignment(sb: SupabaseClient, tenantId: string, workId: string, membershipId: string): Promise<void> {
  fail(await sb.from("work_assignments").insert({ tenant_id: tenantId, work_id: workId, membership_id: membershipId }));
}
export async function removeAssignment(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("work_assignments").update({ deleted_at: new Date().toISOString() }).eq("id", id));
}

// ---- 作業の RPC ----
const rpc = async (sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<WorkResult> => fail(await sb.rpc(fn, args)) as WorkResult;

export const skipWork = (sb: SupabaseClient, workId: string, version: number | null) => rpc(sb, "skip_work", { p_work_id: workId, p_version: version });
export const cancelWork = (sb: SupabaseClient, workId: string, version: number | null) => rpc(sb, "cancel_work", { p_work_id: workId, p_version: version });
export const rescheduleWork = (sb: SupabaseClient, workId: string, version: number | null, date: string, start: string | null, end: string | null) =>
  rpc(sb, "reschedule_work", { p_work_id: workId, p_version: version, p_date: date, p_start: start || null, p_end: end || null });
export const swapAssignment = (sb: SupabaseClient, workId: string, from: string, to: string) => rpc(sb, "swap_assignment", { p_work_id: workId, p_from: from, p_to: to });
export const createWork = (
  sb: SupabaseClient,
  i: { id: string; date: string; start: string; end: string; serviceId: string; requestId: string; title: string; members: string[] },
) =>
  rpc(sb, "create_work", {
    p_id: i.id,
    p_date: i.date,
    p_start: i.start || null,
    p_end: i.end || null,
    p_contract_service_id: i.serviceId || null,
    p_request_id: i.requestId || null,
    p_title: i.title.trim() || null,
    p_members: i.members,
  });

// ---- 作業を足すときの選び先 ----
export interface ServiceChoice {
  id: string;
  name: string;
  contract_id: string;
  building_id: string;
}
/** 今の中身（閉じていない）で、有効な契約のもの */
export async function listServiceChoices(sb: SupabaseClient, tenantId: string): Promise<ServiceChoice[]> {
  const cs = fail(await sb.from("contracts").select("id, building_id").eq("tenant_id", tenantId).eq("status", "active").is("deleted_at", null)) as Array<{ id: string; building_id: string }>;
  if (cs.length === 0) return [];
  const ss = fail(
    await sb.from("contract_services").select("id, name, contract_id").eq("tenant_id", tenantId).in("contract_id", cs.map((c) => c.id)).is("valid_to", null).is("deleted_at", null),
  ) as Array<{ id: string; name: string; contract_id: string }>;
  const b = new Map(cs.map((c) => [c.id, c.building_id]));
  return ss.map((s) => ({ ...s, building_id: b.get(s.contract_id) ?? "" }));
}
export interface RequestChoice {
  id: string;
  title: string;
  building_id: string;
  status: string;
}
export async function listOpenRequests(sb: SupabaseClient, tenantId: string): Promise<RequestChoice[]> {
  return fail(await sb.from("requests").select("id, title, building_id, status").eq("tenant_id", tenantId).in("status", ["new", "in_progress"]).is("deleted_at", null).order("created_at", { ascending: false }));
}
