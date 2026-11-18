// Supabase を呼ぶ薄い層。取り込んだ人のログインの鍵で呼ぶ（RLS と権限を通る。service_role は使わない。R-014-12）。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Kind } from "./columns";
import type { ImportResult } from "./format";
import type { Existing, Plan } from "./plan";

const PAGE = 1000;
type Row = Record<string, unknown>;

/** 1000 行を超えても全部読む（読み残すと、重なりや名前の解決を間違える） */
async function fetchAll(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await build(from, from + PAGE - 1);
    if (res.error) throw new Error(res.error.message);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** すでに登録されているもの（今の会社の、消していない行）を読む。重なりと名前の解決に使う */
export async function loadExisting(sb: SupabaseClient, tenantId: string, kind: Kind): Promise<Existing> {
  const q = (table: string, cols: string) => (from: number, to: number) =>
    sb.from(table).select(cols).eq("tenant_id", tenantId).is("deleted_at", null).order("id").range(from, to) as unknown as PromiseLike<{
      data: Row[] | null;
      error: { message: string } | null;
    }>;
  const existing: Existing = { clients: [], buildings: [], rooms: [], contracts: [] };
  existing.clients = (await fetchAll(q("clients", "id, name"))).map((r) => ({ id: String(r.id), name: String(r.name) }));
  if (kind === "clients") return existing;
  existing.buildings = (await fetchAll(q("buildings", "id, client_id, name"))).map((r) => ({ id: String(r.id), client_id: String(r.client_id), name: String(r.name) }));
  if (kind === "buildings") return existing;
  if (kind === "rooms") {
    existing.rooms = (await fetchAll(q("rooms", "building_id, room_no"))).map((r) => ({ building_id: String(r.building_id), room_no: String(r.room_no) }));
    return existing;
  }
  // 契約：今の中身（閉じていないもの）の名前を、契約ごとにまとめる
  const contracts = await fetchAll(q("contracts", "id, building_id, kind, start_date"));
  const services = await fetchAll(q("contract_services", "contract_id, name, valid_to"));
  const names = new Map<string, string[]>();
  for (const s of services) {
    if (s.valid_to !== null && s.valid_to !== undefined) continue;
    const id = String(s.contract_id);
    names.set(id, [...(names.get(id) ?? []), String(s.name)]);
  }
  existing.contracts = contracts.map((c) => ({ building_id: String(c.building_id), kind: String(c.kind), start_date: String(c.start_date), serviceNames: names.get(String(c.id)) ?? [] }));
  return existing;
}

/** 確かめた結果を書く（RPC import_rows。1回で、まとめて） */
export async function runImport(sb: SupabaseClient, tenantId: string, kind: Kind, fileName: string, plan: Plan): Promise<ImportResult> {
  const { data, error } = await sb.rpc("import_rows", {
    p_tenant: tenantId,
    p_kind: kind,
    p_file_name: fileName,
    p_total_rows: plan.counts.total,
    p_excluded: plan.excluded,
    p_rows: plan.payload,
  });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as ImportResult;
}

export interface ImportJob {
  id: string;
  kind: Kind;
  file_name: string;
  status: string;
  total_rows: number;
  created_count: number;
  skipped_count: number;
  error_rows: number;
  created_at: string;
}

/** 取り込みの履歴（新しい順） */
export async function listImportJobs(sb: SupabaseClient, tenantId: string): Promise<ImportJob[]> {
  const { data, error } = await sb
    .from("import_jobs")
    .select("id, kind, file_name, status, total_rows, created_count, skipped_count, error_rows, created_at")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  return (data ?? []) as ImportJob[];
}
