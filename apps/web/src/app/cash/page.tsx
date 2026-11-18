"use client";

// 持ち手の画面：自分の小口の残高、出金の登録（スマホ。電波がなくても端末にためる）、レシートの撮影（R-006-6・10・34・35）
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { deleteDraft, loadBalances, loadEntries, loadReceipts, updateDraftAmount, type AccountBalance, type EntryRow, type ReceiptRow } from "@/lib/cash/api";
import { summarizeAccount, validateEntryInput, yen } from "@/lib/cash/entry";
import { enqueueCashEntry, enqueueReceipt } from "@/lib/cash/queue";
import { shrinkImage, todayJst, useCash } from "@/lib/cash/useCash";

const STATUS: Record<EntryRow["status"], string> = { draft: "下書き", confirmed: "確認済み", closed: "締め済み" };

export default function CashPage() {
  const [reload, setReload] = useState(0);
  const { env, error, loading } = useCash(() => setReload((n) => n + 1));
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [receipts, setReceipts] = useState<Map<string, ReceiptRow>>(new Map());
  const [pending, setPending] = useState(0);
  const [form, setForm] = useState({ accountId: "", date: todayJst(), amount: "", purpose: "" });
  const [photo, setPhoto] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!env) return;
    try {
      const mine = (await loadBalances(env.client, env.session.tenantId)).filter((a) => a.holder_id === env.session.membershipId);
      setAccounts(mine);
      setForm((f) => (f.accountId || !mine[0] ? f : { ...f, accountId: mine[0].account_id }));
      const rows = (await loadEntries(env.client, env.session.tenantId)).filter((e) => e.holder_id === env.session.membershipId);
      setEntries(rows);
      setReceipts(await loadReceipts(env.client, rows.flatMap((r) => (r.receipt_id ? [r.receipt_id] : []))));
    } catch (e) {
      // 電波がない間は、読み込めない（登録は端末にためられる）
      setMessage(e instanceof Error ? `読み込めませんでした（${e.message}）` : null);
    }
    setPending(await env.box.pendingCount(env.session.tenantId));
  }, [env]);

  useEffect(() => {
    void refresh();
  }, [refresh, reload]);

  useEffect(() => env?.box.subscribe(() => void env.box.pendingCount(env.session.tenantId).then(setPending)), [env]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!env) return;
    setMessage(null);
    const check = validateEntryInput({ ...form, direction: "out" }); // 持ち手は出金だけ
    if (!check.ok) {
      setErrors(check.errors as Record<string, string>);
      return;
    }
    setErrors({});
    const ctx = { tenantId: env.session.tenantId, membershipId: env.session.membershipId, accountId: check.value.accountId, deviceId: env.deviceId };
    let receiptId: string | null = null;
    if (photo) {
      const img = await shrinkImage(photo);
      receiptId = await enqueueReceipt(env.box, env.rq, ctx, img.bytes, img.mime);
    }
    await enqueueCashEntry(env.box, ctx, { date: check.value.date, amount: check.value.amount, purpose: check.value.purpose, direction: "out", receiptId });
    setForm((f) => ({ ...f, amount: "", purpose: "" }));
    setPhoto(null);
    setMessage("登録しました。電波がないときは端末にためて、つながったら自動で送ります。");
    await env.sync();
    await refresh();
  }

  async function act(fn: () => Promise<void>) {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) return <p>読み込み中…</p>;
  if (error) return <p role="alert">{error}</p>;

  return (
    <section>
      <h1>小口現金</h1>
      <p>
        <Link href="/cash/manage/">管理の画面</Link>（現金を渡す人・確認する人）
      </p>

      {accounts.length === 0 && <p>あなたの小口はまだありません。管理の人に作ってもらってください。</p>}
      {accounts.map((a) => {
        const s = summarizeAccount(a, pending);
        return (
          <div key={a.account_id} className="card">
            <strong>{a.name}</strong>
            <p className="big">残高 {s.balanceText}</p>
            <p>確認済みの残高 {s.confirmedText}／下書き {s.draftCount} 件</p>
            {s.warning && <p className="warn">{s.warning}</p>}
          </div>
        );
      })}
      {pending > 0 && <p className="warn">送れていない記録が {pending} 件あります（電波が戻ったら自動で送ります）</p>}

      {accounts.length > 0 && (
        <form onSubmit={submit} className="card" noValidate>
          <h2>出金を登録</h2>
          {accounts.length > 1 && (
            <label>
              小口
              <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                {accounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            日付
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            {errors.date && <span className="err">{errors.date}</span>}
          </label>
          <label>
            金額（円）
            <input inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="1980" />
            {errors.amount && <span className="err">{errors.amount}</span>}
          </label>
          <label>
            用途
            <input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} placeholder="洗剤" />
            {errors.purpose && <span className="err">{errors.purpose}</span>}
          </label>
          <label>
            レシートの写真
            <input type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
          <button type="submit">登録する</button>
        </form>
      )}
      {message && <p role="status">{message}</p>}

      <h2>自分の出入り</h2>
      <ul className="list compact">
        {entries.map((e) => {
          const r = e.receipt_id ? receipts.get(e.receipt_id) : undefined;
          const suggest = e.status === "draft" && r?.read_amount != null && r.read_amount !== e.amount;
          return (
            <li key={e.id}>
              <span>
                {e.entry_date} {e.direction === "in" ? "入金" : "出金"} {yen(e.amount)} {e.purpose}
              </span>
              <span className={`tag ${e.status}`}>{STATUS[e.status]}</span>
              {e.receipt_id && <span className="tag">レシート{r ? (r.status === "read" ? "（読み取り済み）" : r.status === "failed" ? "（読み取れず）" : "") : "（送信待ち）"}</span>}
              {suggest && (
                <button type="button" onClick={() => void act(() => updateDraftAmount(env!.client, e.id, r!.read_amount!))}>
                  レシートの読み取り {yen(r!.read_amount!)} に直す
                </button>
              )}
              {e.status === "draft" && (
                <button type="button" onClick={() => void act(() => deleteDraft(env!.client, e.id))}>
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
