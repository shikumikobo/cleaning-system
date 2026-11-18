"use client";

// 見積書（A4）。「印刷する」で、画面の印刷（PDF に保存もここから）。ヘッダーや操作は印刷に出ない
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loading, Notice, useQuoteCtx } from "@/components/quotes/Shell";
import { getBuilding, getClient } from "@/lib/masters/repo";
import { buildQuoteDocument, type QuoteDocument } from "@/lib/quotes/print";
import { getCompany, getQuote, listLines } from "@/lib/quotes/repo";

function Paper() {
  const { ctx, error } = useQuoteCtx();
  const id = useSearchParams().get("id");
  const [doc, setDoc] = useState<QuoteDocument | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx || !id) return;
    let cancelled = false;
    void (async () => {
      try {
        const q = await getQuote(ctx.sb, ctx.tenantId, id);
        if (!q) return setMsg("見積が見つかりません（消されたか、見る権限がありません）");
        const [lines, company, client, building] = await Promise.all([
          listLines(ctx.sb, q.id),
          getCompany(ctx.sb, ctx.tenantId),
          getClient(ctx.sb, ctx.tenantId, q.client_id),
          getBuilding(ctx.sb, ctx.tenantId, q.building_id),
        ]);
        if (!cancelled) setDoc(buildQuoteDocument({ quote: q, lines, tenant: company, client: client?.name ?? "", building: building?.name ?? "" }));
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
        <Link href={id ? `/quotes/edit/?id=${id}` : "/quotes/"}>← 見積に戻る</Link>
        <button className="m-btn" type="button" disabled={!doc} onClick={() => window.print()}>
          印刷する（PDF に保存もできます）
        </button>
      </div>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {!id ? <p>見積が選ばれていません。</p> : null}
      {doc ? (
        <article className="qp-paper" aria-label="見積書">
          {doc.draft ? <div className="qp-draft">下書き</div> : null}
          <h1>{doc.title}</h1>
          <div className="qp-head">
            <div className="qp-to">
              <div className="name">{doc.addressee.client} 御中</div>
              <div>{doc.addressee.building}</div>
            </div>
            <div className="qp-meta">
              <div>見積番号：{doc.number}</div>
              <div>発行日：{doc.issueDate}</div>
              <div>有効期限：{doc.validUntil}</div>
            </div>
          </div>
          <div className="qp-grand">
            <span>お見積金額（税込）</span>
            <span className="amount">{doc.total}</span>
          </div>
          <table className="qp-table">
            <thead>
              <tr>
                <th>種類</th><th>品名</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th><th>頻度</th>
              </tr>
            </thead>
            <tbody>
              {doc.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.kind}</td>
                  <td>{r.name}</td>
                  <td className="num">{r.qty}</td>
                  <td>{r.unit}</td>
                  <td className="num">{r.unitPrice}</td>
                  <td className="num">{r.amount}</td>
                  <td>{r.frequency}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="qp-sum">
            <tbody>
              <tr><td>小計</td><td className="num">{doc.subtotal}</td></tr>
              <tr><td>{doc.taxLabel}</td><td className="num">{doc.tax}</td></tr>
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

export default function QuotePrintPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Paper />
    </Suspense>
  );
}
