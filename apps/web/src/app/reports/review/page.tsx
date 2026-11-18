"use client";

// 確認・提出の画面（R-009-33）：work.assign を持つ人が、報告書の中身と写真を見て、確認・差し戻し・提出をする。
// 押せるボタンは状況で決まる（見せ方のため。判定は DB の RPC）。
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loading, Notice, ReportShell, useReportCtx } from "@/components/reports/Shell";
import { describeError } from "@/lib/errors";
import { formatDateJa } from "@/lib/quotes/format";
import { kindLabel } from "@/lib/photos/format";
import { progressLabel, reportActionMessage, reportStatusLabel, reviewActions, sortReportItems } from "@/lib/reports/format";
import { checkReport, reopenReport, submitReport } from "@/lib/reports/repo";
import { useReportData } from "@/lib/reports/useReportData";

function ReviewBody() {
  const id = useSearchParams().get("id") ?? "";
  const { ctx, error } = useReportCtx();
  const { data, msg, setMsg, reload } = useReportData(ctx, id, "thumb");
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(verb: "check" | "reopen" | "submit") {
    if (!ctx || !data) return;
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      const fn = { check: checkReport, reopen: reopenReport, submit: submitReport }[verb];
      const r = await fn(ctx.sb, data.report.id);
      await reload();
      if (r.ok) setOk(reportActionMessage(verb, r));
      else setMsg(reportActionMessage(verb, r));
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const actions = data ? reviewActions(data.report.status, ctx?.canAssign ?? false) : null;
  const items = data ? sortReportItems(data.items) : [];
  return (
    <>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {!id ? <p>報告書が選ばれていません。</p> : null}
      {data ? (
        <>
          <p>
            <span className={`r-status ${data.report.status}`} data-testid="report-status">
              {reportStatusLabel(data.report.status)}
            </span>
            {data.work ? formatDateJa(data.work.scheduled_date) : ""} ／ {data.building} ／ {data.work?.title ?? ""}
          </p>
          <p className="m-sub">チェック {progressLabel(items)}</p>
          {items.map((i) => (
            <div key={i.id} className={`r-item${i.done ? " done" : ""}`} data-testid="review-item">
              <strong>
                {i.done ? "済" : "未"} {i.name}
              </strong>
              {i.note ? <span className="m-sub">{i.note}</span> : null}
              <div className="r-thumbs">
                {data.photos
                  .filter((p) => p.report_item_id === i.id)
                  .map((p) => (
                    <span key={p.id} className="m-sub">
                      {data.urls[p.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={data.urls[p.id]} alt={`${i.name}の${kindLabel(p.kind)}の写真`} />
                      ) : null}
                      <br />
                      {kindLabel(p.kind)}
                    </span>
                  ))}
              </div>
            </div>
          ))}
          <h3>全体のメモ</h3>
          <p>{data.report.remarks || "（なし）"}</p>
          {data.photos.some((p) => !p.report_item_id) ? (
            <>
              <h3>気づき（項目につかない写真）</h3>
              <div className="r-thumbs">
                {data.photos
                  .filter((p) => !p.report_item_id)
                  .map((p) =>
                    data.urls[p.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={p.id} src={data.urls[p.id]} alt={`${kindLabel(p.kind)}の写真`} />
                    ) : null,
                  )}
              </div>
            </>
          ) : null}
          <div className="m-row" style={{ marginTop: 16 }}>
            {actions?.check ? (
              <button type="button" className="m-btn" disabled={busy} onClick={() => void run("check")}>
                確認する
              </button>
            ) : null}
            {actions?.reopen ? (
              <button type="button" className="m-btn sub" disabled={busy} onClick={() => void run("reopen")}>
                下書きに戻す
              </button>
            ) : null}
            {actions?.submit ? (
              <button type="button" className="m-btn" disabled={busy} onClick={() => void run("submit")}>
                提出する（外部の人が読めるようになります）
              </button>
            ) : null}
            <Link className="m-btn sub" href={`/reports/print/?id=${data.report.id}`} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              印刷
            </Link>
          </div>
        </>
      ) : null}
    </>
  );
}

export default function ReviewPage() {
  return (
    <ReportShell title="確認・提出" active="reports">
      <Suspense fallback={<p>読み込み中…</p>}>
        <ReviewBody />
      </Suspense>
    </ReportShell>
  );
}
