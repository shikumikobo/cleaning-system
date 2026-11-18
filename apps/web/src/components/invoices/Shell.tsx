"use client";

// 請求の画面に共通の枠（見出し・行き来）と、接続・今の会社・権限の用意
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionMessage, useSession } from "@/components/useSession";
import "@/components/masters/masters.css";
import "@/components/quotes/quotes.css";

export { Field, Loading, Notice } from "@/components/masters/Shell";

export interface InvoiceCtx {
  sb: SupabaseClient;
  tenantId: string;
  /** 見せ方のためだけ（判定は DB の RLS と RPC が行う） */
  canEdit: boolean;
}

/** 接続と今の会社（ヘッダーで選んでいる会社）と、請求を直せる権限があるか */
export function useInvoiceCtx(): { ctx: InvoiceCtx | null; error: string | null } {
  const state = useSession({ redirect: true });
  const ctx = useMemo<InvoiceCtx | null>(
    () =>
      state.status === "ready"
        ? { sb: state.session.client, tenantId: state.session.tenantId, canEdit: state.session.perms.includes("invoice.edit") }
        : null,
    [state],
  );
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { ctx, error };
}

export function InvoiceShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav q-noprint" aria-label="請求">
        <Link href="/invoices/" aria-current="page">
          請求
        </Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}

/** ボタンの見た目のリンク */
export const linkBtn = { textDecoration: "none", display: "inline-flex", alignItems: "center" } as const;
