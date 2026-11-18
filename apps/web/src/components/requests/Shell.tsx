"use client";

// 案件の画面に共通の枠（見出し・行き来・読み込みのエラー）と、今の会社・権限の読み取り。
// 今の会社と権限は、001 の AuthProvider から useSession 経由で読む（新しい仕組みは作らない）。
import Link from "next/link";
import type { ReactNode } from "react";
import { sessionMessage, useSession, type Session } from "@/components/useSession";
import { Notice } from "@/components/masters/Shell";
import { canEditRequests } from "@/lib/requests/format";
import "@/components/masters/masters.css";
import "./requests.css";

export { Field, Notice } from "@/components/masters/Shell";

export function useRequestsSession(): { session: Session | null; error: string | null; editor: boolean } {
  const state = useSession({ redirect: true });
  const session = state.status === "ready" ? state.session : null;
  const error = state.status === "failed" ? sessionMessage[state.reason] : null;
  return { session, error, editor: session ? canEditRequests(session.perms) : false };
}

export function RequestsShell({ title, active, children }: { title: string; active: "list" | "new"; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav" aria-label="案件">
        <Link href="/requests/" aria-current={active === "list" ? "page" : undefined}>
          案件の一覧
        </Link>
        <Link href="/requests/new/" aria-current={active === "new" ? "page" : undefined}>
          登録
        </Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}

export function Loading({ error, session }: { error: string | null; session: Session | null }) {
  if (error) return <Notice text={error} />;
  if (!session) return <p>読み込み中…</p>;
  return null;
}
