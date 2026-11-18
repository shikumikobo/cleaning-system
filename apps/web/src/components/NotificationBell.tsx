"use client";

// ヘッダーの鈴：未読の件数を出し、お知らせの一覧へ（R-015-16）。001 の画面の枠（AppShell のヘッダー）に置く。
import Link from "next/link";
import { useEffect, useState } from "react";
import { NOTIFICATIONS_CHANGED } from "@/lib/notifications/api";
import { useNotificationSession } from "@/lib/notifications/useNotificationSession";

export function NotificationBell() {
  const state = useNotificationSession();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (state.status !== "ready") return;
    let alive = true;
    const refresh = () => void state.api.unreadCount(state.session.membershipId).then((n) => alive && setCount(n)).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 60_000);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh); // 一覧で既読にしたら、すぐ取り直す
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    };
  }, [state]);

  if (state.status !== "ready") return null;
  return (
    <Link href="/notifications/" aria-label={count > 0 ? `お知らせ（未読 ${count} 件）` : "お知らせ"}>
      🔔{count > 0 && <span> {count}</span>}
    </Link>
  );
}
