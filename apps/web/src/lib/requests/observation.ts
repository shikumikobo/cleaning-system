// 現場の気づきから案件を作る：電波のない間は、呼ぶ RPC と引数を端末（送り箱）にためる。
// 同じ uuid（p_id）の二度目は、DB が何もせず前の結果を返す（R-003-15）ので、二度送っても1件。
import type { NewItem, Outbox, OutboxItem } from "../offline";

export interface ObservationDraft {
  /** 端末で作った uuid。省くと作る */
  id?: string;
  building_id: string;
  title: string;
  detail?: string;
  room_id?: string;
  category?: string;
}

export function enqueueObservation(
  box: Outbox,
  scope: { tenantId: string; membershipId: string },
  d: ObservationDraft,
): Promise<OutboxItem> {
  const item: NewItem = {
    id: d.id,
    kind: "rpc",
    target: "create_request_from_observation",
    tenantId: scope.tenantId,
    membershipId: scope.membershipId,
    payload: {
      p_building_id: d.building_id,
      p_title: d.title.trim(),
      p_detail: d.detail?.trim() ? d.detail.trim() : null,
      p_room_id: d.room_id || null,
      p_category: d.category || "other",
    },
  };
  return box.enqueue(item);
}
