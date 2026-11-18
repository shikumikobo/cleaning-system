"use client";

// 業務の画面（取引先・建物・小口・お知らせ）が使う「今のログインと会社」。
// 今の会社は、AuthProvider が持つ1つだけ（ヘッダーの会社の切り替えで変わる）。ここはそれを読むだけ。
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useAuth } from "./AuthProvider";

export interface Session {
  client: SupabaseClient;
  userId: string;
  tenantId: string;
  membershipId: string;
  /** 自分の権限の code（画面の出し分け用。判定は DB が行う） */
  perms: string[];
}

export type SessionFailure = "no_client" | "not_signed_in" | "no_membership";

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; session: Session }
  | { status: "failed"; reason: SessionFailure };

export const sessionMessage: Record<SessionFailure, string> = {
  no_client: "接続の設定がありません。",
  not_signed_in: "ログインしてください。",
  no_membership: "この会社の利用者として登録されていません。",
};

/** redirect を true にすると、ログインしていないとき、ログインの画面へ移る（鈴など、画面の外枠は false） */
export function useSession(opts: { redirect?: boolean } = {}): SessionState {
  const auth = useAuth();
  const router = useRouter();
  const redirect = opts.redirect ?? false;
  useEffect(() => {
    if (redirect && auth.status === "anon") router.replace("/login/");
  }, [redirect, auth.status, router]);

  const { status, client, userId, current, perms } = auth;
  return useMemo<SessionState>(() => {
    if (status === "noconfig" || !client) return { status: "failed", reason: "no_client" };
    if (status === "anon") return { status: "failed", reason: "not_signed_in" };
    if (status !== "ready" || !userId) return { status: "loading" };
    if (!current) return { status: "failed", reason: "no_membership" };
    if (!perms) return { status: "loading" };
    return { status: "ready", session: { client, userId, tenantId: current.tenantId, membershipId: current.id, perms } };
  }, [status, client, userId, current, perms]);
}
