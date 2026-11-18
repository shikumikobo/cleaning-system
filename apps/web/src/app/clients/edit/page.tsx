"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Field, Loading, Notice, Shell, useMasters, type MastersCtx } from "@/components/masters/Shell";
import { deleteMessage } from "@/lib/masters/format";
import { deleteClient, deleteContact, getClient, listContacts, saveClient, saveContact, type ClientInput } from "@/lib/masters/repo";
import type { Contact } from "@/lib/masters/types";
import { validateClient, validateContact, type Errors } from "@/lib/masters/validate";

const EMPTY: ClientInput = { kind: "management_company", name: "", address: "", phone: "", email: "", closing_day: "", payment_terms: "" };

function ClientForm({ ctx }: { ctx: MastersCtx }) {
  const router = useRouter();
  const id = useSearchParams().get("id");
  const [form, setForm] = useState<ClientInput>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [busy, setBusy] = useState(false);

  const reloadContacts = useCallback(async () => {
    if (id) setContacts(await listContacts(ctx.sb, id));
  }, [ctx, id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const c = await getClient(ctx.sb, ctx.tenantId, id);
        if (cancelled) return;
        if (!c) return setMsg("取引先が見つかりません（消されたか、見る権限がありません）");
        setForm({
          kind: c.kind,
          name: c.name,
          address: c.address ?? "",
          phone: c.phone ?? "",
          email: c.email ?? "",
          closing_day: c.closing_day?.toString() ?? "",
          payment_terms: c.payment_terms ?? "",
        });
        await reloadContacts();
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, id, reloadContacts]);

  const set = (k: keyof ClientInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setOk(null);
    const errs = validateClient(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const saved = await saveClient(ctx.sb, ctx.tenantId, id, form);
      setOk("保存しました");
      if (!id) router.replace(`/clients/edit/?id=${saved.id}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!id || !window.confirm("この取引先を消しますか？（担当者も一緒に消えます）")) return;
    setBusy(true);
    try {
      const r = await deleteClient(ctx.sb, id);
      if (r.ok) router.replace("/clients/");
      else setMsg(deleteMessage("client", r));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      <form className="m-form two" onSubmit={onSave} noValidate>
        <Field label="種類" error={errors.kind}>
          <select value={form.kind} onChange={set("kind")}>
            <option value="management_company">管理会社</option>
            <option value="owner">オーナー</option>
          </select>
        </Field>
        <Field label="名前" error={errors.name}>
          <input value={form.name} onChange={set("name")} autoComplete="off" />
        </Field>
        <Field label="住所" wide>
          <input value={form.address} onChange={set("address")} autoComplete="off" />
        </Field>
        <Field label="電話">
          <input value={form.phone} onChange={set("phone")} inputMode="tel" autoComplete="off" />
        </Field>
        <Field label="メール" error={errors.email}>
          <input value={form.email} onChange={set("email")} inputMode="email" autoComplete="off" />
        </Field>
        <Field label="締め日（1〜31。31 は月末）" error={errors.closing_day}>
          <input value={form.closing_day} onChange={set("closing_day")} inputMode="numeric" />
        </Field>
        <Field label="支払いの条件（例：月末締め翌月末払い）">
          <input value={form.payment_terms} onChange={set("payment_terms")} />
        </Field>
        <div className="m-row wide">
          <button className="m-btn" type="submit" disabled={busy}>
            保存する
          </button>
          {id ? (
            <button className="m-btn danger" type="button" disabled={busy} onClick={onDelete}>
              この取引先を消す
            </button>
          ) : null}
        </div>
      </form>
      {id ? <Contacts ctx={ctx} clientId={id} contacts={contacts} reload={reloadContacts} /> : <p className="m-sub">担当者は、取引先を保存したあとに登録できます。</p>}
    </>
  );
}

function Contacts({ ctx, clientId, contacts, reload }: { ctx: MastersCtx; clientId: string; contacts: Contact[]; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null); // 直している担当者の id（"" は新規）
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);

  function start(c: Contact | null) {
    setEditing(c?.id ?? "");
    setForm({ name: c?.name ?? "", email: c?.email ?? "", phone: c?.phone ?? "" });
    setErrors({});
    setMsg(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const errs = validateContact(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    try {
      await saveContact(ctx.sb, ctx.tenantId, clientId, editing || null, form);
      setEditing(null);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(c: Contact) {
    if (!window.confirm(`担当者「${c.name}」を消しますか？`)) return;
    try {
      await deleteContact(ctx.sb, c.id);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="m-section">
      <h2>担当者</h2>
      <Notice text={msg} />
      {contacts.length === 0 ? <p className="m-sub">担当者はまだ登録されていません。</p> : null}
      {contacts.map((c) => (
        <div key={c.id} className="m-item">
          <span>
            <strong>{c.name}</strong>
            <span className="m-sub"> {c.email ?? ""} {c.phone ?? ""}</span>
          </span>
          <span className="m-row">
            <button className="m-btn sub" type="button" onClick={() => start(c)}>
              直す
            </button>
            <button className="m-btn danger" type="button" onClick={() => remove(c)}>
              消す
            </button>
          </span>
        </div>
      ))}
      {editing === null ? (
        <p>
          <button className="m-btn sub" type="button" onClick={() => start(null)}>
            担当者を追加
          </button>
        </p>
      ) : (
        <form className="m-form two" onSubmit={save} noValidate>
          <Field label="名前" error={errors.name}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="メール" error={errors.email}>
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} inputMode="email" />
          </Field>
          <Field label="電話">
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" />
          </Field>
          <div className="m-row wide">
            <button className="m-btn" type="submit">
              保存する
            </button>
            <button className="m-btn sub" type="button" onClick={() => setEditing(null)}>
              やめる
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Inner() {
  const { ctx, error } = useMasters();
  const id = useSearchParams().get("id");
  return (
    <Shell title={id ? "取引先の編集" : "取引先の登録"} active="clients">
      <Loading error={error} ctx={ctx} />
      {ctx ? <ClientForm key={id ?? "new"} ctx={ctx} /> : null}
    </Shell>
  );
}

export default function ClientEditPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Inner />
    </Suspense>
  );
}
