// 地図の部品（機能 013）：距離・道案内の URL・地図の元データの帰属・その日の作業の建物のまとめ方・位置の書式。
// 画面と DB の決まり（建物から離れている距離など）を、ここに 1 か所で置く。DB の関数 app.distance_m・app.map_far_threshold_m と同じ値。

export interface LatLng {
  lat: number;
  lng: number;
}

/** 建物から離れているとみなす距離（m）。DB の app.map_far_threshold_m() と同じ（R-013-15） */
export const FAR_THRESHOLD_M = 300;

/** 地図の元データの帰属（OpenStreetMap の利用条件。地図の下に必ず出す。R-013-21） */
export const MAP_ATTRIBUTION = "© OpenStreetMap contributors";
export const ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";

/** 地図のタイルの URL の既定（OpenStreetMap の標準のタイル）。環境の NEXT_PUBLIC_MAP_TILE_URL で差し替える（R-013-29） */
export const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export function tileUrl(env: Record<string, string | undefined> = {}): string {
  const u = (env.NEXT_PUBLIC_MAP_TILE_URL ?? "").trim();
  return /^https:\/\/.*\{z\}.*\{x\}.*\{y\}/.test(u) ? u : DEFAULT_TILE_URL;
}

/** 位置の範囲の確かめ（緯度 ±90・経度 ±180、有限の数） */
export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** 2点の距離（m。四捨五入）。ハーバーサイン。DB の app.distance_m と同じ式 */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** 「約 350 m」「約 1.2 km」 */
export function formatDistance(m: number): string {
  if (m < 1000) return `約 ${Math.round(m)} m`;
  return `約 ${(m / 1000).toFixed(1)} km`;
}

export interface Place {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

const hasPos = (p: Place): p is Place & LatLng => p.lat != null && p.lng != null;

/**
 * 道案内の URL（R-013-24）。スマホの地図アプリが開く形。位置があれば緯度・経度、なければ住所。
 * 住所や名前の特殊な文字は符号化する。URL を作るだけで、外へは出ない（開いたときだけ）。
 */
export function directionsUrl(p: Place): string {
  const dest = hasPos(p) ? `${p.lat},${p.lng}` : p.address;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

/** iPhone の純正の地図アプリ用 */
export function appleMapsUrl(p: Place): string {
  const dest = hasPos(p) ? `${p.lat},${p.lng}` : p.address;
  return `http://maps.apple.com/?daddr=${encodeURIComponent(dest)}&dirflg=d`;
}

/** 緯度・経度の表示（小数 6 桁。約 0.1 m） */
export function formatLatLng(lat: number | null | undefined, lng: number | null | undefined): string {
  if (lat == null || lng == null) return "位置なし";
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

// --- 地図に出すもの -----------------------------------------------------------------

export interface MapMarker extends LatLng {
  id: string;
  label: string;
  /** その建物の、その日の作業の数（建物の地図では 0） */
  works: number;
}

export interface BuildingPos {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

/** 位置のある建物の印。位置のない建物は印にならない（一覧に「位置なし」と出す） */
export function buildingMarkers(buildings: BuildingPos[], workCounts: Record<string, number> = {}): MapMarker[] {
  return buildings.filter(hasPos).map((b) => ({ id: b.id, label: b.name, lat: b.lat as number, lng: b.lng as number, works: workCounts[b.id] ?? 0 }));
}

export interface DayWork {
  id: string;
  building_id: string;
  title: string;
  start_time: string | null;
  end_time: string | null;
  status: string;
  deleted_at?: string | null;
}

/** その日の作業（取消・消したものを除く）を、時刻の順に並べる（R-013-22） */
export function dayWorks<T extends DayWork>(works: T[], date: string, dateOf: (w: T) => string): T[] {
  return works
    .filter((w) => dateOf(w) === date && w.status !== "cancelled" && !w.deleted_at)
    .sort((a, b) => (a.start_time ?? "99:99").localeCompare(b.start_time ?? "99:99") || a.title.localeCompare(b.title));
}

/** 建物ごとの作業の数 */
export function countByBuilding(works: Array<{ building_id: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of works) out[w.building_id] = (out[w.building_id] ?? 0) + 1;
  return out;
}

/** 印が入る範囲（[南西, 北東]）。印がなければ null */
export function boundsOf(points: LatLng[]): [LatLng, LatLng] | null {
  if (points.length === 0) return null;
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of points) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
  }
  return [{ lat: s, lng: w }, { lat: n, lng: e }];
}

/** 地図の初めの中心（印も建物もないとき。日本の中央あたり） */
export const DEFAULT_CENTER: LatLng = { lat: 36.2, lng: 138.25 };
