// 合計の計算。DB（提出の RPC）と同じ答えになるように、整数（BigInt）だけで計算する（R-004-9・29）。
//  - 明細の金額：数量（小数 2 桁）× 単価を、円未満で四捨五入（正の数なので 0.5 は切り上げ）
//  - 税：小計 × 税率（小数 4 桁）を帳票ごとに1回、円未満切り捨て
export interface LineInput {
  qty: number | string;
  unit_price: number | string;
}

export interface Totals {
  subtotal: number;
  tax: number;
  total: number;
  /** 明細ごとの金額（入力と同じ並び） */
  amounts: number[];
}

/** 数量の文字列を 100 倍の整数にする。小数は 2 桁まで・0 以上の数だけ。形が違えば null */
export function parseQty(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

function qtyHundredths(qty: number | string): bigint {
  if (typeof qty === "number") return BigInt(Math.round(qty * 100));
  const p = parseQty(qty);
  if (p === null) throw new Error(`数量の形が違います：${qty}`);
  return BigInt(p);
}

function price(v: number | string): bigint {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) throw new Error(`単価は整数にしてください：${v}`);
  return BigInt(n);
}

function amountBig(qty: number | string, unitPrice: number | string): bigint {
  return (qtyHundredths(qty) * price(unitPrice) + 50n) / 100n;
}

export function lineAmount(qty: number | string, unitPrice: number | string): number {
  return Number(amountBig(qty, unitPrice));
}

/** 税率（0.1 など）を 1 万分の 1 の整数にする */
export function rateBp(rate: number): number {
  return Math.round(rate * 10000);
}

export function calcQuote(lines: LineInput[], taxRate: number): Totals {
  const amounts = lines.map((l) => amountBig(l.qty, l.unit_price));
  const sub = amounts.reduce((a, b) => a + b, 0n);
  const tax = (sub * BigInt(rateBp(taxRate))) / 10000n;
  return { subtotal: Number(sub), tax: Number(tax), total: Number(sub + tax), amounts: amounts.map(Number) };
}
