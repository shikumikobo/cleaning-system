// レシートの読み取り（機能 006）。Deno にも Node にも依存しない、解析と差し替えの口だけ。
// 読み取りの方法（外の OCR など）は ReceiptReader として差し替える。初めは「読み取らない」（manualReader）。
// 読み取りの結果は金額と日付の「候補」。出入りの金額に入れるのは、画面で持ち手が確かめた値だけ（R-006-25）。

export interface ReceiptReading {
  amount: number | null;
  /** YYYY-MM-DD */
  date: string | null;
}

export interface ReceiptReader {
  name: string;
  /** 画像から金額と日付を取る。取れなければ null */
  read(image: Uint8Array, mime: string): Promise<ReceiptReading | null>;
}

export interface ReadOutcome {
  /** read：金額が読めた。failed：読めなかった（手で入れる画面に進める） */
  status: "read" | "failed";
  amount: number | null;
  date: string | null;
  reader: string;
}

/** 初めの読み取り：読み取らない。手で入れる画面に進める */
export const manualReader: ReceiptReader = {
  name: "manual",
  async read() {
    return null;
  },
};

/** 画像から「文字」を返す方法（OCR など）を、読み取りの形に包む。どのサービスを使うかは、渡す側が決める */
export function textReader(name: string, extractText: (image: Uint8Array, mime: string) => Promise<string>): ReceiptReader {
  return {
    name,
    async read(image, mime) {
      return parseReceiptText(await extractText(image, mime));
    },
  };
}

/** 読み取りを実行する。例外は失敗として返し、画面を止めない（R-006-26） */
export async function runReader(reader: ReceiptReader, image: Uint8Array, mime: string): Promise<ReadOutcome> {
  try {
    const r = await reader.read(image, mime);
    const amount = r?.amount ?? null;
    const date = r?.date ?? null;
    return { status: amount !== null ? "read" : "failed", amount, date, reader: reader.name };
  } catch {
    return { status: "failed", amount: null, date: null, reader: reader.name };
  }
}

const DATE_RE = /(20\d{2})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?/g;
const TIME_RE = /\d{1,2}\s*:\s*\d{2}(?::\d{2})?/g;
const TOTAL_LINE = /合計|総計|お会計|ご請求|税込|total/i;
const NOT_AMOUNT_LINE = /お預|預り|預かり|お釣|釣|ポイント|現金|tel|電話|登録番号|no\./i;
const MAX_AMOUNT = 9_999_999;

function validDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function findDate(text: string): string | null {
  for (const m of text.matchAll(DATE_RE)) {
    const d = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) return d;
  }
  return null;
}

/** 行から、金額らしい数を取る（円・¥ が付くか、カンマ区切り、または合計の行の数） */
function amountsIn(line: string, loose: boolean): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(/¥\s*(\d{1,3}(?:,\d{3})+|\d+)|(\d{1,3}(?:,\d{3})+|\d+)\s*円|(\d{1,3}(?:,\d{3})+|\d+)/g)) {
    const raw = m[1] ?? m[2] ?? m[3];
    const marked = m[1] !== undefined || m[2] !== undefined;
    if (!marked && !loose && !raw.includes(",")) continue;
    const n = Number(raw.replace(/,/g, ""));
    if (Number.isInteger(n) && n > 0 && n <= MAX_AMOUNT) out.push(n);
  }
  return out;
}

/** 文字から、金額と日付の候補を取る。合計の行を優先し、なければいちばん大きい円の金額 */
export function parseReceiptText(raw: string): ReceiptReading {
  const text = raw.normalize("NFKC").replace(/￥/g, "¥");
  const date = findDate(text);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(DATE_RE, " ").replace(TIME_RE, " "));

  const totals: number[] = [];
  for (const line of lines) {
    if (!TOTAL_LINE.test(line) || NOT_AMOUNT_LINE.test(line)) continue;
    const found = amountsIn(line, true);
    if (found.length) totals.push(found[found.length - 1]);
  }
  if (totals.length) return { amount: Math.max(...totals), date };

  const others: number[] = [];
  for (const line of lines) {
    if (NOT_AMOUNT_LINE.test(line)) continue;
    others.push(...amountsIn(line, false));
  }
  return { amount: others.length ? Math.max(...others) : null, date };
}
