// 出入りの入力の確かめ・残高の見せ方・操作の出し分け（R-006-34〜36）
export type Direction = "in" | "out";

export interface EntryInput {
  accountId: string;
  date: string;
  amount: string | number;
  purpose: string;
  direction: Direction;
}

export interface EntryValue {
  accountId: string;
  date: string;
  amount: number;
  purpose: string;
  direction: Direction;
}

export type EntryCheck = { ok: true; value: EntryValue } | { ok: false; errors: Partial<Record<keyof EntryInput, string>> };

function validYmd(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** 「1,980」「１２００円」などを整数にする。整数でなければ null */
export function parseYen(v: string | number): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  const s = v.normalize("NFKC").replace(/[,\s¥円]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** 送る前の確かめ。持ち手の画面は出金だけ（allowIn が false） */
export function validateEntryInput(input: EntryInput, opts: { allowIn?: boolean } = {}): EntryCheck {
  const errors: Partial<Record<keyof EntryInput, string>> = {};
  const amount = parseYen(input.amount);
  if (amount === null || amount < 1) errors.amount = "金額は1円以上の整数で入れてください";
  if (input.purpose.trim() === "") errors.purpose = "用途を入れてください";
  if (!validYmd(input.date)) errors.date = "日付を入れてください";
  if (!input.accountId) errors.accountId = "小口を選んでください";
  if (input.direction === "in" && !opts.allowIn) errors.direction = "入金は、現金を渡す人の画面で登録します";
  if (Object.keys(errors).length || amount === null) return { ok: false, errors };
  return {
    ok: true,
    value: { accountId: input.accountId, date: input.date, amount, purpose: input.purpose.trim(), direction: input.direction },
  };
}

export const yen = (n: number): string => (n < 0 ? "-" : "") + "¥" + Math.abs(n).toLocaleString("en-US");

export interface BalanceRow {
  balance: number;
  confirmed_balance: number;
  draft_count: number;
}

export function summarizeAccount(row: BalanceRow, pending: number) {
  return {
    balanceText: yen(row.balance),
    confirmedText: yen(row.confirmed_balance),
    draftCount: row.draft_count,
    pendingText: pending > 0 ? `送れていない記録が ${pending} 件あります` : null,
    warning: row.balance < 0 ? "残高がマイナスです。入金の登録が漏れていないか確かめてください" : null,
  };
}

/** 管理の操作の出し分け（見せ方だけ。権限は DB が守る） */
export function screenActions(perms: readonly string[]) {
  const manage = perms.includes("cash.manage");
  return { confirm: manage, closeMonth: manage, grant: manage, exportCsv: manage, manage };
}
