// Supabase を呼ぶ薄い層（機能 009）。権限と会社は RLS と RPC が決める。ここは「どの表をどう読み書きするか」だけを持つ。
// 状況の切り替え（確認・差し戻し・提出）は RPC だけ（画面は status を直接書かない）。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportOutcome, ReportSender } from "./queue";
import type {
  NewReportItemRow,
  NewReportRow,
  ReportActionResult,
  ReportItemRow,
  ReportRow,
  TemplateDeleteResult,
  TemplateItemRow,
  TemplateRow,
} from "./types";

function fail<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data as T;
}

// ---- ひな形（R-009-1・2・4・5・35）----

/** 建物のひな形（消していないもの）。使わないものも出す（画面で区別する） */
export async function listTemplates(sb: SupabaseClient, tenantId: string, buildingId: string): Promise<TemplateRow[]> {
  return fail(await sb.from("report_templates").select("*").eq("tenant_id", tenantId).eq("building_id", buildingId).is("deleted_at", null).order("name"));
}
export async function listTemplateItems(sb: SupabaseClient, tenantId: string, templateIds: string[]): Promise<TemplateItemRow[]> {
  if (templateIds.length === 0) return [];
  return fail(
    await sb.from("template_items").select("*").eq("tenant_id", tenantId).in("template_id", templateIds).is("deleted_at", null).order("sort"),
  );
}
export async function createTemplate(sb: SupabaseClient, tenantId: string, buildingId: string, name: string): Promise<TemplateRow> {
  return fail(await sb.from("report_templates").insert({ tenant_id: tenantId, building_id: buildingId, name: name.trim() }).select().single());
}
export async function updateTemplate(sb: SupabaseClient, id: string, patch: { name?: string; active?: boolean }): Promise<TemplateRow> {
  return fail(await sb.from("report_templates").update(patch).eq("id", id).select().single());
}
export async function createTemplateItem(
  sb: SupabaseClient,
  tenantId: string,
  templateId: string,
  i: { name: string; area_id: string | null; sort: number },
): Promise<TemplateItemRow> {
  return fail(
    await sb.from("template_items").insert({ tenant_id: tenantId, template_id: templateId, name: i.name.trim(), area_id: i.area_id || null, sort: i.sort }).select().single(),
  );
}
export async function updateTemplateItem(
  sb: SupabaseClient,
  id: string,
  patch: { name?: string; area_id?: string | null; sort?: number; active?: boolean },
): Promise<TemplateItemRow> {
  return fail(await sb.from("template_items").update(patch).eq("id", id).select().single());
}
export async function deleteTemplate(sb: SupabaseClient, id: string): Promise<TemplateDeleteResult> {
  return fail(await sb.rpc("delete_report_template", { p_id: id }));
}
export async function deleteTemplateItem(sb: SupabaseClient, id: string): Promise<TemplateDeleteResult> {
  return fail(await sb.rpc("delete_template_item", { p_id: id }));
}

// ---- 作業・報告書の読み取り（R-009-31〜34）----

export interface WorkRef {
  id: string;
  building_id: string;
  title: string;
  scheduled_date: string;
  status: string;
  report_template_id: string | null;
}
const WORK_COLUMNS = "id, building_id, title, scheduled_date, status, report_template_id";

/** 報告書を作る作業の一覧（RLS：スタッフは担当の作業だけ、work.assign を持つ人は全部）。from〜to（日本時間の日）。新しい順 */
export async function listReportableWorks(sb: SupabaseClient, tenantId: string, from: string, to: string): Promise<WorkRef[]> {
  return fail(
    await sb
      .from("works")
      .select(WORK_COLUMNS)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .neq("status", "cancelled")
      .gte("scheduled_date", from)
      .lte("scheduled_date", to)
      .order("scheduled_date", { ascending: false }),
  );
}
export async function getWork(sb: SupabaseClient, tenantId: string, id: string): Promise<WorkRef | null> {
  return fail(await sb.from("works").select(WORK_COLUMNS).eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}
export async function listReports(sb: SupabaseClient, tenantId: string, workIds?: string[]): Promise<ReportRow[]> {
  let q = sb.from("reports").select("*").eq("tenant_id", tenantId).is("deleted_at", null);
  if (workIds) {
    if (workIds.length === 0) return [];
    q = q.in("work_id", workIds);
  }
  return fail(await q.order("created_at", { ascending: false }));
}
export async function getReport(sb: SupabaseClient, tenantId: string, id: string): Promise<ReportRow | null> {
  return fail(await sb.from("reports").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}
export async function getReportOfWork(sb: SupabaseClient, tenantId: string, workId: string): Promise<ReportRow | null> {
  return fail(await sb.from("reports").select("*").eq("tenant_id", tenantId).eq("work_id", workId).is("deleted_at", null).maybeSingle());
}
export async function listReportItems(sb: SupabaseClient, tenantId: string, reportId: string): Promise<ReportItemRow[]> {
  return fail(await sb.from("report_items").select("*").eq("tenant_id", tenantId).eq("report_id", reportId).is("deleted_at", null).order("sort"));
}

// ---- 確認・差し戻し・提出（R-009-14〜16・33）----
const act = async (sb: SupabaseClient, fn: string, id: string): Promise<ReportActionResult> => fail(await sb.rpc(fn, { p_id: id }));
export const checkReport = (sb: SupabaseClient, id: string) => act(sb, "check_report", id);
export const reopenReport = (sb: SupabaseClient, id: string) => act(sb, "reopen_report", id);
export const submitReport = (sb: SupabaseClient, id: string) => act(sb, "submit_report", id);

// ---- 端末にためた報告書を送る口（R-009-26〜28）----

function outcome(error: { message: string; code?: string } | null, dupOnUnique = true): ReportOutcome {
  if (!error) return { ok: true };
  const { code } = error;
  const msg = error.message ?? "";
  if (code === "23505") {
    // 同じ作業に別の uuid の報告書（reports_work_uq）は、重複ではなく、断られたもの
    if (/reports_work_uq/.test(msg)) return { ok: false, kind: "server", code, message: "この作業の報告書は、ほかの端末で作られています。そちらを開いて直してください" };
    return dupOnUnique ? { ok: true, duplicate: true } : { ok: false, kind: "server", code, message: msg };
  }
  if (/jwt|expired|unauthor/i.test(msg) || code === "PGRST301") return { ok: false, kind: "auth", message: msg, code };
  if (!code && /fetch|network|offline|load failed/i.test(msg)) return { ok: false, kind: "network", message: msg };
  return { ok: false, kind: "server", message: msg, code };
}

const LOCKED = "確認・提出のあとなので、直せません";

export function createReportSender(sb: SupabaseClient): ReportSender {
  return {
    async insertReport(row: NewReportRow) {
      const { error } = await sb.from("reports").upsert(row, { onConflict: "id", ignoreDuplicates: true });
      return outcome(error);
    },
    async insertItems(rows: NewReportItemRow[]) {
      if (rows.length === 0) return { ok: true };
      const { error } = await sb.from("report_items").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      return outcome(error);
    },
    async updateItem(item: NewReportItemRow) {
      const { data, error } = await sb.from("report_items").update({ done: item.done, note: item.note }).eq("id", item.id).select("id");
      if (error) return outcome(error, false);
      return (data ?? []).length > 0 ? { ok: true } : { ok: false, kind: "server", code: "locked", message: LOCKED };
    },
    async updateRemarks(id: string, remarks: string, baseVersion: number) {
      const { data, error } = await sb.from("reports").update({ remarks, version: baseVersion + 1 }).eq("id", id).eq("version", baseVersion).select("id");
      if (error) return outcome(error, false);
      if ((data ?? []).length > 0) return { ok: true, version: baseVersion + 1 };
      // 0 行：版の食い違いか、固定のあと。サーバーの中身を見て決める
      const cur = await sb.from("reports").select("remarks, version, status").eq("id", id).maybeSingle();
      if (cur.error) return outcome(cur.error, false);
      const row = cur.data as { remarks: string; version: number; status: string } | null;
      if (!row) return { ok: false, kind: "server", code: "locked", message: LOCKED };
      if (row.remarks === remarks) return { ok: true, version: row.version };
      if (row.status !== "draft") return { ok: false, kind: "server", code: "locked", message: LOCKED };
      return { ok: false, kind: "server", code: "version", message: "ほかの人が直しています。この端末の分をあきらめて、開き直してください" };
    },
  };
}
