"use client";

// 報告書の印刷（R-009-34）。「印刷する」で、画面の印刷（PDF に保存もここから）。ヘッダーや操作は印刷に出ない
import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Loading, Notice, useReportCtx } from "@/components/reports/Shell";
import { formatDateJa } from "@/lib/quotes/format";
import { kindLabel } from "@/lib/photos/format";
import { progressLabel, reportStatusLabel, sortReportItems } from "@/lib/reports/format";
import { useReportData } from "@/lib/reports/useReportData";
import "@/components/reports/reports.css";

function Paper() {
  const id = useSearchParams().get("id") ?? "";
  const { ctx, error } = useReportCtx();
  const { data, msg } = useReportData(ctx, id, "original");
  const items = data ? sortReportItems(data.items) : [];
  return (
    <section>
      <div className="r-noprint m-row" style={{ marginBottom: 12 }}>
        <Link href={id ? `/reports/review/?id=${id}` : "/reports/"}>← 報告書に戻る</Link>
        <button className="m-btn" type="button" disabled={!data} onClick={() => window.print()}>
          印刷する（PDF に保存もできます）
        </button>
      </div>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {!id ? <p>報告書が選ばれていません。</p> : null}
      {data ? (
        <article className="r-paper" aria-label="清掃報告書">
          <h1>清掃報告書{data.report.status === "draft" ? "（下書き）" : ""}</h1>
          <table>
            <tbody>
              <tr>
                <th>建物</th>
                <td>{data.building}</td>
              </tr>
              <tr>
                <th>作業日</th>
                <td>{data.work ? formatDateJa(data.work.scheduled_date) : ""}</td>
              </tr>
              <tr>
                <th>作業</th>
                <td>{data.work?.title ?? ""}</td>
              </tr>
              <tr>
                <th>状況</th>
                <td>
                  {reportStatusLabel(data.report.status)}（チェック {progressLabel(items)}）
                </td>
              </tr>
            </tbody>
          </table>
          <table aria-label="チェック項目">
            <thead>
              <tr>
                <th style={{ width: "10%" }}>結果</th>
                <th style={{ width: "35%" }}>項目</th>
                <th>メモ</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.done ? "済" : "未"}</td>
                  <td>{i.name}</td>
                  <td>{i.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>全体のメモ・気づき</h2>
          <p>{data.report.remarks || "（なし）"}</p>
          {data.photos.length > 0 ? (
            <>
              <h2>写真</h2>
              <div className="r-photos">
                {data.photos.map((p) => (
                  <figure key={p.id}>
                    {data.urls[p.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={data.urls[p.id]} alt={`${kindLabel(p.kind)}の写真`} />
                    ) : null}
                    <figcaption>
                      {kindLabel(p.kind)}
                      {p.report_item_id ? `：${data.items.find((i) => i.id === p.report_item_id)?.name ?? ""}` : ""}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

export default function PrintPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Paper />
    </Suspense>
  );
}
