// 外部の人の専用ページ（機能 005）：入口と、建物ごとの「区画」の登録簿。
// 見積・報告書・作業の日と状況は、004・009・012 が自分の区画を registerPortalSection で1つ足せば、同じページに出る。
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatKind, formatSize } from "./format";

/** ホームを開いたときに移す先。外部の人は専用ページ、社内の人は移さない（R-005-26） */
export function homeFor(role: string | null | undefined): string | null {
  return role === "external" ? "/portal/" : null;
}

/** 専用ページが建物から取る列。位置・取引先・カルテの列は取らない（R-005-25） */
export const PORTAL_BUILDING_COLUMNS = "id, name, address";

export interface PortalBuilding {
  id: string;
  name: string;
  address: string;
}

export interface PortalItem {
  key: string;
  label: string;
  detail?: string;
  /** あれば、押すと期限つきの URL で開く（ファイル） */
  fileId?: string;
  /** あれば、押すと期限つきの URL で写真（009 の報告書の写真）を開く */
  photoId?: string;
  /** あれば、この項目の下に並べる中身（見積の明細など） */
  children?: PortalItem[];
}

/** 建物の ID だけで、外部の人の読める範囲から中身を取る。DB の権限（RLS）が最後の守り */
export interface PortalSection {
  id: string;
  title: string;
  load(sb: SupabaseClient, buildingId: string): Promise<PortalItem[]>;
}

/** 共有されたファイル（005 の区画）。置き場所のパスは持ってこない */
export const sharedFilesSection: PortalSection = {
  id: "shared-files",
  title: "共有されたファイル",
  async load(sb, buildingId) {
    const { data, error } = await sb
      .from("files")
      .select("id, name, mime, size")
      .eq("building_id", buildingId)
      .eq("shared_external", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<{ id: string; name: string; mime: string; size: number }>).map((f) => ({
      key: f.id,
      label: f.name,
      detail: `${formatKind(f.mime, f.name)}・${formatSize(f.size)}`,
      fileId: f.id,
    }));
  },
};

const sections: PortalSection[] = [sharedFilesSection];

export function portalSections(): PortalSection[] {
  return [...sections];
}

/** 区画を足す（同じ id なら置き換える）。004・009・012 が使う */
export function registerPortalSection(section: PortalSection): void {
  const i = sections.findIndex((s) => s.id === section.id);
  if (i >= 0) sections[i] = section;
  else sections.push(section);
}

/** 許された建物（外部の人の権限のまま取る。名前と住所だけ。R-005-22・25） */
export async function listPortalBuildings(sb: SupabaseClient, tenantId: string): Promise<PortalBuilding[]> {
  const { data, error } = await sb
    .from("buildings")
    .select(PORTAL_BUILDING_COLUMNS)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as PortalBuilding[];
}
