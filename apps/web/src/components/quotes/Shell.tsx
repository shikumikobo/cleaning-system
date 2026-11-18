"use client";

// 見積の画面に共通の枠（見出し・行き来）と、接続・今の会社・権限の用意
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionMessage, useSession } from "@/components/useSession";
import "@/components/masters/masters.css";
import "./quotes.css";

export { Field, Loading, Notice } from "@/components/masters/Shell";

export interface QuoteCtx {
  sb: SupabaseClient;
  tenantId: string;
  /** 見せ方のためだけ（判定は DB の RLS と RPC が行う） */
  canEdit: boolean;
}

/** 接続と今の会社（ヘッダーで選んでいる会社）と、見積を直せる権限があるか */
export function useQuoteCtx(): { ctx: QuoteCtx | null; error: string | null } {
  const state = useSession({ redirect: true });
  const ctx = useMemo<QuoteCtx | null>(
    () =>
      state.status === "ready"
        ? { sb: state.session.client, tenantId: state.session.tenantId, canEdit: state.session.perms.includes("quote.edit") }
        : null,
    [state],
  );
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { ctx, error };
}

export function QuoteShell({ title, active, children }: { title: string; active: "quotes" | "items"; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav q-noprint" aria-label="見積">
        <Link href="/quotes/" aria-current={active === "quotes" ? "page" : undefined}>
          見積
        </Link>
        <Link href="/quotes/items/" aria-current={active === "items" ? "page" : undefined}>
          品名の候補
        </Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
