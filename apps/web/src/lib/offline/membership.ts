// 送り箱に、今の会社と所属（membership_id）を付けてためる。
// 付けておくと、断られたときの端末のエラー（R-001-33）が、だれの端末かつどの会社かを持つ。
import type { NewItem, Outbox, OutboxItem } from "./outbox";

export interface MemberScope {
  tenantId: string;
  membershipId: string;
}

export type MemberEnqueue = (item: Omit<NewItem, "tenantId" | "membershipId">) => Promise<OutboxItem>;

export function createMemberEnqueue(box: Outbox, scope: MemberScope | null): MemberEnqueue {
  return async (item) => {
    if (!scope) throw new Error("会社が選べていないので、記録をためられません");
    return box.enqueue({ ...item, tenantId: scope.tenantId, membershipId: scope.membershipId });
  };
}
