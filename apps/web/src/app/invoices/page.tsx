"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Field, InvoiceShell, Loading, Notice, useInvoiceCtx } from "@/components/invoices/Shell";
import { CSV_BOM, invoicesCsv, isExportable, linesCsv } from "@/lib/invoices/csv";
import {
  actionMessage, balanceText, draftResultMessage, filterInvoices, formatYen, invoiceStatusLabel, isOverdue, periodLabel, todayJst,
} from "@/lib/invoices/format";
import { createInvoiceDrafts, listBalances, listInvoices, listLinesOf } from "@/lib/invoices/repo";
import type { Balance, Invoice } from "@/lib/invoices/types";
import { monthToPeriod, validatePeriod, type Errors } from "@/lib/invoices/validate";
import { listClients } from "@/lib/masters/repo";

/** 前の月（日本時間）。請求は月が終わってから作ることが多い */
function lastMonth(now: Date = new Date()): string {
  const t = todayJst(now);
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([CSV_BOM, text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function InvoicesPage() {
  const { ctx, error } = useInvoiceCtx();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [balances, setBalances] = useState<Record<string, Balance>>({});
  const [clients, setClients] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [month, setMonth] = useState("");
  const [draftMonth, setDraftMonth] = useState(lastMonth());
  const [draftClient, setDraftClient] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayJst();

  const load = useCallback(async () => {
    if (!ctx) return;
    const [is, bs, cs] = await Promise.all([listInvoices(ctx.sb, ctx.tenantId), listBalances(ctx.sb, ctx.tenantId), listClients(ctx.sb, ctx.tenantId)]);
    setInvoices(is);
    setBalances(Object.fromEntries(bs.map((b) => [b.invoice_id, b])));
    setClients(Object.fromEntries(cs.map((c) => [c.id, c.name])));
  }, [ctx]);

  useEffect(() => {
    let cancelled = false;
    void load().catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const shown = useMemo(() => filterInvoices(invoices, clients, { q, status, month }), [invoices, clients, q, status, month]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setMsg(null);
    setOk(null);
    const errs = validatePeriod(draftMonth);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const r = await createInvoiceDrafts(ctx.sb, ctx.tenantId, monthToPeriod(draftMonth)!, draftClient || null);
      if (!r.ok) setMsg(actionMessage(r.reason));
      else {
        setOk(draftResultMessage(r));
        setMonth(draftMonth);
        await load();
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCsv(kind: "invoices" | "lines") {
    if (!ctx) return;
    setMsg(null);
    const target = shown.filter(isExportable);
    if (target.length === 0) return setMsg("会計ソフトに渡せる請求書（発行・送付・入金のもの）が、いまの絞り込みにありません");
    try {
      const suffix = month || "all";
      if (kind === "invoices") {
        download(`invoices-${suffix}.csv`, invoicesCsv({ invoices: target, clients, balances, statusLabel: invoiceStatusLabel }));
      } else {
        const lines = await listLinesOf(ctx.sb, target.map((i) => i.id));
        download(`invoice-lines-${suffix}.csv`, linesCsv({ invoices: target, lines, clients }));
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <InvoiceShell title="請求">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {ctx ? (
        <>
          {ctx.canEdit ? (
            <form className="m-form two" onSubmit={onCreate} noValidate aria-label="下書きを作る">
              <Field label="請求する月" error={errors.period}>
                <input type="month" aria-label="請求する月" value={draftMonth} onChange={(e) => setDraftMonth(e.target.value)} />
              </Field>
              <Field label="取引先（空なら、すべての取引先）">
                <select aria-label="取引先" value={draftClient} onChange={(e) => setDraftClient(e.target.value)}>
                  <option value="">すべての取引先</option>
                  {Object.entries(clients).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="m-row wide">
                <button className="m-btn" type="submit" disabled={busy}>
                  下書きを作る
                </button>
                <span className="m-sub">定期の月額・その月に行った作業の金額・終わった案件の金額を、取引先ごとにまとめます。同じ月を何度押しても、二重には載りません（下書きから外した明細は、押すと戻ります）。</span>
              </div>
            </form>
          ) : null}

          <div className="m-bar">
            <input type="search" placeholder="番号・取引先で探す" aria-label="番号・取引先で探す" value={q} onChange={(e) => setQ(e.target.value)} />
            <input type="month" aria-label="請求月" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: "auto" }} />
            <select aria-label="状況" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
              <option value="">すべての状況</option>
              {["draft", "issued", "sent", "partial", "paid", "cancelled"].map((s) => (
                <option key={s} value={s}>
                  {invoiceStatusLabel(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="m-row" style={{ marginBottom: 12 }}>
            <button className="m-btn sub" type="button" onClick={() => void onCsv("invoices")}>
              請求書の CSV（会計ソフト用）
            </button>
            <button className="m-btn sub" type="button" onClick={() => void onCsv("lines")}>
              明細の CSV
            </button>
            <span className="m-sub">いまの絞り込みのうち、発行・送付・入金のものを出します</span>
          </div>

          {shown.length === 0 ? <p>該当する請求書はありません。</p> : null}
          {shown.map((i) => {
            const b = balances[i.id];
            const overdue = isOverdue(i, b?.balance ?? i.total, today);
            return (
              <Link key={i.id} className="m-card" href={`/invoices/edit/?id=${i.id}`}>
                <strong>
                  <span className={`q-status ${i.status === "paid" ? "approved" : i.status === "cancelled" ? "rejected" : i.status === "draft" ? "" : "submitted"}`}>{invoiceStatusLabel(i.status)}</span>
                  {overdue ? <span className="q-status rejected">期日超過</span> : null}
                  {i.number ?? "（下書き）"} ／ {clients[i.client_id] ?? ""}
                </strong>
                <span className="m-sub">
                  {periodLabel(i.period)} ／ {i.status === "draft" ? "合計は発行のときに決まります" : formatYen(i.total)}
                  {i.due_date && i.status !== "draft" ? ` ／ 期日 ${i.due_date}` : ""}
                  {b && ["issued", "sent", "partial", "paid"].includes(i.status) ? ` ／ ${balanceText(b)}` : ""}
                </span>
              </Link>
            );
          })}
        </>
      ) : null}
    </InvoiceShell>
  );
}
