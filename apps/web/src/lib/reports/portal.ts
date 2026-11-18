// 外部の人の専用ページ（機能 005）に出す、報告書と写真の区画（機能 009。R-005-28 の登録簿に足す）。
// 外部の人が読めるのは、許された建物の、提出した報告書とその写真だけ（DB の権限が最後の守り）。
// 区画は建物の ID だけで中身を取る。名前・担当・金額は取らない。
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerPortalSection, type PortalItem, type PortalSection } from "../files/portal";
import { formatDateJa } from "../quotes/format";
import { kindLabel } from "../photos/format";
import { progressLabel, sortReportItems } from "./format";

interface PortalReportRow {
  id: string;
  work_id: string;
  remarks: string;
  submitted_at: string | null;
}
interface PortalItemRow {
  id: string;
  report_id: string;
  name: string;
  sort: number;
  done: boolean;
  note: string;
}
interface PortalWorkRow {
  id: string;
  scheduled_date: string;
}
interface PortalPhotoRow {
  id: string;
  kind: string;
  taken_at: string;
  report_item_id: string | null;
}

/** 専用ページが報告書・項目・作業・写真から取る列 */
export const PORTAL_REPORT_COLUMNS = "id, work_id, remarks, submitted_at";
export const PORTAL_REPORT_ITEM_COLUMNS = "id, report_id, name, sort, done, note";
export const PORTAL_REPORT_WORK_COLUMNS = "id, scheduled_date";
export const PORTAL_REPORT_PHOTO_COLUMNS = "id, kind, taken_at, report_item_id";

function rows<T>(res: { data: T[] | null; error: { message: string } | null }): T[] {
  if (res.error) throw new Error(res.error.message);
  return res.data ?? [];
}

/** 建物の、提出した報告書と項目・作業を取る */
async function loadReports(sb: SupabaseClient, buildingId: string) {
  const works = rows<PortalWorkRow>(await sb.from("works").select(PORTAL_REPORT_WORK_COLUMNS).eq("building_id", buildingId).is("deleted_at", null));
  if (works.length === 0) return { reports: [] as PortalReportRow[], items: [] as PortalItemRow[], works };
  const reports = rows<PortalReportRow>(
    await sb.from("reports").select(PORTAL_REPORT_COLUMNS).in("work_id", works.map((w) => w.id)).eq("status", "submitted").is("deleted_at", null),
  );
  if (reports.length === 0) return { reports, items: [] as PortalItemRow[], works };
  const items = rows<PortalItemRow>(
    await sb.from("report_items").select(PORTAL_REPORT_ITEM_COLUMNS).in("report_id", reports.map((r) => r.id)).is("deleted_at", null),
  );
  return { reports, items, works };
}

export const reportsPortalSection: PortalSection = {
  id: "reports",
  title: "清掃報告書",
  async load(sb: SupabaseClient, buildingId: string): Promise<PortalItem[]> {
    const { reports, items, works } = await loadReports(sb, buildingId);
    const dateOf = (workId: string) => works.find((w) => w.id === workId)?.scheduled_date ?? "";
    return [...reports]
      .sort((a, b) => (dateOf(a.work_id) < dateOf(b.work_id) ? 1 : -1))
      .map((r) => {
        const mine = sortReportItems(items.filter((i) => i.report_id === r.id));
        return {
          key: r.id,
          label: formatDateJa(dateOf(r.work_id)),
          detail: `チェック ${progressLabel(mine)}${r.remarks ? `／${r.remarks}` : ""}`,
          children: mine.map((i) => ({ key: i.id, label: `${i.done ? "済" : "未"} ${i.name}`, detail: i.note })),
        };
      });
  },
};

export const reportPhotosPortalSection: PortalSection = {
  id: "report-photos",
  title: "報告書の写真",
  async load(sb: SupabaseClient, buildingId: string): Promise<PortalItem[]> {
    const list = rows<PortalPhotoRow>(
      await sb
        .from("photos")
        .select(PORTAL_REPORT_PHOTO_COLUMNS)
        .eq("building_id", buildingId)
        .not("report_item_id", "is", null)
        .is("deleted_at", null)
        .order("taken_at", { ascending: false })
        .limit(100),
    );
    return list.map((p) => ({ key: p.id, label: `${formatDateJa(p.taken_at.slice(0, 10))} ${kindLabel(p.kind)}`, photoId: p.id }));
  },
};

/** 専用ページの登録簿に足す（同じ id なら置き換わるので、何度呼んでもよい） */
export function registerReportPortalSections(): void {
  registerPortalSection(reportsPortalSection);
  registerPortalSection(reportPhotosPortalSection);
}
