// 画面の純粋な部品（機能 008）：種類の名前・置き場所・日本時間の日・絞り込み・並べ替え・撮る前の検査。
import type { PhotoKind, PhotoRow } from "./types";

export const KIND_OPTIONS: Array<{ value: PhotoKind; label: string }> = [
  { value: "before", label: "作業前" },
  { value: "after", label: "作業後" },
  { value: "observation", label: "気づき" },
];

export function kindLabel(kind: string): string {
  return KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}

/** <会社の ID>/photos/<写真の id>/photo.jpg と thumb.jpg（DB の check と同じ。R-008-2・28） */
export function buildPhotoPaths(tenantId: string, photoId: string): { photo: string; thumb: string } {
  const base = `${tenantId}/photos/${photoId}`;
  return { photo: `${base}/photo.jpg`, thumb: `${base}/thumb.jpg` };
}

const JST_MS = 9 * 3600 * 1000;

/** 日本時間の日（YYYY-MM-DD） */
export function jstDay(iso: string): string {
  return new Date(new Date(iso).getTime() + JST_MS).toISOString().slice(0, 10);
}

/** 日本時間のその日の 0 時から翌日の 0 時（UTC の ISO 文字列）。日付でなければ null（R-008-30） */
export function dayRangeJst(day: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { from: new Date(t - JST_MS).toISOString(), to: new Date(t + 24 * 3600 * 1000 - JST_MS).toISOString() };
}

/** 撮った時刻の新しい順（元の配列は変えない） */
export function sortPhotos<T extends Pick<PhotoRow, "taken_at">>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.taken_at < b.taken_at ? 1 : a.taken_at > b.taken_at ? -1 : 0));
}

export interface PhotoFilter {
  building?: string;
  /** 日本時間の日（YYYY-MM-DD） */
  day?: string;
  request?: string;
  work?: string;
  kind?: string;
}

/** 絞り込み。消した写真は出さない（R-008-29） */
export function filterPhotos<T extends Pick<PhotoRow, "building_id" | "taken_at" | "request_id" | "work_id" | "kind" | "deleted_at">>(rows: T[], f: PhotoFilter): T[] {
  return rows.filter(
    (r) =>
      !r.deleted_at &&
      (!f.building || r.building_id === f.building) &&
      (!f.day || jstDay(r.taken_at) === f.day) &&
      (!f.request || r.request_id === f.request) &&
      (!f.work || r.work_id === f.work) &&
      (!f.kind || r.kind === f.kind),
  );
}

/** 日（日本時間）ごとにまとめる。並びは渡された順 */
export function groupByDay<T extends Pick<PhotoRow, "taken_at">>(rows: T[]): Array<{ day: string; photos: T[] }> {
  const out: Array<{ day: string; photos: T[] }> = [];
  for (const r of rows) {
    const day = jstDay(r.taken_at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.photos.push(r);
    else out.push({ day, photos: [r] });
  }
  return out;
}

export const TITLE_MAX = 100;

export interface CaptureForm {
  building_id: string;
  kind: string;
  makeRequest?: boolean;
  title?: string;
}

/** 撮る前の検査（R-008-31）。気づき以外では案件は作らないので、題名は見ない */
export function validateCapture(f: CaptureForm): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.building_id) e.building_id = "建物を選んでください";
  if (f.kind === "observation" && f.makeRequest) {
    if (!f.title || f.title.trim() === "") e.title = "題名を入れてください";
    else if ([...f.title].length > TITLE_MAX) e.title = `題名は ${TITLE_MAX} 字までにしてください`;
  }
  return e;
}

/** 直す・消すを出すか（出し分け。判定は DB。R-008-35） */
export function takenByMe(photo: Pick<PhotoRow, "taken_by">, membershipId: string): boolean {
  return photo.taken_by === membershipId;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
