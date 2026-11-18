// Excel（.xlsx）の読み込みと、ひな形の書き出し（R-014-1・3）。
// 読み込みは read-excel-file（信頼できるライブラリ）。ブラウザの中でそのまま動く web-worker 版を使う。
// 書き出しは、ひな形に要るだけの小さな .xlsx を fflate（zip）で作る。
import readXlsxFile from "read-excel-file/web-worker";
import { zipSync, strToU8 } from "fflate";
import { kindLabel, type Kind } from "./columns";
import { cellText, importKey } from "./normalize";

export interface XlsxRead {
  /** 読んだシートの名前 */
  sheet: string;
  matrix: string[][];
}

/** 取り込む種類の名前のシートがあればそれを、なければ最初のシートを読む。xlsx でなければ例外 */
export async function readXlsx(buf: ArrayBuffer | Uint8Array, kind: Kind): Promise<XlsxRead> {
  const ab = buf instanceof Uint8Array ? (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) : buf;
  const sheets = await readXlsxFile<string>(ab, { parseNumber: (s: string) => s });
  if (sheets.length === 0) throw new Error("シートがありません");
  const want = importKey(kindLabel(kind));
  const chosen = sheets.find((s) => importKey(s.sheet) === want) ?? sheets[0];
  const matrix = chosen.data.map((row) => row.map((c) => cellText(c)));
  const width = Math.max(0, ...matrix.map((r) => r.length));
  return { sheet: chosen.sheet, matrix: matrix.map((r) => [...r, ...Array<string>(width - r.length).fill("")]) };
}

// ---- 書き出し ----
export type XlsxCell = string | number | { date: string } | { time: string };
export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

function cellXml(c: XlsxCell, ref: string): string {
  if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
  if (typeof c === "object" && "date" in c) {
    const [y, m, d] = c.date.split("-").map(Number);
    const serial = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
    return `<c r="${ref}" s="1"><v>${serial}</v></c>`;
  }
  if (typeof c === "object") {
    const [h, mi] = c.time.split(":").map(Number);
    return `<c r="${ref}" s="2"><v>${(h * 60 + mi) / 1440}</v></c>`;
  }
  if (c === "") return "";
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`;
}

/** 簡単な .xlsx を作る（文字・数・日付・時刻のセル。シートは複数可）。ひな形と、読み込みのテストに使う */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>` +
        sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}">` +
        `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
        `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
        `<xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ),
  };
  sheets.forEach((s, i) => {
    const rows = s.rows
      .map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => cellXml(c, `${colName(ci)}${ri + 1}`)).join("")}</row>`)
      .join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zipSync(files);
}
