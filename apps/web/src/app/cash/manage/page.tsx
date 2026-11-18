"use client";

// 管理の画面：全員の出入りの一覧、確認、月の締め、入金（渡した現金）の登録、CSV の書き出し（R-006-15〜19・30〜32・36）
// 出し分けは見せ方だけ。権限は DB（RLS・RPC）が守る。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  closeMonth,
  confirmEntries,
  loadBalances,
  loadEntries,
  loadHolderNames,
  toCsvEntries,
  type AccountBalance,
  type EntryRow,
} from "@/lib/cash/api";
import { buildCashCsv } from "@/lib/cash/csv";
import { screenActions, validateEntryInput, yen } from "@/lib/cash/entry";
import { enqueueCashEntry } from "@/lib/cash/queue";
import { todayJst, useCash } from "@/lib/cash/useCash";

const STATUS: Record<EntryRow["status"], string> = { draft: "下書き", confirmed: "確認済み", closed: "締め済み" };

export default function CashManagePage() {
  const [reload, setReload] = useState(0);
  const { env, error, loading } = useCash(() => setReload((n) => n + 1));
  const [month, setMonth] = useState(todayJst().slice(0, 7));
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [grant, setGrant] = useState({ accountId: "", date: todayJst(), amount: "", purpose: "現金を渡した" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const actions = useMemo(() => screenActions(env?.session.perms ?? []), [env]);

  const refresh = useCallback(async () => {
    if (!env || !actions.manage) return;
    try {
      const t = env.session.tenantId;
      setAccounts(await loadBalances(env.client, t));
      setEntries(await loadEntries(env.client, t, { month, accountId: accountId || undefined }));
      setNames(await loadHolderNames(env.client, t));
      setPicked(new Set());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [env, actions.manage, month, accountId]);

  useEffect(() => {
    void refresh();
  }, [refresh, reload]);

  async function run(label: string, fn: () => Promise<string>) {
    try {
      setMessage(`${label}…`);
      setMessage(await fn());
      await refresh();
    } catch (e) {
      setMessage(`${label}できませんでした：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function registerGrant(e: React.FormEvent) {
    e.preventDefault();
    if (!env) return;
    const acc = accounts.find((a) => a.account_id === grant.accountId);
    const check = validateEntryInput({ ...grant, direction: "in" }, { allowIn: true });
    if (!check.ok || !acc) {
      setErrors(check.ok ? { accountId: "小口を選んでください" } : (check.errors as Record<string, string>));
      return;
    }
    setErrors({});
    // 持ち手に渡した現金：持ち手の所属を持ち主にして、送り箱にためる（電波がなければ、つながったときに送る）
    await enqueueCashEntry(
      env.box,
      { tenantId: env.session.tenantId, membershipId: acc.holder_id, accountId: acc.account_id, deviceId: env.deviceId },
      { date: check.value.date, amount: check.value.amount, purpose: check.value.purpose, direction: "in" },
    );
    await env.sync();
    setGrant((g) => ({ ...g, amount: "" }));
    setMessage("入金（渡した現金）を下書きで登録しました。確認すると残高に確定します。");
    await refresh();
  }

  function downloadCsv() {
    if (!env) return;
    const csv = buildCashCsv(toCsvEntries(entries, accounts, names));
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `kokuchi-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <p>読み込み中…</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!actions.manage)
    return (
      <section>
        <h1>小口の管理</h1>
        <p>この画面は、小口を管理する権限（cash.manage）のある人だけが使えます。</p>
        <Link href="/cash/">自分の小口へ</Link>
      </section>
    );

  const drafts = entries.filter((e) => e.status === "draft");
  return (
    <section>
      <h1>小口の管理</h1>
      <p>
        <Link href="/cash/">自分の小口</Link>
      </p>

      <div className="card row">
        <label>
          月
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label>
          小口
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">すべて</option>
            {accounts.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.name}（{names.get(a.holder_id) ?? "持ち手"}）
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        {accounts.map((a) => (
          <p key={a.account_id}>
            {a.name}（{names.get(a.holder_id) ?? "持ち手"}）：残高 {yen(a.balance)}／確認済みの残高 {yen(a.confirmed_balance)}／下書き {a.draft_count} 件
          </p>
        ))}
      </div>

      <div className="card row">
        {actions.confirm && (
          <button
            type="button"
            disabled={picked.size === 0}
            onClick={() => void run("確認", async () => `${await confirmEntries(env!.client, [...picked])} 件を確認済みにしました`)}
          >
            選んだ {picked.size} 件を確認する
          </button>
        )}
        {actions.confirm && (
          <button type="button" disabled={drafts.length === 0} onClick={() => setPicked(new Set(drafts.map((d) => d.id)))}>
            下書きをすべて選ぶ
          </button>
        )}
        {actions.closeMonth && (
          <button
            type="button"
            onClick={() =>
              void run("月の締め", async () => `${month} を締めました（${await closeMonth(env!.client, env!.session.tenantId, month, accountId || null)} 件が締め済み）`)
            }
          >
            {month} を締める
          </button>
        )}
        {actions.exportCsv && (
          <button type="button" onClick={downloadCsv}>
            CSV を書き出す（確認済み・締め済みだけ）
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}

      {actions.grant && (
        <form onSubmit={registerGrant} className="card" noValidate>
          <h2>入金（現金を渡した）を登録</h2>
          <label>
            小口
            <select value={grant.accountId} onChange={(e) => setGrant({ ...grant, accountId: e.target.value })}>
              <option value="">選んでください</option>
              {accounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.name}（{names.get(a.holder_id) ?? "持ち手"}）
                </option>
              ))}
            </select>
            {errors.accountId && <span className="err">{errors.accountId}</span>}
          </label>
          <label>
            日付
            <input type="date" value={grant.date} onChange={(e) => setGrant({ ...grant, date: e.target.value })} />
            {errors.date && <span className="err">{errors.date}</span>}
          </label>
          <label>
            金額（円）
            <input inputMode="numeric" value={grant.amount} onChange={(e) => setGrant({ ...grant, amount: e.target.value })} />
            {errors.amount && <span className="err">{errors.amount}</span>}
          </label>
          <label>
            用途
            <input value={grant.purpose} onChange={(e) => setGrant({ ...grant, purpose: e.target.value })} />
            {errors.purpose && <span className="err">{errors.purpose}</span>}
          </label>
          <button type="submit">入金を登録する</button>
        </form>
      )}

      <h2>出入りの一覧</h2>
      <ul className="list compact">
        {entries.map((e) => (
          <li key={e.id}>
            {e.status === "draft" && actions.confirm && (
              <input
                type="checkbox"
                aria-label="確認する"
                checked={picked.has(e.id)}
                onChange={(ev) => {
                  const next = new Set(picked);
                  if (ev.target.checked) next.add(e.id);
                  else next.delete(e.id);
                  setPicked(next);
                }}
              />
            )}
            <span>
              {e.entry_date} {names.get(e.holder_id) ?? "持ち手"} {e.direction === "in" ? "入金" : "出金"} {yen(e.amount)} {e.purpose}
            </span>
            <span className={`tag ${e.status}`}>{STATUS[e.status]}</span>
            {e.receipt_id && <span className="tag">レシートあり</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
