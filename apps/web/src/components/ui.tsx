"use client";

// 画面で共通の小さな部品：ログインの要る画面の門番、お知らせ・エラーの表示、操作の実行。
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import { describeError } from "@/lib/errors";

export function RequireAuth({ children, adminOnly }: { children: ReactNode; adminOnly?: boolean }) {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.status === "anon") router.replace("/login/");
  }, [auth.status, router]);

  if (auth.status === "noconfig") return <p role="alert">接続先（Supabase）が設定されていません</p>;
  if (auth.status !== "ready") return <p>読み込み中…</p>;
  if (!auth.current) {
    return <p>所属している会社がありません。招待のメールのリンクから入ってください。</p>;
  }
  if (adminOnly && auth.current.roleCode !== "admin") {
    return <p role="alert">この画面は、会社の管理者だけが使えます。</p>;
  }
  return <>{children}</>;
}

export function Flash({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (error) return <p role="alert" className="flash error">{error}</p>;
  if (notice) return <p role="status" className="flash ok">{notice}</p>;
  return null;
}

/** 操作を実行し、結果のお知らせ・エラーを持つ */
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { error, notice, busy, run };
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
