"use client";

// 会社の情報の編集と、運営の閲覧の許可（管理者。R-001-3〜6）
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Flash, RequireAuth, formatDate, useAction } from "@/components/ui";
import type { SupportGrant } from "@/lib/api";

export default function TenantPage() {
  return (
    <RequireAuth adminOnly>
      <TenantBody />
      <SupportBody />
    </RequireAuth>
  );
}

function TenantBody() {
  const { api, current } = useAuth();
  const tenantId = current!.tenantId;
  const [form, setForm] = useState({ name: "", address: "", phone: "", invoiceRegNo: "" });
  const { error, notice, busy, run } = useAction();

  useEffect(() => {
    setForm({ name: "", address: "", phone: "", invoiceRegNo: "" });
    void run(async () => {
      const t = await api!.getTenant(tenantId);
      if (t) setForm({ name: t.name, address: t.address ?? "", phone: t.phone ?? "", invoiceRegNo: t.invoiceRegNo ?? "" });
    });
  }, [api, tenantId, run]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() => api!.updateTenant(tenantId, form), "会社の情報を保存しました");
  }

  return (
    <section>
      <h1>会社の情報</h1>
      <form onSubmit={submit} className="stack">
        <label>
          会社の名前
          <input required value={form.name} onChange={set("name")} />
        </label>
        <label>
          住所
          <input value={form.address} onChange={set("address")} />
        </label>
        <label>
          電話
          <input type="tel" value={form.phone} onChange={set("phone")} />
        </label>
        <label>
          インボイスの登録番号（T＋13桁）
          <input value={form.invoiceRegNo} pattern="T[0-9]{13}|" onChange={set("invoiceRegNo")} />
        </label>
        <button type="submit" disabled={busy}>
          保存
        </button>
      </form>
      <Flash error={error} notice={notice} />
    </section>
  );
}

function SupportBody() {
  const { api, current } = useAuth();
  const tenantId = current!.tenantId;
  const [grants, setGrants] = useState<SupportGrant[]>([]);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const { error, notice, busy, run } = useAction();

  const reload = useCallback(async () => setGrants(await api!.listSupportGrants(tenantId)), [api, tenantId]);
  useEffect(() => {
    setGrants([]);
    void run(reload);
  }, [reload, run]);

  async function grant(e: FormEvent) {
    e.preventDefault();
    const ok = await run(async () => {
      await api!.grantSupport(tenantId, reason, new Date(until));
      await reload();
    }, "運営の閲覧を許しました（読むだけで、書き換えはできません）");
    if (ok) {
      setReason("");
      setUntil("");
    }
  }

  const now = Date.now();
  return (
    <section>
      <h2>運営の閲覧の許可</h2>
      <p>問い合わせの調査のため、しくみ工房の運営が、この会社のデータを読めるようにします。許した期限までで、いつでも取り消せます。</p>
      <form onSubmit={grant} className="row">
        <label>
          理由
          <input required value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label>
          許す期限
          <input type="datetime-local" required value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          許す
        </button>
      </form>
      <Flash error={error} notice={notice} />
      <ul className="list" aria-label="許可の一覧">
        {grants.map((g) => {
          const active = !g.revokedAt && new Date(g.endsAt).getTime() > now && new Date(g.startsAt).getTime() <= now;
          return (
            <li key={g.id}>
              <span>
                {g.reason}、〜{formatDate(g.endsAt)}、
                {g.revokedAt ? "取り消し済み" : active ? "許可中" : new Date(g.endsAt).getTime() <= now ? "期限切れ" : "これから"}
              </span>
              {active && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api!.revokeSupport(g.id);
                      await reload();
                    }, "運営の閲覧を取り消しました")
                  }
                >
                  取り消す
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
