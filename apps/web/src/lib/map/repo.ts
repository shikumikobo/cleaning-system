// Supabase を呼ぶ薄い層（機能 013）。権限と会社は RLS と RPC が決める。
// 位置を直すのは建物の表への直接の更新（master.edit。crud.md の 013）。住所から求めるのは Edge Function（候補を返すだけ。保存は画面が行う）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidLatLng } from "./geo";

function fail<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data as T;
}

/** 位置を直して保存する（直した印が付く。DB の trigger も印を付ける）。範囲外は送らない */
export async function saveBuildingPosition(sb: SupabaseClient, id: string, lat: number, lng: number): Promise<void> {
  if (!isValidLatLng(lat, lng)) throw new Error("位置が正しくありません");
  const row = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), location_fixed: true };
  fail(await sb.from("buildings").update(row).eq("id", id).select("id").single());
}

/** 「住所から求め直す」：位置を空に、直した印を外す（次の定時の処理で求め直される） */
export async function resetBuildingPosition(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("buildings").update({ lat: null, lng: null, location_fixed: false }).eq("id", id).select("id").single());
}

export interface GeocodeCandidate {
  found: boolean;
  lat?: number;
  lng?: number;
}

/** Edge Function の失敗の理由の文面（R-013-10） */
export function describeGeocodeFailure(status: number | null, code: string | null): string {
  if (code === "geocoder_not_configured" || status === 503) return "位置を求める口が、まだ選ばれていません（配備のときに選びます）。地図を押して位置を決めてください";
  if (status === 403 || code === "42501") return "この建物の位置を求める権限がありません";
  if (status === 401) return "ログインし直してください";
  return "住所から位置を求められませんでした。地図を押して位置を決めてください";
}

/** 住所から位置の候補を 1 件求める（Edge Function geocode-buildings。呼んだ人のログインの鍵つき） */
export async function requestGeocode(sb: SupabaseClient, buildingId: string): Promise<GeocodeCandidate> {
  const { data, error } = await sb.functions.invoke("geocode-buildings", { body: { building_id: buildingId } });
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    let status: number | null = null;
    let code: string | null = null;
    if (ctx && typeof (ctx as Response).status === "number") {
      status = (ctx as Response).status;
      try {
        code = ((await (ctx as Response).clone().json()) as { code?: string }).code ?? null;
      } catch {
        // 本文が読めなくても、状況だけで文面を決める
      }
    }
    throw new Error(describeGeocodeFailure(status, code));
  }
  const d = (data ?? {}) as GeocodeCandidate;
  if (d.found && isValidLatLng(d.lat, d.lng)) return { found: true, lat: d.lat, lng: d.lng };
  return { found: false };
}
