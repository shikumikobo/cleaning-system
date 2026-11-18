// 画面の純粋な関数：入力の検査・表記・並べ替え・置き場所のパス（機能 005）。DB の check と同じ決まり。
import type { FileRowData } from "./types";

export const NAME_MAX = 255;

/** 名前の検査（R-005-31）。問題なければ null */
export function validateFileName(name: string): string | null {
  if (name.trim() === "") return "名前を入れてください";
  if ([...name].length > NAME_MAX) return `名前は ${NAME_MAX} 字までです`;
  return null;
}

/** 大きさを短く出す（R-005-36） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 種類を日本語の短い名前で出す。分からなければ拡張子、それもなければ「ファイル」（R-005-36） */
export function formatKind(mime: string, name: string): string {
  const m = mime.toLowerCase();
  if (m === "application/pdf") return "PDF";
  if (m.startsWith("image/")) return "画像";
  if (m.includes("spreadsheetml") || m === "application/vnd.ms-excel") return "Excel";
  if (m.includes("wordprocessingml") || m === "application/msword") return "Word";
  if (m.includes("presentationml") || m === "application/vnd.ms-powerpoint") return "PowerPoint";
  if (m === "text/csv") return "CSV";
  if (m === "text/plain") return "テキスト";
  if (m === "application/zip") return "ZIP";
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1];
  return ext ? ext.toUpperCase() : "ファイル";
}

/** 新しい順（R-005-30）。元の配列は変えない */
export function sortFiles<T extends Pick<FileRowData, "created_at">>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/** 置き場所の側の名前：ASCII だけにし、拡張子は残す。画面に出す名前は行（name）に持つ（R-005-13） */
export function safeObjectName(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[0] ?? "";
  const base = (ext ? name.slice(0, -ext.length) : name).replace(/[^A-Za-z0-9_-]+/g, "_");
  const clean = /[A-Za-z0-9]/.test(base) ? base : "file";
  return (clean.slice(0, 80) + ext).slice(0, 100);
}

/** <tenant_id>/files/<ファイルの uuid>/<名前>（DB の check：<tenant_id>/files/ で始まる。R-005-2・13） */
export function buildStoragePath(tenantId: string, fileId: string, name: string): string {
  return `${tenantId}/files/${fileId}/${safeObjectName(name)}`;
}

/** 上げる・共有・消すを出すか（見せ方だけ。判定は DB。R-005-35） */
export function canEditFiles(perms: string[] | null | undefined): boolean {
  return !!perms && perms.includes("master.edit");
}
