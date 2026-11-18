"use client";

// お知らせの画面が使う「今のログインと会社」。今の会社は 001 の AuthProvider の1つだけ（useSession）。
import { useMemo } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useSession, type SessionFailure } from "@/components/useSession";
import { createNotificationsApi, type NotificationsApi } from "./api";

export interface NotificationSession {
  client: SupabaseClient;
  tenantId: string;
  membershipId: string;
  /** 自分の権限の code（種類の出し分け用。判定は DB が行う） */
  perms: string[];
}

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; session: NotificationSession; api: NotificationsApi }
  | { status: "failed"; reason: SessionFailure };

/** redirect を true にすると、ログインしていないとき、ログインの画面へ移る（鈴は false） */
export function useNotificationSession(opts: { redirect?: boolean } = {}): SessionState {
  const state = useSession({ redirect: opts.redirect });
  return useMemo<SessionState>(() => {
    if (state.status !== "ready") return state;
    const { client, tenantId, membershipId, perms } = state.session;
    return { status: "ready", session: { client, tenantId, membershipId, perms }, api: createNotificationsApi(client) };
  }, [state]);
}
