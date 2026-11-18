// 画面の部品：ラベル・時刻・理由の文面・予実の判定・月ごとの集計（R-012-27〜34）
import { timeLabel, timeRange, workStatusLabel } from "../contracts/format";
import type { MonthlyRow, PlanActualRow, WorkRow } from "./types";

export { timeLabel, timeRange, workStatusLabel };

/** 時刻のずれを「ずれ」として出す分（R-012-33） */
export const GAP_MINUTES = 30;

const REPORT_STATUS: Record<string, string> = { none: "報告書なし", draft: "下書き", checked: "確認済み", submitted: "提出済み" };
export const reportStatusText = (s: string) => REPORT_STATUS[s] ?? s;

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
/** 2026-11-17 → 11/17（火） */
export function dayLabel(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const wd = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${Number(m[2])}/${Number(m[3])}（${WEEKDAY[wd]}）`;
}

/** 分 → 1時間30分 */
export function minutesLabel(n: number): string {
  if (!n) return "0分";
  const h = Math.floor(Math.abs(n) / 60);
  const m = Math.abs(n) % 60;
  return `${n < 0 ? "-" : ""}${h > 0 ? `${h}時間` : ""}${m > 0 || h === 0 ? `${m}分` : ""}`;
}

/** ずれ（分）→ 「開始が20分遅れ」「終了が10分早め」。空なら空 */
export function gapLabel(kind: "start" | "end", min: number | null): string {
  if (min === null || min === undefined) return "";
  const what = kind === "start" ? "開始" : "終了";
  if (min === 0) return `${what}は予定どおり`;
  return `${what}が${Math.abs(min)}分${min > 0 ? "遅れ" : "早め"}`;
}

const ACTION_TEXT: Record<string, string> = {
  not_startable: "完了・行わず・取消の作業は、開始できません",
  already_started: "すでに開始しています",
  not_started: "開始していないので、終了できません",
  end_before_start: "終了の時刻は、開始より後にしてください",
  not_scheduled: "予定の作業だけ、この操作ができます（開始した作業は変えられません）",
  conflict: "ほかの人が直しています。読み込み直しました。もう一度確かめてから操作してください",
  invoiced: "請求書に載っている金額があるので、取り消せません",
  invalid_time: "終了の時刻は、開始より後にしてください",
  date_required: "日付を入れてください",
  duplicate_date: "動かした先の日に、同じ中身の作業がすでにあります",
  source_required: "契約の中身か案件のどちらか1つを選んでください",
  contract_ended: "終わった契約の中身には、作業を足せません",
  out_of_contract: "契約の期間の外の日付です",
  request_closed: "完了・取消の案件には、作業を足せません",
  invalid_member: "担当にできない人です（社内の人だけ選べます）",
  not_assigned: "外す人は、この作業の担当ではありません",
  already_assigned: "付ける人は、すでにこの作業の担当です",
  work_closed: "完了・行わず・取消の作業では、担当を変えられません",
  has_record: "外す人は、すでに開始・終了を記録しているので、入れ替えられません",
};

/** RPC が断った理由（reason）を、利用者に見せる日本語にする */
export function workActionMessage(reason: string | undefined): string {
  if (!reason) return "できませんでした";
  return ACTION_TEXT[reason] ?? `できませんでした（${reason}）`;
}

/** 予実の行が持つ印（R-012-19〜22・33）。時刻のずれは GAP_MINUTES 以上 */
export type ReviewFlag = "not_done" | "unfinished" | "time_gap" | "items_skipped" | "report_missing";
export const REVIEW_LABEL: Record<ReviewFlag, string> = {
  not_done: "行っていない作業",
  unfinished: "終わっていない作業",
  time_gap: "時刻のずれ",
  items_skipped: "行わなかった項目",
  report_missing: "出ていない報告書",
};

export function reviewFlags(r: PlanActualRow): ReviewFlag[] {
  const f: ReviewFlag[] = [];
  if (r.not_done) f.push("not_done");
  if (r.unfinished) f.push("unfinished");
  if ((r.start_gap_min !== null && Math.abs(r.start_gap_min) >= GAP_MINUTES) || (r.end_gap_min !== null && Math.abs(r.end_gap_min) >= GAP_MINUTES)) f.push("time_gap");
  if (r.items_skipped > 0) f.push("items_skipped");
  if (r.report_missing) f.push("report_missing");
  return f;
}

/** 種類で絞る（空なら、印のあるものだけ）。日付・時刻の順 */
export function filterReview(rows: PlanActualRow[], flag: ReviewFlag | ""): PlanActualRow[] {
  return rows
    .filter((r) => {
      const f = reviewFlags(r);
      return flag ? f.includes(flag) : f.length > 0;
    })
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || (a.start_time ?? "").localeCompare(b.start_time ?? ""));
}

export function countReview(rows: PlanActualRow[]): Record<ReviewFlag, number> {
  const c: Record<ReviewFlag, number> = { not_done: 0, unfinished: 0, time_gap: 0, items_skipped: 0, report_missing: 0 };
  for (const r of rows) for (const f of reviewFlags(r)) c[f]++;
  return c;
}

/** 月ごとの集計の全体（建物ごとの行を足し合わせる） */
export function sumMonthly(rows: MonthlyRow[]): Omit<MonthlyRow, "tenant_id" | "month" | "building_id"> {
  const t = { planned: 0, done: 0, skipped: 0, cancelled: 0, not_done: 0, report_missing: 0, planned_minutes: 0, actual_minutes: 0 };
  for (const r of rows) {
    t.planned += r.planned;
    t.done += r.done;
    t.skipped += r.skipped;
    t.cancelled += r.cancelled;
    t.not_done += r.not_done;
    t.report_missing += r.report_missing;
    t.planned_minutes += r.planned_minutes;
    t.actual_minutes += r.actual_minutes;
  }
  return t;
}

/** 作業の並び：日付・時刻の順（時刻のないものは後ろ） */
export function sortWorks<T extends Pick<WorkRow, "scheduled_date" | "start_time" | "title">>(works: T[]): T[] {
  return [...works].sort(
    (a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || (a.start_time ?? "99").localeCompare(b.start_time ?? "99") || a.title.localeCompare(b.title),
  );
}

/** 作業を足す入力の検査（R-012-32）。問題があれば理由を返す */
export function validateNewWork(i: { source: "service" | "request"; serviceId: string; requestId: string; date: string; start: string; end: string }): string | null {
  if (i.source === "service" && !i.serviceId) return "契約の中身を選んでください";
  if (i.source === "request" && !i.requestId) return "案件を選んでください";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date)) return "日付を入れてください";
  if (i.start && i.end && i.end <= i.start) return "終了の時刻は、開始より後にしてください";
  return null;
}

/** 日付・時刻の変更の入力の検査（R-012-31） */
export function validateReschedule(i: { date: string; start: string; end: string }): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date)) return "日付を入れてください";
  if (i.start && i.end && i.end <= i.start) return "終了の時刻は、開始より後にしてください";
  return null;
}

/** 出し分け（R-012-34）。見せ方のためだけで、判定は DB が行う。予定表・操作・作業を足す・予実は work.assign、自分の予定は field.record かそれ */
export function scheduleAccess(perms: string[]): { manage: boolean; mine: boolean } {
  const manage = perms.includes("work.assign");
  return { manage, mine: manage || perms.includes("field.record") };
}
