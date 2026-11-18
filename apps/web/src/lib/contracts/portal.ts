// 外部の人の専用ページ（機能 005）に出す、作業の日と状況の区画（機能 010。R-005-28 の登録簿に足す）。
// 外部の人が読めるのは、許された建物の作業の日と状況だけ（作業の名前・担当・金額・実績は取らない。DB の権限が最後の守り）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerPortalSection, type PortalItem, type PortalSection } from "../files/portal";
import { formatDateJa } from "../quotes/format";
import { workStatusLabel } from "./format";

interface PortalWorkRow {
  id: string;
  scheduled_date: string;
  status: string;
}

/** 専用ページが作業から取る列 */
export const PORTAL_WORK_COLUMNS = "id, scheduled_date, status";

export const worksPortalSection: PortalSection = {
  id: "works",
  title: "作業の予定",
  async load(sb: SupabaseClient, buildingId: string): Promise<PortalItem[]> {
    const r = await sb
      .from("works")
      .select(PORTAL_WORK_COLUMNS)
      .eq("building_id", buildingId)
      .neq("status", "cancelled")
      .is("deleted_at", null)
      .order("scheduled_date", { ascending: false })
      .limit(50);
    if (r.error) throw new Error(r.error.message);
    return ((r.data ?? []) as PortalWorkRow[]).map((w) => ({ key: w.id, label: formatDateJa(w.scheduled_date), detail: workStatusLabel(w.status) }));
  },
};

/** 専用ページの登録簿に足す（同じ id なら置き換わるので、何度呼んでもよい） */
export function registerWorksPortalSection(): void {
  registerPortalSection(worksPortalSection);
}
