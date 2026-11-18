// CSV の読み込み（R-014-2）。UTF-8（BOM の有無を問わない）と Shift_JIS（Excel の「CSV」の保存）を読む。

/** バイト列を文字にする。UTF-8 として正しければ UTF-8、そうでなければ Shift_JIS */
export function decodeCsvBytes(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/**
 * CSV の文字列を、行と列の表にする。引用符（"）・セルの中のカンマと改行・"" の引用符を扱う。
 * 途中の空行は [""] として残す（行番号がずれないように）。末尾の、全部が空の行は落とす。
 */
export function parseCsv(text: string): string[][] {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < t.length) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      endCell();
      i++;
    } else if (ch === "\r") {
      endRow();
      i += t[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      endRow();
      i++;
    } else {
      cell += ch;
      i++;
    }
  }
  if (cell !== "" || row.length > 0) endRow();
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/** 表を CSV の文字列にする（Excel で開けるよう、先頭に BOM を付ける） */
export function toCsv(matrix: string[][]): string {
  const esc = (c: string) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return "﻿" + matrix.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
