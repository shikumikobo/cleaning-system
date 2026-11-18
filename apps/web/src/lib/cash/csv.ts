// 会計ソフトに渡す CSV（R-006-30〜32）。UTF-8（BOM つき）・CRLF。下書きは含めない。
export interface CsvEntry {
  entry_date: string; // YYYY-MM-DD
  account_name: string;
  holder_name: string;
  direction: "in" | "out";
  amount: number;
  purpose: string;
  has_receipt: boolean;
  status: "draft" | "confirmed" | "closed";
  confirmed_at: string | null; // ISO の日時
  building_id: string | null;
}

export const CSV_HEADER = ["日付", "小口", "持ち手", "区分", "金額", "用途", "レシート", "状況", "確認日", "建物ID"] as const;

/** 式として動かさないため、= + - @ とタブ・復帰で始まる文字には、先頭に ' を付ける（R-006-32） */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  const s = FORMULA_START.test(v) ? "'" + v : v;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function slashDate(ymd: string): string {
  return ymd.slice(0, 10).replace(/-/g, "/");
}

/** 日本時間の日付（YYYY/MM/DD） */
function jstDate(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "/");
}

const STATUS_TEXT: Record<CsvEntry["status"], string> = { draft: "下書き", confirmed: "確認済み", closed: "締め済み" };

export function buildCashCsv(entries: CsvEntry[]): string {
  const rows = entries
    .filter((e) => e.status !== "draft")
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.account_name.localeCompare(b.account_name));
  const lines = [CSV_HEADER.join(",")];
  for (const e of rows) {
    lines.push(
      [
        csvCell(slashDate(e.entry_date)),
        csvCell(e.account_name),
        csvCell(e.holder_name),
        csvCell(e.direction === "in" ? "入金" : "出金"),
        csvCell(e.amount),
        csvCell(e.purpose),
        csvCell(e.has_receipt ? "あり" : "なし"),
        csvCell(STATUS_TEXT[e.status]),
        csvCell(jstDate(e.confirmed_at)),
        csvCell(e.building_id),
      ].join(","),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
