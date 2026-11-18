"use client";

// 予定表（R-012-30）：日・週・月を切り替え、スタッフごと・建物ごとに作業を並べる。同じ人の時刻の重なりは警告で出す。
// 作業を押すと、担当の入れ替え・日時の変更などの画面へ。work.assign を持たない人は、自分の予定へ移る。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Loading, Notice, ScheduleShell, useScheduleCtx } from "@/components/schedule/Shell";
import { describeError } from "@/lib/errors";
import { listBuildings } from "@/lib/masters/repo";
import { todayJst } from "@/lib/quotes/format";
import { daysOf, groupSchedule, overlapMap, overlapText, rangeFor, rangeTitle, shiftAnchor, type CalendarMode, type GroupBy } from "@/lib/schedule/calendar";
import { dayLabel, timeRange, workStatusLabel } from "@/lib/schedule/format";
import { listAssignments, listOverlaps, listStaff, listWorksInRange } from "@/lib/schedule/repo";
import type { AssignmentRow, OverlapRow, WorkRow } from "@/lib/schedule/types";

const MODES: Array<[CalendarMode, string]> = [
  ["day", "日"],
  ["week", "週"],
  ["month", "月"],
];

export default function CalendarPage() {
  const { ctx, error } = useScheduleCtx();
  const router = useRouter();
  const [mode, setMode] = useState<CalendarMode>("week");
  const [by, setBy] = useState<GroupBy>("staff");
  const [anchor, setAnchor] = useState(todayJst());
  const [works, setWorks] = useState<WorkRow[]>([]);
  const [asg, setAsg] = useState<AssignmentRow[]>([]);
  const [overlaps, setOverlaps] = useState<OverlapRow[]>([]);
  const [staff, setStaff] = useState<Record<string, string>>({});
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (ctx && !ctx.manage) router.replace("/schedule/mine/");
  }, [ctx, router]);

  const { from, to } = useMemo(() => rangeFor(mode, anchor), [mode, anchor]);

  useEffect(() => {
    if (!ctx || !ctx.manage) return;
    let cancelled = false;
    void (async () => {
      try {
        const [ws, ov, st, bs] = await Promise.all([
          listWorksInRange(ctx.sb, ctx.tenantId, from, to),
          listOverlaps(ctx.sb, ctx.tenantId, from, to),
          listStaff(ctx.sb, ctx.tenantId),
          listBuildings(ctx.sb, ctx.tenantId),
        ]);
        const as = await listAssignments(ctx.sb, ctx.tenantId, ws.map((w) => w.id));
        if (cancelled) return;
        setWorks(ws);
        setOverlaps(ov);
        setAsg(as);
        setStaff(Object.fromEntries(st.map((s) => [s.membership_id, s.display_name])));
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
        setMsg(null);
      } catch (e) {
        if (!cancelled) setMsg(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, from, to]);

  const groups = useMemo(() => groupSchedule(works, asg, by, { staff, buildings }), [works, asg, by, staff, buildings]);
  const omap = useMemo(() => overlapMap(overlaps), [overlaps]);
  const days = useMemo(() => daysOf(from, to), [from, to]);

  const item = (w: WorkRow, showBuilding: boolean) => {
    const warn = overlapText(w.id, omap, works);
    return (
      <Link key={w.id} href={`/schedule/work/?id=${w.id}`} className="s-cell-item" data-work={w.id}>
        <span className={`s-status ${w.status}`}>{workStatusLabel(w.status)}</span>
        {timeRange(w.start_time, w.end_time)} {w.title}
        {showBuilding ? <span className="m-sub"> ／ {buildings[w.building_id] ?? ""}</span> : null}
        {warn ? (
          <span className="s-warn" role="alert">
            ⚠ {warn}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <ScheduleShell title="予定表" active="calendar" manage={ctx?.manage ?? false}>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx?.manage ? (
        <>
          <div className="m-bar">
            {MODES.map(([m, label]) => (
              <button key={m} type="button" className="s-chip" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {label}
              </button>
            ))}
            <select aria-label="まとめ方" value={by} onChange={(e) => setBy(e.target.value as GroupBy)} style={{ width: "auto" }}>
              <option value="staff">スタッフごと</option>
              <option value="building">建物ごと</option>
            </select>
          </div>
          <div className="s-head">
            <button type="button" className="m-btn sub" onClick={() => setAnchor(shiftAnchor(mode, anchor, -1))}>
              前へ
            </button>
            <h2 aria-live="polite">{rangeTitle(mode, anchor)}</h2>
            <button type="button" className="m-btn sub" onClick={() => setAnchor(todayJst())}>
              今日
            </button>
            <button type="button" className="m-btn sub" onClick={() => setAnchor(shiftAnchor(mode, anchor, 1))}>
              次へ
            </button>
          </div>
          {overlaps.length > 0 ? (
            <p className="s-warn" role="alert">
              ⚠ 同じ人の時刻が重なっている作業が {new Set(overlaps.map((o) => o.work_id)).size} 件あります（印のある作業を開いて、担当を入れ替えてください）
            </p>
          ) : null}
          {groups.length === 0 ? <p>この期間の予定はありません。</p> : null}
          {mode === "week" && groups.length > 0 ? (
            <div className="s-scroll">
              <table className="s-table" aria-label="週の予定表">
                <thead>
                  <tr>
                    <th>{by === "staff" ? "スタッフ" : "建物"}</th>
                    {days.map((d) => (
                      <th key={d}>{dayLabel(d)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key} data-group={g.key}>
                      <th>{g.label}</th>
                      {days.map((d) => (
                        <td key={d} className="s-cell">
                          {g.works.filter((w) => w.scheduled_date === d).map((w) => item(w, by === "staff"))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {mode !== "week"
            ? groups.map((g) => (
                <div key={g.key} className="s-group" data-group={g.key}>
                  <h3>{g.label}</h3>
                  {days
                    .filter((d) => g.works.some((w) => w.scheduled_date === d))
                    .map((d) => (
                      <div key={d}>
                        {mode === "month" ? <div className="s-day">{dayLabel(d)}</div> : null}
                        {g.works.filter((w) => w.scheduled_date === d).map((w) => (
                          <div key={w.id} className="m-card">
                            {item(w, by === "staff")}
                          </div>
                        ))}
                      </div>
                    ))}
                </div>
              ))
            : null}
        </>
      ) : null}
    </ScheduleShell>
  );
}
