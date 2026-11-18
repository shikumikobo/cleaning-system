// ひな形のファイル（R-014-1）。CSV は Excel で開ける UTF-8（BOM つき）、Excel は種類の名前のシート1つ。
import { columnsOf, EXAMPLES, kindLabel, type Kind } from "./columns";
import { toCsv } from "./csv";
import { buildXlsx } from "./xlsx";

/** 見出しと例の行 */
export function templateMatrix(kind: Kind): string[][] {
  return [columnsOf(kind).map((c) => c.label), ...EXAMPLES[kind]];
}

export const templateCsv = (kind: Kind): string => toCsv(templateMatrix(kind));
export const templateXlsx = (kind: Kind): Uint8Array => buildXlsx([{ name: kindLabel(kind), rows: templateMatrix(kind) }]);
export const templateFileName = (kind: Kind, ext: "csv" | "xlsx"): string => `ひな形_${kindLabel(kind)}.${ext}`;
