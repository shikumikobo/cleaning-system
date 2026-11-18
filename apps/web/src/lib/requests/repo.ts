// Supabase を呼ぶ薄い層。RLS が権限と会社を決めるので、ここは「どの表・RPC をどう呼ぶか」だけを持つ。
// 状況の変更は RPC だけ（status は直接書けない）。一覧は今の会社の tenant_id で絞る。
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseYen } from "./validate";
import type { Assignee, ObservationResult, RequestCharge, RequestRow, StatusResult } from "./types";

const nul = (v: string | undefined | null) => (v === undefined || v === null || v.trim() === "" ? null : v.trim());

function fail<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data as T;
}

export interface RequestInput {
  client_id: string;
  building_id: string;
  room_id?: string;
  source?: string;
  category?: string;
  title: string;
  detail?: string;
  due_date?: string;
  assignee_id?: string;
}

const requestRow = (i: RequestInput) => ({
  client_id: i.client_id,
  building_id: i.building_id,
  room_id: nul(i.room_id),
  source: i.source || "manual",
  category: i.category || "other",
  title: i.title.trim(),
  detail: nul(i.detail),
  due_date: nul(i.due_date),
  assignee_id: nul(i.assignee_id),
});

export async function listRequests(sb: SupabaseClient, tenantId: string): Promise<RequestRow[]> {
  return fail(await sb.from("requests").select("*").eq("tenant_id", tenantId).is("deleted_at", null).order("created_at", { ascending: false }));
}

export async function getRequest(sb: SupabaseClient, tenantId: string, id: string): Promise<RequestRow | null> {
  return fail(await sb.from("requests").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}

/** 登録（新しい案件は「受付」。状況は書かない）・直し（中身だけ。状況は書かない） */
export async function saveRequest(sb: SupabaseClient, tenantId: string, id: string | null, i: RequestInput): Promise<RequestRow> {
  if (id) return fail(await sb.from("requests").update(requestRow(i)).eq("id", id).select().single());
  return fail(await sb.from("requests").insert({ tenant_id: tenantId, ...requestRow(i) }).select().single());
}

export async function setRequestStatus(sb: SupabaseClient, id: string, status: string): Promise<StatusResult> {
  return fail(await sb.rpc("set_request_status", { p_id: id, p_status: status })) as StatusResult;
}

export async function listAssignees(sb: SupabaseClient, tenantId: string): Promise<Assignee[]> {
  return fail(await sb.rpc("request_assignees", { p_tenant: tenantId })) as Assignee[];
}

/** 気づきから案件を作る（電波があるとき。ないときは observation.ts で送り箱にためる） */
export async function createObservation(
  sb: SupabaseClient,
  p: { id: string; building_id: string; title: string; detail?: string; room_id?: string; category?: string },
): Promise<ObservationResult> {
  return fail(
    await sb.rpc("create_request_from_observation", {
      p_id: p.id,
      p_building_id: p.building_id,
      p_title: p.title.trim(),
      p_detail: nul(p.detail),
      p_room_id: nul(p.room_id),
      p_category: p.category || "other",
    }),
  ) as ObservationResult;
}

// ---- 金額（amount.read を持つ人だけ。持たない人には、RLS が何も返さない） ----
export async function listCharges(sb: SupabaseClient, tenantId: string): Promise<RequestCharge[]> {
  return fail(await sb.from("request_charges").select("*").eq("tenant_id", tenantId).is("deleted_at", null));
}

export async function getCharge(sb: SupabaseClient, tenantId: string, requestId: string): Promise<RequestCharge | null> {
  return fail(
    await sb.from("request_charges").select("*").eq("tenant_id", tenantId).eq("request_id", requestId).is("deleted_at", null).maybeSingle(),
  );
}

export async function saveCharge(
  sb: SupabaseClient,
  tenantId: string,
  requestId: string,
  existing: RequestCharge | null,
  i: { amount: string; billable: boolean },
): Promise<RequestCharge> {
  const amount = parseYen(i.amount);
  if (amount === null) throw new Error("金額は 0 以上の整数（円）で入れてください");
  if (existing) return fail(await sb.from("request_charges").update({ amount, billable: i.billable }).eq("id", existing.id).select().single());
  return fail(await sb.from("request_charges").insert({ tenant_id: tenantId, request_id: requestId, amount, billable: i.billable }).select().single());
}

/** 論理削除（請求書に載っていれば、DB が断る） */
export async function deleteCharge(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("request_charges").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}
