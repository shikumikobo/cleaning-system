// 住所から位置を求める処理の判断（機能 013、R-013-2〜4・8〜11）。外への口（DB・位置の API・待ち時間）はすべて引数で受ける。
// Deno にも Node にも依存しない（単体のテストは Vitest で、偽の口を渡して確かめる）。設計は specs/013-map/design.md の3章。
//
// 守ること
// - 会社ごとに分けて回し、会社ごと・1回ごとに処理の記録（job_runs、種類 geocode_buildings）を残す
// - 1つの会社の失敗が、ほかの会社を止めない
// - 位置の API は adapter（Geocoder）で差し替える。何も選ばれていなければ「口が未設定」で失敗にし、位置は作らない
// - 鍵や環境変数の値を、記録・エラー・戻り値に出さない

/** 鍵のような長い文字列を伏せる（015 の sanitizeError と同じ。Deno の import の拡張子を避けるため、ここに置く） */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "error";
  return raw.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "***").slice(0, 200);
}

// --- 差し替えられる口（adapter）---------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Geocoder {
  /** 住所から位置を求める。見つからなければ null。通信の失敗などは例外 */
  geocode(address: string): Promise<LatLng | null>;
}

/** 位置の API が選ばれていない（配備のときに人が選ぶ）。処理を失敗にし、位置は作らない */
export class GeocoderNotConfigured extends Error {
  constructor() {
    super("geocoder_not_configured");
    this.name = "GeocoderNotConfigured";
  }
}

export const notConfiguredGeocoder: Geocoder = {
  async geocode() {
    throw new GeocoderNotConfigured();
  },
};

/** 取得の関数（fetch と同じ形のうち、使う部分だけ） */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** 国土地理院の住所検索の応答（GeoJSON の配列）の先頭の点を位置に読み替える。点がなければ null。壊れた応答でも落ちない */
export function parseGsiResponse(body: unknown): LatLng | null {
  if (!Array.isArray(body)) return null;
  for (const f of body) {
    const c = (f as { geometry?: { type?: unknown; coordinates?: unknown } } | null)?.geometry;
    if (!c || c.type !== "Point" || !Array.isArray(c.coordinates)) continue;
    const [lng, lat] = c.coordinates as unknown[];
    if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return null;
}

export const GSI_ENDPOINT = "https://msearch.gsi.go.jp/address-search/AddressSearch";

/** 国土地理院の住所検索（日本の住所。キー不要）。使うかどうかは配備のときに人が選ぶ（環境 GEOCODER=gsi） */
export function createGsiGeocoder(fetchFn: FetchLike): Geocoder {
  return {
    async geocode(address) {
      const res = await fetchFn(`${GSI_ENDPOINT}?q=${encodeURIComponent(address)}`);
      if (!res.ok) throw new Error(`geocoder_http_${res.status}`);
      return parseGsiResponse(await res.json());
    },
  };
}

/** 環境の設定から口を選ぶ。GEOCODER が未設定・知らない名前なら「口が未設定」 */
export function createGeocoder(env: Record<string, string | undefined>, fetchFn: FetchLike): Geocoder {
  switch ((env.GEOCODER ?? "").toLowerCase()) {
    case "gsi":
      return createGsiGeocoder(fetchFn);
    default:
      return notConfiguredGeocoder;
  }
}

// --- 定時の処理（会社をまたぐ）--------------------------------------------------------

/** DB への口（service_role。supabase/migrations の geocode_* 関数） */
export interface GeocodeStore {
  tenants(): Promise<string[]>;
  /** 同じ会社で動いている最中なら null */
  startRun(tenant: string): Promise<string | null>;
  pending(tenant: string, limit: number): Promise<Array<{ id: string; address: string }>>;
  /** 保存。位置が空で直していないときだけ書く（false なら書かなかった） */
  apply(tenant: string, building: string, lat: number, lng: number): Promise<boolean>;
  fail(tenant: string, building: string): Promise<void>;
  finishRun(tenant: string, run: string, status: "success" | "failure", counts: Record<string, number>, error: string | null): Promise<void>;
}

export interface GeocodeSummary {
  tenants: number;
  skipped: number;
  failedTenants: number;
  geocoded: number;
  notFound: number;
  errors: number;
  superseded: number;
}

/** 1 回の処理で、1 社あたりに求める建物の数の上限 */
export const GEOCODE_LIMIT = 50;
/** 外の API の利用の決まりを守る、1 件ごとの待ち時間（ミリ秒） */
export const GEOCODE_DELAY_MS = 1100;
/** 通信の失敗がこの回数続いたら、その会社の処理を止める（叩き続けない） */
export const MAX_CONSECUTIVE_ERRORS = 3;

export interface GeocodeDeps {
  store: GeocodeStore;
  geocoder: Geocoder;
  limit?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runGeocode(deps: GeocodeDeps): Promise<GeocodeSummary> {
  const { store, geocoder } = deps;
  const limit = deps.limit ?? GEOCODE_LIMIT;
  const delayMs = deps.delayMs ?? GEOCODE_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const summary: GeocodeSummary = { tenants: 0, skipped: 0, failedTenants: 0, geocoded: 0, notFound: 0, errors: 0, superseded: 0 };

  for (const tenant of await store.tenants()) {
    summary.tenants++;
    let run: string | null = null;
    try {
      run = await store.startRun(tenant);
      if (!run) {
        summary.skipped++;
        continue;
      }
      const counts = { geocoded: 0, not_found: 0, errors: 0, superseded: 0 };
      let streak = 0;
      let first = true;
      let abort: string | null = null;
      for (const b of await store.pending(tenant, limit)) {
        if (!first && delayMs > 0) await sleep(delayMs);
        first = false;
        const address = (b.address ?? "").trim();
        try {
          const pos = address ? await geocoder.geocode(address) : null;
          streak = 0;
          if (!pos) {
            await store.fail(tenant, b.id); // 見つからない：7 日は求め直さない
            counts.not_found++;
          } else if (await store.apply(tenant, b.id, pos.lat, pos.lng)) {
            counts.geocoded++;
          } else {
            counts.superseded++; // その間に人が直していた
          }
        } catch (e) {
          if (e instanceof GeocoderNotConfigured) {
            abort = "geocoder_not_configured";
            break;
          }
          counts.errors++; // 通信の失敗など：失敗の印は付けない（次の処理でもう一度）
          if (++streak >= MAX_CONSECUTIVE_ERRORS) {
            abort = "too_many_errors";
            break;
          }
        }
      }
      summary.geocoded += counts.geocoded;
      summary.notFound += counts.not_found;
      summary.errors += counts.errors;
      summary.superseded += counts.superseded;
      if (abort) {
        summary.failedTenants++;
        await store.finishRun(tenant, run, "failure", counts, abort);
      } else {
        await store.finishRun(tenant, run, "success", counts, null);
      }
    } catch (e) {
      summary.failedTenants++;
      if (run) {
        try {
          await store.finishRun(tenant, run, "failure", {}, sanitizeError(e));
        } catch {
          // 記録そのものが書けないときは、次の会社へ進む（30 分で古い記録は閉じられる）
        }
      }
    }
  }
  return summary;
}

// --- 画面から 1 件だけ求める入口（ログインした人）--------------------------------------------

export interface FnResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface GeocodeOneDeps {
  /** 呼んだ人のログインの鍵で、master.edit の確かめと住所の取得をする。権限がない・ほかの会社・存在しない建物は null（区別しない） */
  target(authHeader: string, buildingId: string): Promise<{ address: string } | null>;
  geocoder: Geocoder;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 結果は候補の位置。保存は画面が行う（地図で確かめてから、直接の更新） */
export async function handleGeocodeOne(authHeader: string | null, input: unknown, deps: GeocodeOneDeps): Promise<FnResponse> {
  if (!authHeader) return { status: 401, body: { error: "ログインが必要です", code: "28000" } };
  const id = (input as { building_id?: unknown } | null)?.building_id;
  if (typeof id !== "string" || !UUID.test(id)) return { status: 400, body: { error: "建物の ID が正しくありません" } };
  let target: { address: string } | null;
  try {
    target = await deps.target(authHeader, id);
  } catch {
    return { status: 500, body: { error: "建物の情報を読めませんでした" } };
  }
  if (!target) return { status: 403, body: { error: "権限がありません", code: "42501" } };
  const address = (target.address ?? "").trim();
  if (!address) return { status: 200, body: { found: false } };
  try {
    const pos = await deps.geocoder.geocode(address);
    return pos ? { status: 200, body: { found: true, lat: pos.lat, lng: pos.lng } } : { status: 200, body: { found: false } };
  } catch (e) {
    if (e instanceof GeocoderNotConfigured) return { status: 503, body: { error: "位置を求める口が選ばれていません", code: "geocoder_not_configured" } };
    return { status: 502, body: { error: "位置を求められませんでした" } };
  }
}
