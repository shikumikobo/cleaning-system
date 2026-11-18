// Supabase を呼ぶ薄い層。権限と会社は RLS が決める（view は security_invoker）。
// 費用は、画面から直接書く（RPC なし）。月・種類・金額・建物と契約の組は、DB の check と RLS が最後の守り。
import type { SupabaseClient } from "@supabase/supabase-js";
import { monthStart } from "./calc";
import { parseAmount, type CostInput } from "./validate";
import type { Cost, ProfitRow } from "./types";

interface DbError {
  message: string;
  code?: string;
}
export class ProfitError extends Error {
  code?: string;
  constructor(e: DbError) {
    super(e.message);
    this.code = e.code;
  }
}

function ok<T>(res: { data: T | null; error: DbError | null }): T {
  if (res.error) throw new ProfitError(res.error);
  return res.data as T;
}

const nul = (v: string | undefined | null) => (v === undefined || v === null || v.trim() === "" ? null : v.trim());

/** 月（2026-11 の形）の行。比べる月を一度に読めるよう、複数の月を渡せる */
export async function listProfit(sb: SupabaseClient, tenantId: string, months: string[]): Promise<ProfitRow[]> {
  return ok(await sb.from("profit_monthly").select("*").eq("tenant_id", tenantId).in("month", months.map(monthStart)));
}

export async function listCosts(sb: SupabaseClient, tenantId: string, month: string): Promise<Cost[]> {
  return ok(
    await sb.from("costs").select("*").eq("tenant_id", tenantId).eq("month", monthStart(month)).is("deleted_at", null).order("created_at", { ascending: false }),
  );
}

const row = (i: CostInput) => ({
  month: monthStart(i.month.trim()),
  kind: i.kind,
  amount: parseAmount(i.amount),
  building_id: nul(i.building_id),
  contract_id: nul(i.contract_id),
  note: nul(i.note),
});

export async function createCost(sb: SupabaseClient, tenantId: string, i: CostInput): Promise<Cost> {
  return ok(await sb.from("costs").insert({ tenant_id: tenantId, ...row(i) }).select().single());
}
export async function updateCost(sb: SupabaseClient, id: string, i: CostInput): Promise<Cost> {
  return ok(await sb.from("costs").update(row(i)).eq("id", id).select().single());
}
/** 費用を消す（論理削除） */
export async function deleteCost(sb: SupabaseClient, id: string): Promise<void> {
  ok(await sb.from("costs").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}
