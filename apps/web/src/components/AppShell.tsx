"use client";

// 全画面の外側：ログインの状態・送り直し・ヘッダー（会社の切り替え、送れていない件数）。
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { AuthProvider, useAuth } from "./AuthProvider";
import { NavBoard } from "./NavBoard";
import { NotificationBell } from "./NotificationBell";
import { PendingBadge } from "./PendingBadge";
import { SyncProvider } from "./SyncProvider";
import { createSupabaseSender, type SupabaseLike } from "@/lib/offline";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <Inner>{children}</Inner>
    </AuthProvider>
  );
}

function Inner({ children }: { children: ReactNode }) {
  const auth = useAuth();
  // ログインしている間だけ、ためた記録を送る
  const sender = useMemo(
    () => (auth.client && auth.status === "ready" && auth.userId ? createSupabaseSender(auth.client as unknown as SupabaseLike) : undefined),
    [auth.client, auth.status, auth.userId],
  );
  return (
    <SyncProvider sender={sender}>
      <header className="app-header">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            清
          </span>
          清掃業のシステム
        </Link>
        {auth.current && auth.current.roleCode !== "external" && (
          <details className="menu">
            <summary>メニュー</summary>
            <div className="menu-panel">
              <NavBoard admin={auth.current.roleCode === "admin"} />
            </div>
          </details>
        )}
        <nav className="app-nav">
          {auth.memberships.length > 1 && (
            <select
              aria-label="会社を切り替える"
              value={auth.current?.id ?? ""}
              onChange={(e) => auth.selectCurrent(e.target.value)}
            >
              {auth.memberships.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.tenantName}
                </option>
              ))}
            </select>
          )}
          {auth.memberships.length === 1 && <span className="tenant-name">{auth.current?.tenantName}</span>}
          {auth.current?.roleCode === "admin" && (
            <>
              <Link href="/settings/users/">利用者</Link>
              <Link href="/settings/tenant/">会社の情報</Link>
            </>
          )}
          <NotificationBell />
          <PendingBadge />
          {auth.userId && (
            <button type="button" className="link" onClick={() => void auth.signOut()}>
              ログアウト
            </button>
          )}
        </nav>
      </header>
      <main>{children}</main>
    </SyncProvider>
  );
}
