"use client";

// 予定と実績の画面に共通の枠（見出し・行き来）と、接続・今の会社・権限の用意（R-012-34）
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionMessage, useSession } from "@/components/useSession";
import { scheduleAccess } from "@/lib/schedule/format";
import "@/components/masters/masters.css";
import "./schedule.css";

export { Field, Loading, Notice } from "@/components/masters/Shell";

export interface ScheduleCtx {
  sb: SupabaseClient;
  tenantId: string;
  membershipId: string;
  /** 見せ方のためだけ（判定は DB の RLS と RPC が行う） */
  manage: boolean;
  mine: boolean;
}

export function useScheduleCtx(): { ctx: ScheduleCtx | null; error: string | null } {
  const state = useSession({ redirect: true });
  const ctx = useMemo<ScheduleCtx | null>(() => {
    if (state.status !== "ready") return null;
    const a = scheduleAccess(state.session.perms);
    return { sb: state.session.client, tenantId: state.session.tenantId, membershipId: state.session.membershipId, manage: a.manage, mine: a.mine };
  }, [state]);
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { ctx, error };
}

type Tab = "mine" | "calendar" | "new" | "review";

export function ScheduleShell({ title, active, manage, children }: { title: string; active: Tab; manage: boolean; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav" aria-label="予定と実績">
        <Link href="/schedule/mine/" aria-current={active === "mine" ? "page" : undefined}>
          自分の予定
        </Link>
        {manage ? (
          <>
            <Link href="/schedule/" aria-current={active === "calendar" ? "page" : undefined}>
              予定表
            </Link>
            <Link href="/schedule/new/" aria-current={active === "new" ? "page" : undefined}>
              作業を足す
            </Link>
            <Link href="/schedule/review/" aria-current={active === "review" ? "page" : undefined}>
              予実
            </Link>
          </>
        ) : null}
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
