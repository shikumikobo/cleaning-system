"use client";

// 報告書の画面に共通の枠（見出し・行き来）と、接続・今の会社・権限の用意
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionMessage, useSession } from "@/components/useSession";
import "@/components/masters/masters.css";
import "./reports.css";

export { Field, Loading, Notice } from "@/components/masters/Shell";

export interface ReportCtx {
  sb: SupabaseClient;
  tenantId: string;
  membershipId: string;
  /** 見せ方のためだけ（判定は DB の RLS と RPC が行う） */
  canAssign: boolean;
  canMaster: boolean;
  canRecord: boolean;
}

export function useReportCtx(): { ctx: ReportCtx | null; error: string | null } {
  const state = useSession({ redirect: true });
  const ctx = useMemo<ReportCtx | null>(
    () =>
      state.status === "ready"
        ? {
            sb: state.session.client,
            tenantId: state.session.tenantId,
            membershipId: state.session.membershipId,
            canAssign: state.session.perms.includes("work.assign"),
            canMaster: state.session.perms.includes("master.edit"),
            canRecord: state.session.perms.includes("field.record"),
          }
        : null,
    [state],
  );
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { ctx, error };
}

export function ReportShell({ title, active, children }: { title: string; active: "reports" | "templates" | "other"; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav r-noprint" aria-label="清掃報告書">
        <Link href="/reports/" aria-current={active === "reports" ? "page" : undefined}>
          報告書
        </Link>
        <Link href="/reports/templates/" aria-current={active === "templates" ? "page" : undefined}>
          ひな形
        </Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
