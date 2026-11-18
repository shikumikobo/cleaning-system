"use client";

// 地図の画面が使う接続・今の会社・権限。権限の出し分けは見せ方のためだけ（判定は DB の RLS と RPC が行う）。
import { useMemo } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionMessage, useSession } from "@/components/useSession";

export interface MapCtx {
  sb: SupabaseClient;
  tenantId: string;
  /** 位置を直せる（master.edit） */
  canEdit: boolean;
}

export function useMapCtx(): { ctx: MapCtx | null; error: string | null } {
  const state = useSession({ redirect: true });
  const ctx = useMemo<MapCtx | null>(() => {
    if (state.status !== "ready") return null;
    return { sb: state.session.client, tenantId: state.session.tenantId, canEdit: state.session.perms.includes("master.edit") };
  }, [state]);
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { ctx, error };
}
