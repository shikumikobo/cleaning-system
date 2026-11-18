"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Field, InvoiceShell, Loading, Notice, linkBtn, useInvoiceCtx, type InvoiceCtx } from "@/components/invoices/Shell";
import { calcInvoice } from "@/lib/invoices/calc";
import {
  actionMessage, dueLabel, formatDateJa, formatPercent, formatYen, invoiceStatusLabel, isOverdue, periodLabel, todayJst,
} from "@/lib/invoices/format";
import {
  cancelInvoice, deleteInvoice, deletePayment, getInvoice, issueInvoice, listLines, listPayments, markInvoiceSent, recordPayment,
  removeLine, updateDraftHeader, updateLine, updatePayment, type DraftHeaderInput, type LineEditInput, type PaymentInput,
} from "@/lib/invoices/repo";
import type { Invoice, InvoiceLine, Payment } from "@/lib/invoices/types";
import { validateDraftHeader, validateLineEdit, validatePayment, type Errors } from "@/lib/invoices/validate";
import { getClient } from "@/lib/masters/repo";
import { getCompany } from "@/lib/invoices/repo";

const EMPTY_PAYMENT: PaymentInput = { paid_on: "", amount: "", note: "" };

function Editor({ ctx }: { ctx: InvoiceCtx }) {
  const router = useRouter();
  const id = useSearchParams().get("id");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [client, setClient] = useState("");
  const [registered, setRegistered] = useState(true);
  const [header, setHeader] = useState<DraftHeaderInput>({ tax_percent: "10", due_date: "", note: "" });
  const [issueDate, setIssueDate] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayJst();

  const fail = (e: unknown) => setMsg(e instanceof Error ? e.message : String(e));

  const load = useCallback(async () => {
    if (!id) return;
    const inv = await getInvoice(ctx.sb, ctx.tenantId, id);
    if (!inv) {
      setInvoice(null);
      setMsg("請求書が見つかりません（消されたか、見る権限がありません）");
      return;
    }
    setInvoice(inv);
    setHeader({ tax_percent: formatPercent(inv.tax_rate).replace("%", ""), due_date: inv.due_date ?? "", note: inv.note ?? "" });
    const [ls, ps, c, co] = await Promise.all([
      listLines(ctx.sb, inv.id),
      listPayments(ctx.sb, inv.id),
      getClient(ctx.sb, ctx.tenantId, inv.client_id),
      getCompany(ctx.sb, ctx.tenantId).catch(() => null),
    ]);
    setLines(ls);
    setPayments(ps);
    setClient(c?.name ?? "");
    setRegistered(!!co?.invoice_reg_no?.trim());
  }, [ctx, id]);

  useEffect(() => {
    let cancelled = false;
    void load().catch((e) => !cancelled && fail(e));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const draft = invoice?.status === "draft";
  const editable = ctx.canEdit && draft;
  const live = !!invoice && !["draft", "cancelled"].includes(invoice.status);
  const totals = useMemo(() => calcInvoice(lines, invoice?.tax_rate ?? 0.1), [lines, invoice?.tax_rate]);
  const shown = invoice && !draft ? { subtotal: invoice.subtotal, tax: invoice.tax, total: invoice.total } : totals;
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  const balance = (invoice?.total ?? 0) - paid;

  async function act(run: () => Promise<{ ok: boolean; reason?: string }>, done: string, after?: () => void) {
    setMsg(null);
    setOk(null);
    setBusy(true);
    try {
      const r = await run();
      if (!r.ok) return setMsg(actionMessage(r.reason));
      setOk(done);
      if (after) after();
      else await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveHeader(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    setMsg(null);
    setOk(null);
    const errs = validateDraftHeader(header);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      await updateDraftHeader(ctx.sb, invoice.id, header);
      setOk("保存しました");
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function onIssue() {
    if (!invoice) return;
    if (lines.length === 0) return setMsg(actionMessage("no_lines"));
    if (!window.confirm("発行すると、番号が付き、合計が決まります。発行したあとは直せません（間違えたときは取り消して出し直します）。発行しますか？")) return;
    void act(() => issueInvoice(ctx.sb, invoice.id, issueDate || null), "発行しました");
  }
  function onSent() {
    if (!invoice || !window.confirm("取引先に送ったものとして、「送付」で記録します。（システムはメールを送りません）よいですか？")) return;
    void act(() => markInvoiceSent(ctx.sb, invoice.id), "送付で記録しました");
  }
  function onCancel() {
    if (!invoice) return;
    const reason = window.prompt("この請求書を取り消します。取り消すと、載っていたものは、同じ月の請求書に出し直せます。理由があれば入れてください（空でもよい）", "");
    if (reason === null) return;
    void act(() => cancelInvoice(ctx.sb, invoice.id, reason), "取り消しました。同じ月の下書きを作り直せます");
  }
  async function onDelete() {
    if (!invoice || !window.confirm("この下書きを消しますか？（載っていたものは、次の下書きに入れ直せます）")) return;
    setBusy(true);
    try {
      const r = await deleteInvoice(ctx.sb, invoice.id);
      if (!r.ok) {
        setMsg(actionMessage(r.reason));
        setBusy(false);
        return;
      }
      router.replace("/invoices/");
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  return (
    <>
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {invoice ? (
        <p>
          <span className={`q-status ${invoice.status === "paid" ? "approved" : invoice.status === "cancelled" ? "rejected" : invoice.status === "draft" ? "" : "submitted"}`}>
            {invoiceStatusLabel(invoice.status)}
          </span>
          {isOverdue(invoice, balance, today) ? <span className="q-status rejected">期日超過</span> : null}
          {invoice.number ? <strong>{invoice.number}</strong> : <span className="m-sub">（番号は発行のときに付きます）</span>}
          <span className="m-sub">
            {" "}
            {client} ／ {periodLabel(invoice.period)}
            {invoice.issue_date ? ` ／ 発行 ${formatDateJa(invoice.issue_date)}` : ""}
            {invoice.sent_at ? " ／ 送付済み" : ""}
          </span>
          {invoice.previous_id ? (
            <span className="m-sub">
              {" "}
              ／ <Link href={`/invoices/edit/?id=${invoice.previous_id}`}>取り消した元の請求書</Link>
            </span>
          ) : null}
          {invoice.status === "cancelled" && invoice.cancel_reason ? <span className="m-sub"> ／ 理由：{invoice.cancel_reason}</span> : null}
        </p>
      ) : null}
      {invoice && !registered ? (
        <p className="m-msg">会社の設定に、インボイスの登録番号がありません。印刷した請求書に登録番号が載りません（設定で入れられます）。</p>
      ) : null}

      {invoice && editable ? (
        <form className="m-form two" onSubmit={onSaveHeader} noValidate aria-label="下書きの設定">
          <Field label="税率（%）" error={errors.tax_percent}>
            <input aria-label="税率（%）" value={header.tax_percent} onChange={(e) => setHeader({ ...header, tax_percent: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="支払期日（空なら、請求月の翌月末）" error={errors.due_date}>
            <input type="date" aria-label="支払期日" value={header.due_date} onChange={(e) => setHeader({ ...header, due_date: e.target.value })} />
          </Field>
          <Field label="備考（請求書に載ります。振込先など）" wide>
            <textarea aria-label="備考" value={header.note} onChange={(e) => setHeader({ ...header, note: e.target.value })} />
          </Field>
          <div className="m-row wide">
            <button className="m-btn" type="submit" disabled={busy}>
              保存する
            </button>
          </div>
        </form>
      ) : invoice ? (
        <div className="m-form two">
          <div className="m-field"><label>取引先</label>{client}</div>
          <div className="m-field"><label>請求月</label>{periodLabel(invoice.period)}</div>
          <div className="m-field"><label>税率</label>{formatPercent(invoice.tax_rate)}</div>
          <div className="m-field"><label>支払期日</label>{dueLabel(invoice.due_date)}</div>
          {invoice.note ? <div className="m-field wide"><label>備考</label>{invoice.note}</div> : null}
        </div>
      ) : null}

      {invoice ? (
        <div className="m-section">
          <h2>明細</h2>
          <Lines ctx={ctx} lines={lines} editable={editable} reload={load} onError={setMsg} />
          <div className="q-total" aria-label="合計">
            <div><span>小計</span><span className="num">{formatYen(shown.subtotal)}</span></div>
            <div><span>消費税（{formatPercent(invoice.tax_rate)}）</span><span className="num">{formatYen(shown.tax)}</span></div>
            <div className="grand"><span>合計</span><span className="num">{formatYen(shown.total)}</span></div>
            {draft ? <span className="m-sub">下書きの合計は、画面で計算しています。発行すると確定します。税は請求書1枚に1回かけます。</span> : null}
          </div>

          <div className="q-actions">
            {ctx.canEdit && draft ? (
              <>
                <label className="m-field" style={{ minWidth: 200 }}>
                  <span style={{ fontSize: "0.9rem", fontWeight: "bold" }}>発行日（空なら今日）</span>
                  <input type="date" aria-label="発行日" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
                </label>
                <button className="m-btn" type="button" disabled={busy} onClick={onIssue}>発行する</button>
                <button className="m-btn danger" type="button" disabled={busy} onClick={() => void onDelete()}>この下書きを消す</button>
              </>
            ) : null}
            {ctx.canEdit && invoice.status === "issued" ? (
              <button className="m-btn" type="button" disabled={busy} onClick={onSent}>送付を記録する</button>
            ) : null}
            {ctx.canEdit && (invoice.status === "issued" || invoice.status === "sent") ? (
              <button className="m-btn danger" type="button" disabled={busy} onClick={onCancel}>取り消す</button>
            ) : null}
            <Link className="m-btn sub" href={`/invoices/print/?id=${invoice.id}`} style={linkBtn}>印刷（請求書）</Link>
          </div>
        </div>
      ) : null}

      {invoice && (live || payments.length > 0) ? (
        <Payments ctx={ctx} invoice={invoice} payments={payments} paid={paid} balance={balance} live={live} reload={load} onError={setMsg} onOk={setOk} />
      ) : null}
    </>
  );
}

function Lines({ ctx, lines, editable, reload, onError }: { ctx: InvoiceCtx; lines: InvoiceLine[]; editable: boolean; reload: () => Promise<void>; onError: (m: string | null) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<LineEditInput>({ name: "", qty: "1", unit: "式" });
  const [errors, setErrors] = useState<Errors>({});

  function start(l: InvoiceLine) {
    setEditing(l.id);
    setErrors({});
    onError(null);
    setForm({ name: l.name, qty: String(Number(l.qty)), unit: l.unit });
  }
  async function onSave(e: FormEvent) {
    e.preventDefault();
    const errs = validateLineEdit(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !editing) return;
    try {
      await updateLine(ctx.sb, editing, form);
      setEditing(null);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }
  async function onRemove(l: InvoiceLine) {
    if (!window.confirm(`明細「${l.name}」を、この請求書から外しますか？（元は、次の下書きに入れ直せます）`)) return;
    try {
      await removeLine(ctx.sb, l.id);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      {lines.length === 0 ? <p className="m-sub">明細はありません。</p> : null}
      {lines.length > 0 ? (
        <table className="q-lines">
          <thead>
            <tr>
              <th>品名</th><th className="num">数量</th><th>単位</th><th className="num">単価</th><th className="num">金額</th><th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td className="num">{Number(l.qty)}</td>
                <td>{l.unit}</td>
                <td className="num">{formatYen(l.unit_price)}</td>
                <td className="num">{formatYen(editable ? calcInvoice([l], 0).subtotal : l.amount)}</td>
                <td>
                  {editable ? (
                    <span className="m-row">
                      <button className="m-btn sub" type="button" aria-label={`直す ${l.name}`} onClick={() => start(l)}>直す</button>
                      <button className="m-btn danger" type="button" aria-label={`外す ${l.name}`} onClick={() => void onRemove(l)}>外す</button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {editable && editing ? (
        <form className="m-form two" onSubmit={onSave} noValidate aria-label="明細を直す">
          <Field label="品名" error={errors.name}>
            <input aria-label="品名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="数量（月の途中だけ請求するときは、0.5 など）" error={errors.qty}>
            <input aria-label="数量" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="単位" error={errors.unit}>
            <input aria-label="単位" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          </Field>
          <div className="m-row wide">
            <button className="m-btn" type="submit">保存する</button>
            <button className="m-btn sub" type="button" onClick={() => setEditing(null)}>やめる</button>
          </div>
        </form>
      ) : null}
    </>
  );
}

function Payments({
  ctx, invoice, payments, paid, balance, live, reload, onError, onOk,
}: {
  ctx: InvoiceCtx;
  invoice: Invoice;
  payments: Payment[];
  paid: number;
  balance: number;
  live: boolean;
  reload: () => Promise<void>;
  onError: (m: string | null) => void;
  onOk: (m: string | null) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null); // 直している入金の id（"" は新規）
  const [form, setForm] = useState<PaymentInput>(EMPTY_PAYMENT);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const canWrite = ctx.canEdit && live;

  function start(p: Payment | null) {
    setEditing(p?.id ?? "");
    setErrors({});
    onError(null);
    onOk(null);
    setForm(p ? { paid_on: p.paid_on, amount: String(p.amount), note: p.note ?? "" } : { ...EMPTY_PAYMENT, paid_on: todayJst(), amount: balance > 0 ? String(balance) : "" });
  }
  async function onSave(e: FormEvent) {
    e.preventDefault();
    const current = editing ? payments.find((p) => p.id === editing) : undefined;
    const errs = validatePayment(form, balance + (current?.amount ?? 0));
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const r = editing ? await updatePayment(ctx.sb, editing, form) : await recordPayment(ctx.sb, invoice.id, form);
      if (!r.ok) onError(actionMessage(r.reason));
      else {
        onOk(r.status === "paid" ? "入金を記録しました。入金済みになりました" : "入金を記録しました");
        setEditing(null);
        await reload();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function onDelete(p: Payment) {
    if (!window.confirm(`${formatDateJa(p.paid_on)} の入金 ${formatYen(p.amount)} を消しますか？`)) return;
    setBusy(true);
    try {
      const r = await deletePayment(ctx.sb, p.id);
      if (!r.ok) onError(actionMessage(r.reason));
      else {
        onOk("入金を消しました");
        await reload();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="m-section">
      <h2>入金</h2>
      <p>
        <span className="q-total-inline">入金 <strong>{formatYen(paid)}</strong> ／ 残高 <strong>{formatYen(balance)}</strong></span>
      </p>
      {payments.length === 0 ? <p className="m-sub">入金はまだありません。</p> : null}
      {payments.length > 0 ? (
        <table className="q-lines">
          <thead>
            <tr>
              <th>入金日</th><th className="num">金額</th><th>メモ</th><th />
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>{formatDateJa(p.paid_on)}</td>
                <td className="num">{formatYen(p.amount)}</td>
                <td>{p.note ?? ""}</td>
                <td>
                  {canWrite ? (
                    <span className="m-row">
                      <button className="m-btn sub" type="button" aria-label={`入金を直す ${p.paid_on}`} onClick={() => start(p)}>直す</button>
                      <button className="m-btn danger" type="button" aria-label={`入金を消す ${p.paid_on}`} disabled={busy} onClick={() => void onDelete(p)}>消す</button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canWrite && editing === null && balance > 0 ? (
        <p>
          <button className="m-btn" type="button" onClick={() => start(null)}>入金を記録する</button>
        </p>
      ) : null}
      {canWrite && editing !== null ? (
        <form className="m-form two" onSubmit={onSave} noValidate aria-label="入金を記録する">
          <Field label="入金日" error={errors.paid_on}>
            <input type="date" aria-label="入金日" value={form.paid_on} onChange={(e) => setForm({ ...form, paid_on: e.target.value })} />
          </Field>
          <Field label="金額（円）" error={errors.amount}>
            <input aria-label="金額（円）" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} inputMode="numeric" />
          </Field>
          <Field label="メモ（振込名義など）" wide>
            <input aria-label="メモ" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <div className="m-row wide">
            <button className="m-btn" type="submit" disabled={busy}>保存する</button>
            <button className="m-btn sub" type="button" onClick={() => setEditing(null)}>やめる</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function Inner() {
  const { ctx, error } = useInvoiceCtx();
  const id = useSearchParams().get("id");
  return (
    <InvoiceShell title="請求書">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      {ctx && id ? <Editor key={id} ctx={ctx} /> : null}
      {ctx && !id ? <p>請求書が選ばれていません。<Link href="/invoices/">請求の一覧へ</Link></p> : null}
    </InvoiceShell>
  );
}

export default function InvoiceEditPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Inner />
    </Suspense>
  );
}
