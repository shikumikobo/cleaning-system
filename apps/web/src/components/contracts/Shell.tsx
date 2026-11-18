"use client";

// 契約の画面に共通の枠（見出し・行き来）と、接続・今の会社・権限の用意
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionMessage, useSession } from "@/components/useSession";
import "@/components/masters/masters.css";
import "@/components/quotes/quotes.css";

export { Field, Loading, Notice } from "@/components/masters/Shell";

export interface ContractCtx {
  sb: SupabaseClient;
  tenantId: string;
  /** 見せ方のためだけ（判定は DB の RLS と RPC が行う） */
  canEdit: boolean;
}

export function useContractCtx(): { ctx: ContractCtx | null; error: string | null } {
  const state = useSession({ redirect: true });
  const ctx = useMemo<ContractCtx | null>(
    () =>
      state.status === "ready"
        ? { sb: state.session.client, tenantId: state.session.tenantId, canEdit: state.session.perms.includes("contract.edit") }
        : null,
    [state],
  );
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { ctx, error };
}

export function ContractShell({ title, active, children }: { title: string; active: "contracts" | "works"; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav" aria-label="契約">
        <Link href="/contracts/" aria-current={active === "contracts" ? "page" : undefined}>
          契約
        </Link>
        <Link href="/contracts/works/" aria-current={active === "works" ? "page" : undefined}>
          予定
        </Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
