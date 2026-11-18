// 画面の部品：ラベル・絞り込み・並び・状況の操作の出し分け・文面（R-003-27・29）
import { dueState, daysUntil, isOpenStatus, todayJst, type DueState } from "./due";
import type { RequestCategory, RequestRow, RequestSource, RequestStatus, StatusResult } from "./types";

export const STATUS_LABEL: Record<RequestStatus, string> = { new: "受付", in_progress: "対応中", done: "完了", cancelled: "取消" };
export const CATEGORY_LABEL: Record<RequestCategory, string> = {
  cleaning: "清掃",
  repair: "修繕",
  complaint: "苦情",
  inquiry: "問い合わせ",
  other: "その他",
};
export const SOURCE_LABEL: Record<RequestSource, string> = { manual: "手で登録", phone: "電話", email: "メール", field: "現場の気づき", import: "取り込み" };
export const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }));
export const SOURCE_OPTIONS = (["manual", "phone", "email"] as const).map((value) => ({ value, label: SOURCE_LABEL[value] }));

// ---- 状況の操作の出し分け（DB の set_request_status と同じ決まり。出さなくても DB が断る） ----
const EDITOR_NEXT: Record<RequestStatus, RequestStatus[]> = {
  new: ["in_progress", "done", "cancelled"],
  in_progress: ["new", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["new"],
};
const STAFF_NEXT: Record<RequestStatus, RequestStatus[]> = {
  new: ["in_progress", "done"],
  in_progress: ["done"],
  done: [],
  cancelled: [],
};

/** 画面に出す状況の切り替え。editor は request.edit を持つ人。それ以外は担当のスタッフ（field.record） */
export function nextStatuses(from: RequestStatus, who: { editor: boolean; assignee: boolean }): RequestStatus[] {
  if (who.editor) return EDITOR_NEXT[from];
  if (who.assignee) return STAFF_NEXT[from];
  return [];
}

/** 状況の切り替えの結果を、利用者に見せる日本語にする */
export function statusMessage(r: StatusResult): string {
  if (r.ok) return r.changed === false ? "すでにその状況です" : `状況を「${STATUS_LABEL[r.status as RequestStatus]}」にしました`;
  switch (r.reason) {
    case "billed":
      return "請求書に載った金額があるので、取消にできません";
    case "forbidden_transition":
      return "この切り替えは、管理者・社員だけができます";
    default:
      return `「${STATUS_LABEL[r.from as RequestStatus]}」から「${STATUS_LABEL[r.to as RequestStatus]}」には変えられません`;
  }
}

/** 金額の欄と操作を出すか。DB は別に拒否する */
export function canSeeAmount(perms: string[]): boolean {
  return perms.includes("amount.read");
}
export function canEditRequests(perms: string[]): boolean {
  return perms.includes("request.edit");
}

// ---- 絞り込みと並び ----
export type DueFilter = "" | "overdue" | "soon" | "week" | "none";

export interface RequestFilters {
  /** 状況。空なら、終わっていないもの（受付・対応中）だけ */
  status?: RequestStatus | "all" | "";
  due?: DueFilter;
  building_id?: string;
  /** 担当の所属の ID。"none" なら担当なし */
  assignee_id?: string;
}

export function filterRequests(items: RequestRow[], f: RequestFilters, today: string = todayJst()): RequestRow[] {
  return items.filter((r) => {
    if (!f.status) {
      if (!isOpenStatus(r.status)) return false;
    } else if (f.status !== "all" && r.status !== f.status) return false;
    if (f.building_id && r.building_id !== f.building_id) return false;
    if (f.assignee_id) {
      if (f.assignee_id === "none" ? r.assignee_id !== null : r.assignee_id !== f.assignee_id) return false;
    }
    switch (f.due) {
      case "overdue":
        return dueState(r, today) === "overdue";
      case "soon":
        return dueState(r, today) === "soon";
      case "week": {
        const n = daysUntil(r.due_date, today);
        return n !== null && n >= 0 && n <= 7;
      }
      case "none":
        return r.due_date === null;
      default:
        return true;
    }
  });
}

const DUE_RANK: Record<DueState, number> = { overdue: 0, soon: 1, later: 2, none: 3 };

/** 期限切れ → 期限が近い → 期限が遠い → 期限なし。同じ中では期限の早い順、次に新しい順 */
export function sortRequests(items: RequestRow[], today: string = todayJst()): RequestRow[] {
  return [...items].sort((a, b) => {
    const ra = DUE_RANK[dueState(a, today)];
    const rb = DUE_RANK[dueState(b, today)];
    if (ra !== rb) return ra - rb;
    if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  });
}
