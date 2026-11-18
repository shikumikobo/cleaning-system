"use client";

// 画面から記録を送り箱にためるときの入口。今の会社と所属（membership_id）が自動で付く。
import { useMemo } from "react";
import { useAuth } from "./AuthProvider";
import { useOutbox } from "./SyncProvider";
import { createMemberEnqueue, type MemberEnqueue } from "@/lib/offline/membership";

export function useMemberEnqueue(): MemberEnqueue {
  const box = useOutbox();
  const { current } = useAuth();
  return useMemo(() => {
    if (!box) return async () => Promise.reject(new Error("送り箱が開いていません"));
    return createMemberEnqueue(box, current ? { tenantId: current.tenantId, membershipId: current.id } : null);
  }, [box, current]);
}
