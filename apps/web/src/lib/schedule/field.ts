// スマホの「自分の予定」（R-012-27〜29）：自分の予定の並べ方、開始・終了の出し分け、電波のない間のため方。
// 開始・終了は、呼ぶ RPC と引数を送り箱にためる（端末の uuid。二度送っても1回。008・009 と同じ「端末が先」の作り方）。
import type { NewItem, Outbox, OutboxItem } from "../offline";
import type { LatLng } from "../map/geo";
import { sortWorks } from "./format";
import type { WorkRecordRow, WorkRow } from "./types";

export const START_TARGET = "start_work";
export const FINISH_TARGET = "finish_work";

export interface FieldScope {
  tenantId: string;
  membershipId: string;
  deviceId?: string;
}

export interface PendingOps {
  start: OutboxItem | null;
  finish: OutboxItem | null;
}

/** 送り箱にある、その作業の送信待ち（開始・終了） */
export function pendingFor(items: OutboxItem[], workId: string): PendingOps {
  const mine = items.filter((i) => i.kind === "rpc" && i.payload.p_work_id === workId);
  return { start: mine.find((i) => i.target === START_TARGET) ?? null, finish: mine.find((i) => i.target === FINISH_TARGET) ?? null };
}

/** 開始をためる。同じ作業の開始がすでに送信待ちなら、新しくためない（二度押しても1回） */
export async function enqueueStart(box: Outbox, scope: FieldScope, workId: string, now: Date = new Date(), pos?: LatLng | null): Promise<{ item: OutboxItem; duplicate: boolean }> {
  const cur = pendingFor(await box.list(), workId).start;
  if (cur) return { item: cur, duplicate: true };
  const at = now.toISOString();
  const item: NewItem = {
    id: crypto.randomUUID(), // 実績の uuid
    kind: "rpc",
    target: START_TARGET,
    tenantId: scope.tenantId,
    membershipId: scope.membershipId,
    // 位置は、了承して取れたときだけ付ける（013。付けなければ位置なしで記録される）
    payload: { p_work_id: workId, p_started_at: at, p_device_id: scope.deviceId ?? null, p_client_created_at: at, ...(pos ? { p_lat: pos.lat, p_lng: pos.lng } : {}) },
  };
  return { item: await box.enqueue(item), duplicate: false };
}

/** 終了をためる。同じ作業の終了がすでに送信待ちなら、新しくためない。送り箱の印（id）は、開始の uuid とは別 */
export async function enqueueFinish(box: Outbox, scope: FieldScope, workId: string, now: Date = new Date(), pos?: LatLng | null): Promise<{ item: OutboxItem; duplicate: boolean }> {
  const cur = pendingFor(await box.list(), workId).finish;
  if (cur) return { item: cur, duplicate: true };
  const item: NewItem = {
    id: crypto.randomUUID(),
    kind: "rpc",
    target: FINISH_TARGET,
    tenantId: scope.tenantId,
    membershipId: scope.membershipId,
    payload: { p_work_id: workId, p_ended_at: now.toISOString(), ...(pos ? { p_lat: pos.lat, p_lng: pos.lng } : {}) },
  };
  return { item: await box.enqueue(item), duplicate: false };
}

export type FieldAction = "start" | "finish" | null;

export interface FieldState {
  /** 出すボタン（なければ null） */
  action: FieldAction;
  /** 送信待ちがある（端末にためてある） */
  pending: boolean;
  /** 表に出す状況（送信待ちの分を先取りする） */
  status: WorkRow["status"];
}

/**
 * ボタンの出し分け。完了・行わず・取消には出さない。「終了」は、自分が開始した作業（記録が開いている、または開始が送信待ち）にだけ。
 * 送信待ちの開始があれば「作業中」と先に見せ、送信待ちの終了があれば「完了」と先に見せる。
 */
export function fieldState(work: Pick<WorkRow, "id" | "status">, myOpen: WorkRecordRow[], pend: PendingOps): FieldState {
  const pending = !!pend.start || !!pend.finish;
  if (work.status === "done" || work.status === "skipped" || work.status === "cancelled") return { action: null, pending, status: work.status };
  if (pend.finish) return { action: null, pending, status: "done" };
  const hasOpen = myOpen.some((r) => r.work_id === work.id && !r.ended_at) || !!pend.start;
  if (hasOpen) return { action: "finish", pending, status: "in_progress" };
  return { action: "start", pending, status: work.status };
}

/** 自分の予定：取消を除き、日付・時刻の順 */
export function myWorks(works: WorkRow[], myWorkIds: Set<string>): WorkRow[] {
  return sortWorks(works.filter((w) => myWorkIds.has(w.id) && w.status !== "cancelled" && !w.deleted_at));
}

/** 今日の作業と、それ以降に分ける */
export function splitToday(works: WorkRow[], today: string): { today: WorkRow[]; later: WorkRow[] } {
  return { today: works.filter((w) => w.scheduled_date === today), later: works.filter((w) => w.scheduled_date > today) };
}

/** 行った項目を付ける報告書（009）の画面。作業の ID を渡す（R-012-29） */
export function reportHref(workId: string): string {
  return `/reports/edit/?work=${encodeURIComponent(workId)}`;
}
