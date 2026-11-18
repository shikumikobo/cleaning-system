// 期限の警告の判定（R-003-23）。DB の定時の処理（request_due_notify）と同じ決まり：
//   期限（日本時間の日付）が今日より前 → 期限切れ、今日から N 日後まで（今日を含む）→ 期限が近い
//   受付・対応中の案件だけ。完了・取消・期限なしは警告しない。
import type { RequestStatus } from "./types";

export const DUE_SOON_DAYS = 3;
export type DueState = "overdue" | "soon" | "later" | "none";

/** いまの日本時間の日付（YYYY-MM-DD） */
export function todayJst(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

const ymdToDays = (s: string): number => {
  const [y, m, d] = s.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** 期限まであと何日（今日が 0、過ぎていれば負）。期限がなければ null */
export function daysUntil(due: string | null, today: string): number | null {
  if (!due) return null;
  return ymdToDays(due) - ymdToDays(today);
}

export function isOpenStatus(status: RequestStatus): boolean {
  return status === "new" || status === "in_progress";
}

export function dueState(
  r: { due_date: string | null; status: RequestStatus },
  today: string,
  soonDays: number = DUE_SOON_DAYS,
): DueState {
  if (!r.due_date || !isOpenStatus(r.status)) return "none";
  const n = daysUntil(r.due_date, today)!;
  if (n < 0) return "overdue";
  if (n <= soonDays) return "soon";
  return "later";
}

export function dueLabel(r: { due_date: string | null; status: RequestStatus }, today: string): string {
  const st = dueState(r, today);
  if (st === "none") return r.due_date ? r.due_date.replaceAll("-", "/") : "期限なし";
  const n = daysUntil(r.due_date, today)!;
  if (st === "overdue") return `期限切れ（${-n}日過ぎ）`;
  if (n === 0) return "今日が期限";
  return st === "soon" ? `期限が近い（あと${n}日）` : `${r.due_date!.replaceAll("-", "/")}`;
}
