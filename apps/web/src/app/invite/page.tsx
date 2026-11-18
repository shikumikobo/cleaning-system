"use client";

// 招待を受ける：メールのリンクで入り、表示名を入れて会社に所属する（R-001-8）。
// 期限切れ・使用済み・取り消し・別のメールは、同じ文言で断る（R-001-9）。
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Flash, useAction } from "@/components/ui";

export default function InvitePage() {
  const auth = useAuth();
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");
  const { error, busy, run } = useAction();

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!auth.api || !token) return;
    let membershipId = "";
    const ok = await run(async () => {
      membershipId = await auth.api!.acceptInvitation(token, name);
    });
    if (!ok) return;
    window.history.replaceState(null, "", window.location.pathname); // 鍵を URL に残さない
    await auth.refresh(membershipId);
    router.replace("/");
  }

  if (auth.status === "loading" || token === undefined) return <p>読み込み中…</p>;
  if (!token) return <p role="alert">招待のリンクが正しくありません。メールのリンクを開き直してください。</p>;
  if (auth.status === "noconfig") return <p role="alert">接続先（Supabase）が設定されていません</p>;
  if (auth.status === "anon") {
    return (
      <section>
        <h1>招待を受ける</h1>
        <p role="alert">ログインできていません。招待のメールのリンクを、もう一度開いてください。</p>
      </section>
    );
  }
  return (
    <section>
      <h1>招待を受ける</h1>
      <p>お名前（画面に出る名前）を入れて、会社に参加してください。</p>
      <form onSubmit={submit} className="stack">
        <label>
          表示名
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || name.trim() === ""}>
          所属する
        </button>
      </form>
      <Flash error={error} />
    </section>
  );
}
