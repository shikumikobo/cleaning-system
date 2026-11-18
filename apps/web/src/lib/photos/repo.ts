// Supabase を呼ぶ薄い層（機能 008）。権限と会社は RLS が決める。ここは「どの表をどう読み書きするか」だけを持つ。
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk, dayRangeJst } from "./format";
import type { Outcome, PhotoSender } from "./queue";
import type { PhotoKind, PhotoRow } from "./types";

export const BUCKET = "tenant-files";
export const LIST_LIMIT = 200;
/** sign-file-urls の1回の上限（005 と同じ） */
export const SIGN_CHUNK = 100;

function fail<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data as T;
}

export interface ListFilter {
  building?: string;
  /** 日本時間の日（YYYY-MM-DD） */
  day?: string;
  request?: string;
  work?: string;
  kind?: string;
}

/** 今の会社の、消していない写真を、撮った時刻の新しい順に（R-008-32）。一覧は行だけ。画像は小さな画像の URL を別に取る */
export async function listPhotos(sb: SupabaseClient, tenantId: string, f: ListFilter = {}): Promise<PhotoRow[]> {
  let q = sb.from("photos").select("*").eq("tenant_id", tenantId).is("deleted_at", null);
  if (f.building) q = q.eq("building_id", f.building);
  if (f.request) q = q.eq("request_id", f.request);
  if (f.work) q = q.eq("work_id", f.work);
  if (f.kind) q = q.eq("kind", f.kind);
  const range = f.day ? dayRangeJst(f.day) : null;
  if (range) q = q.gte("taken_at", range.from).lt("taken_at", range.to);
  return fail(await q.order("taken_at", { ascending: false }).limit(LIST_LIMIT));
}

export async function getPhoto(sb: SupabaseClient, tenantId: string, id: string): Promise<PhotoRow | null> {
  return fail(await sb.from("photos").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}

/** 種類・場所・部屋を直す（R-008-34）。撮った本人（作業の担当）だけ。判定は DB */
export async function updatePhoto(sb: SupabaseClient, id: string, patch: { kind?: PhotoKind; area_id?: string | null; room_id?: string | null }): Promise<PhotoRow> {
  return fail(await sb.from("photos").update(patch).eq("id", id).select().single());
}

/** 消すのは論理削除（置き場所の実体は、掃除が消す）。R-008-34 */
export async function deletePhoto(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("photos").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}

export interface SignedPhotoUrls {
  urls: Record<string, string>;
  notFound: string[];
  failed: string[];
}

/** 期限つきの URL を、まとめて取る（100 個ずつ）。variant：小さな画像（thumb）か元の画像（original）。R-008-32・33 */
export async function signPhotoUrls(sb: SupabaseClient, ids: string[], variant: "thumb" | "original"): Promise<SignedPhotoUrls> {
  const out: SignedPhotoUrls = { urls: {}, notFound: [], failed: [] };
  for (const part of chunk([...new Set(ids)], SIGN_CHUNK)) {
    const { data, error } = await sb.functions.invoke("sign-file-urls", { body: { ids: part, source: "photos", variant } });
    if (error) throw error;
    const d = (data ?? {}) as { urls?: Record<string, string>; not_found?: string[]; failed?: string[] };
    Object.assign(out.urls, d.urls ?? {});
    out.notFound.push(...(d.not_found ?? []));
    out.failed.push(...(d.failed ?? []));
  }
  return out;
}

export interface ObservationFromPhotos {
  /** 端末で作った uuid（二度呼んでも1件） */
  id: string;
  building_id: string;
  title: string;
  detail?: string;
  room_id?: string;
  category?: string;
  photo_ids: string[];
}

/** 気づきの写真から案件を作る（R-008-36）。003 の RPC に写真の ID を渡す。写真の request_id が入る */
export async function createRequestFromPhotos(sb: SupabaseClient, p: ObservationFromPhotos): Promise<{ ok: boolean; id: string; already: boolean; photos?: number }> {
  return fail(
    await sb.rpc("create_request_from_observation", {
      p_id: p.id,
      p_building_id: p.building_id,
      p_title: p.title.trim(),
      p_detail: p.detail?.trim() ? p.detail.trim() : null,
      p_room_id: p.room_id || null,
      p_category: p.category || "other",
      p_photo_ids: p.photo_ids,
    }),
  );
}

function outcome(error: { message: string; code?: string; status?: number; statusCode?: string | number } | null): Outcome {
  if (!error) return { ok: true };
  const code = error.code;
  const msg = error.message ?? "";
  if (code === "23505") return { ok: true, duplicate: true };
  if (/jwt|expired|unauthor/i.test(msg) || code === "PGRST301") return { ok: false, kind: "auth", message: msg, code };
  if (!code && /fetch|network|offline|load failed/i.test(msg)) return { ok: false, kind: "network", message: msg };
  return { ok: false, kind: "server", message: msg, code };
}

/** 端末にためた写真を送る口：Storage には上書きありで上げ（送り直しで二重にならない）、行は既にあれば無視する書き方で作る */
export function createPhotoSender(sb: SupabaseClient): PhotoSender {
  return {
    async uploadFile(path, bytes) {
      const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      return outcome(error as { message: string } | null);
    },
    async insertRow(row) {
      const { error } = await sb.from("photos").upsert(row, { onConflict: "id", ignoreDuplicates: true });
      return outcome(error);
    },
    /** 報告書の項目の行がサーバーにあるか（R-009-29） */
    async ready(row) {
      if (!row.report_item_id) return true;
      const { data, error } = await sb.from("report_items").select("id").eq("id", row.report_item_id).maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    },
  };
}
