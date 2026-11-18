// 名前の比べ方（R-014-9）。DB の app.import_key() と同じ決まり：全角半角を揃え、空白を1つにし、大文字小文字を無視する。
export function importKey(s: string | null | undefined): string {
  return (s ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** 見出しの比べ方：importKey のうえ、空白と必須の印（*）を外す */
export function headerKey(s: string | null | undefined): string {
  return importKey(s).replace(/[\s*＊※]/g, "");
}

/** 表のセルの値を、画面に見えるとおりの文字にする（日付は yyyy-mm-dd、時刻だけのセルは hh:mm） */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const y = v.getUTCFullYear();
    const pad = (n: number) => String(n).padStart(2, "0");
    // Excel の時刻だけのセルは、1899〜1900年の日付として読まれる
    if (y <= 1900) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    return `${y}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v).trim();
}
