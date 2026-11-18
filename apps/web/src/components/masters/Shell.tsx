"use client";

// 取引先・建物の画面に共通の枠（見出し・行き来・読み込みと権限のエラー）と、入力の部品
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionMessage, useSession } from "@/components/useSession";
import "./masters.css";

export interface MastersCtx {
  sb: SupabaseClient;
  tenantId: string;
}

/** 接続と今の会社（ヘッダーで選んでいる会社）を用意する。できるまでは null、失敗したら error */
export function useMasters(): { ctx: MastersCtx | null; error: string | null } {
  const state = useSession({ redirect: true });
  const ctx = useMemo<MastersCtx | null>(
    () => (state.status === "ready" ? { sb: state.session.client, tenantId: state.session.tenantId } : null),
    [state],
  );
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { ctx, error };
}

export function Shell({ title, active, children }: { title: string; active: "clients" | "buildings"; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav" aria-label="登録">
        <Link href="/clients/" aria-current={active === "clients" ? "page" : undefined}>
          取引先
        </Link>
        <Link href="/buildings/" aria-current={active === "buildings" ? "page" : undefined}>
          建物
        </Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}

export function Field({ label, error, children, wide }: { label: string; error?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`m-field${wide ? " wide" : ""}`}>
      <label>{label}</label>
      {children}
      {error ? <span className="m-err">{error}</span> : null}
    </div>
  );
}

export function Notice({ text, kind }: { text: string | null; kind?: "ok" }) {
  if (!text) return null;
  return (
    <p className={`m-msg${kind === "ok" ? " ok" : ""}`} role="status">
      {text}
    </p>
  );
}

export function Loading({ error, ctx }: { error: string | null; ctx: MastersCtx | null }) {
  if (error) return <Notice text={error} />;
  if (!ctx) return <p>読み込み中…</p>;
  return null;
}
