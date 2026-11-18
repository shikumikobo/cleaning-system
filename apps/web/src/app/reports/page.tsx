"use client";

// 清掃報告書の一覧（R-009-31）：スタッフは自分が担当の作業（最近のもの）を、報告書の状況つきで見る。
// work.assign を持つ人は全員の作業を見て、確認・提出の画面へ進む。作業から報告書を開く・作る。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Loading, Notice, ReportShell, useReportCtx } from "@/components/reports/Shell";
import { describeError } from "@/lib/errors";
import { listBuildings } from "@/lib/masters/repo";
import { formatDateJa, todayJst } from "@/lib/quotes/format";
import { filterByReportStatus, progressLabel, reportStatusLabel, reportWorkRange } from "@/lib/reports/format";
import { listReportItems, listReportableWorks, listReports, type WorkRef } from "@/lib/reports/repo";
import type { ReportRow } from "@/lib/reports/types";

export default function ReportsPage() {
  const { ctx, error } = useReportCtx();
  const [works, setWorks] = useState<WorkRef[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void (async () => {
      try {
        const { from, to } = reportWorkRange(todayJst());
        const [ws, bs] = await Promise.all([listReportableWorks(ctx.sb, ctx.tenantId, from, to), listBuildings(ctx.sb, ctx.tenantId)]);
        const rs = await listReports(ctx.sb, ctx.tenantId, ws.map((w) => w.id));
        const prog: Record<string, string> = {};
        for (const r of rs) prog[r.id] = progressLabel(await listReportItems(ctx.sb, ctx.tenantId, r.id));
        if (cancelled) return;
        setWorks(ws);
        setReports(rs);
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
        setProgress(prog);
      } catch (e) {
        if (!cancelled) setMsg(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const rows = useMemo(() => works.map((w) => ({ work: w, report: reports.find((r) => r.work_id === w.id) ?? null })), [works, reports]);
  const shown = filterByReportStatus(
    rows.map((r) => ({ ...r, status: r.report?.status ?? null })),
    filter,
  );

  return (
    <ReportShell title="清掃報告書" active="reports">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx ? (
        <>
          <div className="m-bar">
            <select aria-label="報告書の状況" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "auto" }}>
              <option value="">すべての作業</option>
              <option value="none">報告書がまだ</option>
              <option value="draft">下書き</option>
              <option value="checked">確認済み</option>
              <option value="submitted">提出</option>
            </select>
          </div>
          <p className="m-sub">2週間前から明日までの作業です。{ctx.canAssign ? "全員の作業が出ます。" : "あなたが担当の作業が出ます。"}</p>
          {shown.length === 0 ? <p>該当する作業はありません。</p> : null}
          {shown.map(({ work, report }) => (
            <div key={work.id} className="m-card" data-testid="report-row">
              <strong>
                <span className={`r-status ${report?.status ?? ""}`}>{reportStatusLabel(report?.status)}</span>
                {formatDateJa(work.scheduled_date)}
              </strong>
              <span className="m-sub">
                {buildings[work.building_id] ?? ""} ／ {work.title}
                {report ? `（チェック ${progress[report.id] ?? ""}）` : ""}
              </span>
              <span className="m-row" style={{ marginTop: 8 }}>
                {ctx.canRecord ? (
                  <Link className="m-btn sub" href={`/reports/edit/?work=${work.id}`} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                    {report ? "報告書を開く" : "報告書を作る"}
                  </Link>
                ) : null}
                {ctx.canAssign && report ? (
                  <Link className="m-btn" href={`/reports/review/?id=${report.id}`} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                    確認・提出
                  </Link>
                ) : null}
              </span>
            </div>
          ))}
        </>
      ) : null}
    </ReportShell>
  );
}
