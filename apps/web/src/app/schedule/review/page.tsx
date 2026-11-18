"use client";

// 予実（R-012-33）：月を選ぶと、行っていない作業・終わっていない作業・時刻のずれ・行わなかった項目・出ていない報告書が、
// 種類で絞った一覧になり、月ごとの集計（建物ごと・全体）が出る。時刻のずれは 30 分以上を「ずれ」とする。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Loading, Notice, ScheduleShell, useScheduleCtx } from "@/components/schedule/Shell";
import { describeError } from "@/lib/errors";
import { listBuildings } from "@/lib/masters/repo";
import { todayJst } from "@/lib/quotes/format";
import { monthRange } from "@/lib/schedule/calendar";
import {
  countReview,
  dayLabel,
  filterReview,
  gapLabel,
  GAP_MINUTES,
  minutesLabel,
  REVIEW_LABEL,
  reportStatusText,
  reviewFlags,
  sumMonthly,
  timeRange,
  workStatusLabel,
  type ReviewFlag,
} from "@/lib/schedule/format";
import { listMonthly, listPlanActual } from "@/lib/schedule/repo";
import type { MonthlyRow, PlanActualRow } from "@/lib/schedule/types";

const FLAGS = Object.keys(REVIEW_LABEL) as ReviewFlag[];

export default function ReviewPage() {
  const { ctx, error } = useScheduleCtx();
  const router = useRouter();
  const [month, setMonth] = useState(todayJst().slice(0, 7)); // YYYY-MM
  const [flag, setFlag] = useState<ReviewFlag | "">("");
  const [rows, setRows] = useState<PlanActualRow[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (ctx && !ctx.manage) router.replace("/schedule/mine/");
  }, [ctx, router]);

  useEffect(() => {
    if (!ctx || !ctx.manage || !/^\d{4}-\d{2}$/.test(month)) return;
    let cancelled = false;
    const { from, to } = monthRange(`${month}-01`);
    void Promise.all([listPlanActual(ctx.sb, ctx.tenantId, from, to), listMonthly(ctx.sb, ctx.tenantId, from), listBuildings(ctx.sb, ctx.tenantId)])
      .then(([pa, mo, bs]) => {
        if (cancelled) return;
        setRows(pa);
        setMonthly(mo);
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
        setMsg(null);
      })
      .catch((e) => !cancelled && setMsg(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [ctx, month]);

  const counts = useMemo(() => countReview(rows), [rows]);
  const shown = useMemo(() => filterReview(rows, flag), [rows, flag]);
  const total = useMemo(() => sumMonthly(monthly), [monthly]);

  return (
    <ScheduleShell title="予実" active="review" manage={ctx?.manage ?? false}>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx?.manage ? (
        <>
          <div className="m-bar">
            <input type="month" aria-label="月" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: "auto" }} />
          </div>

          <h2>月ごとの集計</h2>
          <div className="s-scroll">
            <table className="s-sum" aria-label="月ごとの集計">
              <thead>
                <tr>
                  <th>建物</th>
                  <th>予定</th>
                  <th>完了</th>
                  <th>行わず</th>
                  <th>取消</th>
                  <th>行っていない</th>
                  <th>出ていない報告書</th>
                  <th>予定の時間</th>
                  <th>実績の時間</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map((m) => (
                  <tr key={m.building_id}>
                    <td>{buildings[m.building_id] ?? ""}</td>
                    <td>{m.planned}</td>
                    <td>{m.done}</td>
                    <td>{m.skipped}</td>
                    <td>{m.cancelled}</td>
                    <td>{m.not_done}</td>
                    <td>{m.report_missing}</td>
                    <td>{minutesLabel(m.planned_minutes)}</td>
                    <td>{minutesLabel(m.actual_minutes)}</td>
                  </tr>
                ))}
                <tr data-total="1">
                  <td>
                    <strong>全体</strong>
                  </td>
                  <td>{total.planned}</td>
                  <td>{total.done}</td>
                  <td>{total.skipped}</td>
                  <td>{total.cancelled}</td>
                  <td>{total.not_done}</td>
                  <td>{total.report_missing}</td>
                  <td>{minutesLabel(total.planned_minutes)}</td>
                  <td>{minutesLabel(total.actual_minutes)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2>確かめるもの</h2>
          <p className="m-sub">時刻のずれは、{GAP_MINUTES} 分以上を「ずれ」として出します。</p>
          <div>
            <button type="button" className="s-chip" aria-pressed={flag === ""} onClick={() => setFlag("")}>
              すべて
            </button>
            {FLAGS.map((f) => (
              <button key={f} type="button" className="s-chip" aria-pressed={flag === f} onClick={() => setFlag(f)}>
                {REVIEW_LABEL[f]}（{counts[f]}）
              </button>
            ))}
          </div>
          {shown.length === 0 ? <p>該当する作業はありません。</p> : null}
          {shown.map((r) => (
            <Link key={r.work_id} href={`/schedule/work/?id=${r.work_id}`} className="m-card" data-work={r.work_id}>
              <strong>
                <span className={`s-status ${r.status}`}>{workStatusLabel(r.status)}</span>
                {dayLabel(r.scheduled_date)} {timeRange(r.start_time, r.end_time)}
              </strong>
              <span className="m-sub">
                {buildings[r.building_id] ?? ""} ／ {r.title}
              </span>
              <span className="m-sub">
                {reviewFlags(r)
                  .map((f) => REVIEW_LABEL[f])
                  .join("・")}
              </span>
              {r.start_gap_min !== null || r.end_gap_min !== null ? (
                <span className="m-sub">{[gapLabel("start", r.start_gap_min), gapLabel("end", r.end_gap_min)].filter(Boolean).join("、")}</span>
              ) : null}
              {r.items_total > 0 ? (
                <span className="m-sub">
                  行わなかった項目：{r.items_skipped} / {r.items_total}
                </span>
              ) : null}
              <span className="m-sub">{reportStatusText(r.report_status)}</span>
            </Link>
          ))}
        </>
      ) : null}
    </ScheduleShell>
  );
}
