// Supabase を呼ぶ薄い層（機能 005）。RLS が権限と会社を決めるので、ここは「どの表をどう読み書きするか」だけを持つ。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FileRowData, NewFileRow } from "./types";
import { uploadFileFlow, type UploadDeps } from "./upload";

export const BUCKET = "tenant-files";

/** エラーは code つきで投げる（画面の describeError が、権限などを日本語にする） */
function fail<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data as T;
}

/** 今の会社・選んだ建物の、消していないファイル（R-005-30） */
export async function listFiles(sb: SupabaseClient, tenantId: string, buildingId: string): Promise<FileRowData[]> {
  return fail(
    await sb
      .from("files")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("building_id", buildingId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  );
}

export async function setShared(sb: SupabaseClient, id: string, shared: boolean): Promise<void> {
  fail(await sb.from("files").update({ shared_external: shared }).eq("id", id).select().single());
}

/** 消すのは論理削除（置き場所の実体は、掃除が消す）。R-005-34 */
export async function deleteFile(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("files").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}

export async function uploadFile(sb: SupabaseClient, tenantId: string, buildingId: string, file: File, displayName: string): Promise<FileRowData> {
  const deps: UploadDeps = {
    newId: () => crypto.randomUUID(),
    async upload(path, f) {
      const { error } = await sb.storage.from(BUCKET).upload(path, f as File, { contentType: f.type || "application/octet-stream", upsert: false });
      if (error) throw new Error(error.message);
    },
    async removeObject(path) {
      await sb.storage.from(BUCKET).remove([path]);
    },
    async insertRow(row: NewFileRow) {
      return fail(await sb.from("files").insert(row).select().single());
    },
  };
  return uploadFileFlow(deps, tenantId, buildingId, file, displayName);
}

export interface SignedUrls {
  urls: Record<string, string>;
  notFound: string[];
  failed: string[];
}

/** 期限つきの URL を、まとめて1回で取る（R-005-9） */
export async function signUrls(sb: SupabaseClient, ids: string[]): Promise<SignedUrls> {
  const { data, error } = await sb.functions.invoke("sign-file-urls", { body: { ids } });
  if (error) throw error;
  const d = (data ?? {}) as { urls?: Record<string, string>; not_found?: string[]; failed?: string[] };
  return { urls: d.urls ?? {}, notFound: d.not_found ?? [], failed: d.failed ?? [] };
}

/** ファイルを開く：URL を取って、別のタブで開く（R-005-33・27） */
export async function openFile(sb: SupabaseClient, id: string): Promise<void> {
  const r = await signUrls(sb, [id]);
  const url = r.urls[id];
  if (!url) throw new Error("このファイルは開けません（共有が外れたか、消されました）");
  window.open(url, "_blank", "noopener");
}
