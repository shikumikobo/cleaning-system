// Supabase を呼ぶ薄い層。権限と会社は RLS と RPC が決める。契約の作成・変更・終了は RPC だけ（R-010-18）。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contract, ContractResult, ContractService, Work } from "./types";

function fail<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export async function listContracts(sb: SupabaseClient, tenantId: string): Promise<Contract[]> {
  return fail(await sb.from("contracts").select("*").eq("tenant_id", tenantId).is("deleted_at", null).order("start_date", { ascending: false }));
}
export async function getContract(sb: SupabaseClient, tenantId: string, id: string): Promise<Contract | null> {
  return fail(await sb.from("contracts").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}
export async function listServices(sb: SupabaseClient, tenantId: string, contractId: string): Promise<ContractService[]> {
  return fail(await sb.from("contract_services").select("*").eq("tenant_id", tenantId).eq("contract_id", contractId).is("deleted_at", null));
}
/** 予定の一覧（建物の絞りは画面で）。from 以降の日付 */
export async function listWorks(sb: SupabaseClient, tenantId: string, from: string): Promise<Work[]> {
  return fail(await sb.from("works").select("*").eq("tenant_id", tenantId).is("deleted_at", null).gte("scheduled_date", from).order("scheduled_date"));
}
export async function listWorksOfContract(sb: SupabaseClient, tenantId: string, serviceIds: string[]): Promise<Work[]> {
  if (serviceIds.length === 0) return [];
  return fail(await sb.from("works").select("*").eq("tenant_id", tenantId).is("deleted_at", null).in("contract_service_id", serviceIds).order("scheduled_date"));
}

export interface ApprovedQuote {
  id: string;
  number: string | null;
  client_id: string;
  building_id: string;
  kind: string;
  total: number;
  issue_date: string | null;
}
/** 承認された見積の一覧（契約を作る元）。すでに契約のある見積は、画面で外す */
export async function listApprovedQuotes(sb: SupabaseClient, tenantId: string): Promise<ApprovedQuote[]> {
  return fail(
    await sb
      .from("quotes")
      .select("id, number, client_id, building_id, kind, total, issue_date")
      .eq("tenant_id", tenantId)
      .eq("status", "approved")
      .is("deleted_at", null)
      .order("issue_date", { ascending: false }),
  );
}

async function rpc(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<ContractResult> {
  return fail(await sb.rpc(fn, args)) as ContractResult;
}
export const createContractFromQuote = (sb: SupabaseClient, quoteId: string, start: string, end: string | null) =>
  rpc(sb, "create_contract_from_quote", { p_quote_id: quoteId, p_start_date: start, p_end_date: end });
export const changeContractService = (sb: SupabaseClient, serviceId: string, effective: string, changes: Record<string, unknown>) =>
  rpc(sb, "change_contract_service", { p_service_id: serviceId, p_effective: effective, p_changes: changes });
export const endContract = (sb: SupabaseClient, id: string, endDate: string | null) => rpc(sb, "end_contract", { p_id: id, p_end_date: endDate });

/** 予定を、いま作り直す（Edge Function。失敗しても、次の定時の処理が作るので、画面は止めない） */
export async function regenerateWorks(sb: SupabaseClient, contractId: string): Promise<boolean> {
  try {
    const { error } = await sb.functions.invoke("generate-works", { body: { contract_id: contractId } });
    return !error;
  } catch {
    return false;
  }
}
