// 表（行と列）を、見出しの名前で項目に割り当て、行ごとのまとまりにする（R-014-4）。
import { columnsOf, type Kind } from "./columns";
import { headerKey } from "./normalize";

export interface SourceRow {
  /** ファイルの行番号（見出しが1行目） */
  row: number;
  cells: Record<string, string>;
}

export type TableResult =
  | { ok: true; rows: SourceRow[]; /** 知らない見出し（無視した） */ ignored: string[] }
  | { ok: false; /** 足りない必須の見出し */ missing: string[] };

export function toTable(kind: Kind, matrix: string[][]): TableResult {
  const cols = columnsOf(kind);
  const header = matrix[0] ?? [];
  const index: Record<string, number> = {};
  const ignored: string[] = [];
  header.forEach((h, i) => {
    const key = headerKey(h);
    if (key === "") return;
    const col = cols.find((c) => headerKey(c.label) === key || (c.aliases ?? []).some((a) => headerKey(a) === key));
    if (col && index[col.field] === undefined) index[col.field] = i;
    else ignored.push(h.trim());
  });
  const missing = cols.filter((c) => c.required && index[c.field] === undefined).map((c) => c.label);
  if (missing.length > 0) return { ok: false, missing };
  const rows: SourceRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const line = matrix[r];
    if (line.every((c) => c.trim() === "")) continue;
    const cells: Record<string, string> = {};
    for (const c of cols) cells[c.field] = index[c.field] === undefined ? "" : (line[index[c.field]] ?? "").trim();
    rows.push({ row: r + 1, cells });
  }
  return { ok: true, rows, ignored };
}
