"use client";

// 売上と粗利の画面に共通の枠（見出し・行き来）と、接続・今の会社・権限の用意
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionMessage, useSession } from "@/components/useSession";
import "@/components/masters/masters.css";
import "@/components/quotes/quotes.css";

export { Field, Loading, Notice } from "@/components/masters/Shell";

export interface ProfitCtx {
  sb: SupabaseClient;
  tenantId: string;
  /** 見せ方のためだけ（判定は DB の RLS が行う）：売上と粗利を見られるか */
  canRead: boolean;
  /** 費用を作る・直す・消す操作を出すか */
  canEdit: boolean;
}

/** 接続と今の会社（ヘッダーで選んでいる会社）と、見る・費用を直す権限があるか */
export function useProfitCtx(): { ctx: ProfitCtx | null; error: string | null } {
  const state = useSession({ redirect: true });
  const ctx = useMemo<ProfitCtx | null>(
    () =>
      state.status === "ready"
        ? {
            sb: state.session.client,
            tenantId: state.session.tenantId,
            canRead: state.session.perms.includes("amount.read"),
            canEdit: state.session.perms.includes("invoice.edit"),
          }
        : null,
    [state],
  );
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { ctx, error };
}

export function ProfitShell({ title, active, children }: { title: string; active: "profit" | "costs"; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav" aria-label="売上と粗利">
        <Link href="/profit/" aria-current={active === "profit" ? "page" : undefined}>
          売上と粗利
        </Link>
        <Link href="/profit/costs/" aria-current={active === "costs" ? "page" : undefined}>
          費用
        </Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}

export const NO_PERMISSION = "売上と粗利を見る権限がありません（管理者・社員だけが見られます）。";
