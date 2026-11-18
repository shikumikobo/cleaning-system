"use client";

// 請求書（A4・インボイスの書き方）。「印刷する」で、画面の印刷（PDF に保存もここから）。ヘッダーや操作は印刷に出ない
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loading, Notice, useInvoiceCtx } from "@/components/invoices/Shell";
import { buildInvoiceDocument, type InvoiceDocument } from "@/lib/invoices/print";
import { getCompany, getInvoice, listLines } from "@/lib/invoices/repo";
import { getClient } from "@/lib/masters/repo";

function Paper() {
  const { ctx, error } = useInvoiceCtx();
  const id = useSearchParams().get("id");
  const [doc, setDoc] = useState<InvoiceDocument | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx || !id) return;
    let cancelled = false;
    void (async () => {
      try {
        const inv = await getInvoice(ctx.sb, ctx.tenantId, id);
        if (!inv) return setMsg("請求書が見つかりません（消されたか、見る権限がありません）");
        const [lines, company, client] = await Promise.all([listLines(ctx.sb, inv.id), getCompany(ctx.sb, ctx.tenantId), getClient(ctx.sb, ctx.tenantId, inv.client_id)]);
        if (!cancelled) setDoc(buildInvoiceDocument({ invoice: inv, lines, tenant: company, client: client?.name ?? "" }));
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, id]);

  return (
    <section>
      <div className="q-noprint m-row" style={{ marginBottom: 12 }}>
        <Link href={id ? `/invoices/edit/?id=${id}` : "/invoices/"}>← 請求書に戻る</Link>
        <button className="m-btn" type="button" disabled={!doc} onClick={() => window.print()}>
          印刷する（PDF に保存もできます）
        </button>
      </div>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {!id ? <p>請求書が選ばれていません。</p> : null}
      {doc ? (
        <article className="qp-paper" aria-label="請求書">
          {doc.mark ? <div className="qp-draft">{doc.mark}</div> : null}
          <h1>{doc.title}</h1>
          <div className="qp-head">
            <div className="qp-to">
              <div className="name">{doc.addressee} 御中</div>
            </div>
            <div className="qp-meta">
              <div>請求書番号：{doc.number}</div>
              <div>発行日：{doc.issueDate}</div>
              <div>取引の月：{doc.period}</div>
              <div>支払期日：{doc.dueDate}</div>
            </div>
          </div>
          <div className="qp-grand">
            <span>ご請求金額（税込）</span>
            <span className="amount">{doc.total}</span>
          </div>
          <table className="qp-table">
            <thead>
              <tr>
                <th>品名</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th>
              </tr>
            </thead>
            <tbody>
              {doc.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.name}</td>
                  <td className="num">{r.qty}</td>
                  <td>{r.unit}</td>
                  <td className="num">{r.unitPrice}</td>
                  <td className="num">{r.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="qp-sum" aria-label="税率ごとの合計">
            <tbody>
              {doc.taxRows.map((t) => (
                <tr key={t.label}>
                  <td>{t.label}</td>
                  <td className="num">{t.base}</td>
                </tr>
              ))}
              {doc.taxRows.map((t) => (
                <tr key={`${t.label}-tax`}>
                  <td>{t.taxLabel}</td>
                  <td className="num">{t.tax}</td>
                </tr>
              ))}
              <tr className="grand"><td>合計</td><td className="num">{doc.total}</td></tr>
            </tbody>
          </table>
          {doc.note ? <div className="qp-note">{doc.note}</div> : null}
          <div className="qp-company">
            <div className="name">{doc.company.name}</div>
            {doc.company.address ? <div>{doc.company.address}</div> : null}
            {doc.company.phone ? <div>電話 {doc.company.phone}</div> : null}
            {doc.company.registration ? <div>{doc.company.registration}</div> : null}
          </div>
        </article>
      ) : null}
    </section>
  );
}

export default function InvoicePrintPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Paper />
    </Suspense>
  );
}
