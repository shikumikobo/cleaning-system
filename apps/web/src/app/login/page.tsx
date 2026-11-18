"use client";

// ログイン：メールアドレスを入れると、ログインのリンクがメールで届く（パスワードなし。R-001-13）
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Flash, useAction } from "@/components/ui";

export default function LoginPage() {
  const auth = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const { error, notice, busy, run } = useAction();

  useEffect(() => {
    if (auth.status === "ready") router.replace("/");
  }, [auth.status, router]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!auth.api) return;
    void run(() => auth.api!.sendLoginLink(email, `${window.location.origin}/`), "メールを送りました。届いたメールのリンクを開いてください");
  }

  return (
    <section>
      <h1>ログイン</h1>
      <p>登録したメールアドレスを入れてください。ログインのリンクをメールでお送りします（パスワードは使いません）。</p>
      <form onSubmit={submit} className="stack">
        <label>
          メールアドレス
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || !auth.api}>
          ログインのリンクを送る
        </button>
      </form>
      <Flash error={error} notice={notice} />
      <p className="hint">招待を受けた方は、招待のメールのリンクから入ってください。</p>
    </section>
  );
}
