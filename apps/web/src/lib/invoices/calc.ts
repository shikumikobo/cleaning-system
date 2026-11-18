// 請求書の合計の計算。DB（発行の RPC）と同じ答えになるように、見積と同じ整数（BigInt）の計算を使う（R-011-15・32）。
//  - 明細の金額：数量（小数 2 桁）× 単価を、円未満で四捨五入
//  - 税：小計 × 税率を、請求書1枚に1回、円未満切り捨て
import { calcQuote, type LineInput, type Totals } from "../quotes/calc";

export type { LineInput, Totals };

export function calcInvoice(lines: LineInput[], taxRate: number): Totals {
  return calcQuote(lines, taxRate);
}
