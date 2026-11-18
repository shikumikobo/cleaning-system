"use client";

// 作業の画面（R-012-31）：担当の付ける・外す・入れ替え、日付と時刻の変更、行わず・取消。
// 担当を付けるとき、その人の同じ日の時刻が重なる別の作業があれば、警告を出して確かめる。
// 状況・日時は RPC だけ（版つき）。版が食い違ったら「ほかの人が直しています」と出して読み込み直す。
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { Field, Loading, Notice, ScheduleShell, useScheduleCtx } from "@/components/schedule/Shell";
import { describeError } from "@/lib/errors";
import { getBuilding } from "@/lib/masters/repo";
import { formatDistance } from "@/lib/map/geo";
import { formatDateJa } from "@/lib/quotes/format";
import { reportHref } from "@/lib/schedule/field";
import { overlapMap, overlapText } from "@/lib/schedule/calendar";
import { timeLabel, timeRange, validateReschedule, workActionMessage, workStatusLabel } from "@/lib/schedule/format";
import {
  addAssignment,
  assignConflicts,
  cancelWork,
  getWorkRow,
  listAssignments,
  listOverlaps,
  listRecordsOfWork,
  listStaff,
  removeAssignment,
  rescheduleWork,
  skipWork,
  swapAssignment,
} from "@/lib/schedule/repo";
import type { AssignmentRow, OverlapRow, StaffRow, WorkRecordRow, WorkResult, WorkRow } from "@/lib/schedule/types";

const timeText = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "（まだ）";

function Body() {
  const id = useSearchParams().get("id") ?? "";
  const { ctx, error } = useScheduleCtx();
  const [work, setWork] = useState<WorkRow | null>(null);
  const [building, setBuilding] = useState("");
  const [asg, setAsg] = useState<AssignmentRow[]>([]);
  const [records, setRecords] = useState<WorkRecordRow[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [overlaps, setOverlaps] = useState<OverlapRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addId, setAddId] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [problem, setProblem] = useState<string | undefined>();

  const reload = useCallback(async () => {
    if (!ctx || !id) return;
    try {
      const w = await getWorkRow(ctx.sb, ctx.tenantId, id);
      if (!w) {
        setMsg("作業が見つかりません（消されたか、見る権限がありません）");
        return;
      }
      const [b, as, recs, st, ov] = await Promise.all([
        getBuilding(ctx.sb, ctx.tenantId, w.building_id),
        listAssignments(ctx.sb, ctx.tenantId, [w.id]),
        listRecordsOfWork(ctx.sb, ctx.tenantId, w.id),
        ctx.manage ? listStaff(ctx.sb, ctx.tenantId) : Promise.resolve([] as StaffRow[]),
        ctx.manage ? listOverlaps(ctx.sb, ctx.tenantId, w.scheduled_date, w.scheduled_date) : Promise.resolve([] as OverlapRow[]),
      ]);
      setWork(w);
      setBuilding(b?.name ?? "");
      setAsg(as);
      setRecords(recs);
      setStaff(st);
      setOverlaps(ov);
      setDate(w.scheduled_date);
      setStart(timeLabel(w.start_time));
      setEnd(timeLabel(w.end_time));
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [ctx, id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const name = (m: string) => staff.find((s) => s.membership_id === m)?.display_name ?? "（不明な人）";

  /** RPC を呼ぶ。断られたら理由を出す。版の食い違いは、読み込み直す */
  async function runRpc(fn: () => Promise<WorkResult>, done: string) {
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      const r = await fn();
      if (!r.ok) {
        setMsg(workActionMessage(r.reason));
        if (r.reason === "conflict") await reload();
        return;
      }
      setOk(done);
      await reload();
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAdd() {
    if (!ctx || !work || !addId) return;
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      const conflicts = await assignConflicts(ctx.sb, work.id, addId);
      if (conflicts.length > 0) {
        const what = conflicts.map((c) => `${timeRange(c.start_time, c.end_time)} ${c.title}`).join("、");
        if (!window.confirm(`${name(addId)}さんは、同じ日の時刻が重なる別の作業があります（${what}）。それでも担当に付けますか？`)) return;
      }
      await addAssignment(ctx.sb, ctx.tenantId, work.id, addId);
      setOk("担当に付けました");
      setAddId("");
      await reload();
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(a: AssignmentRow) {
    if (!ctx) return;
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      await removeAssignment(ctx.sb, a.id);
      setOk("担当を外しました");
      await reload();
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSwap() {
    if (!ctx || !work || !fromId || !toId) return;
    const conflicts = await assignConflicts(ctx.sb, work.id, toId).catch(() => []);
    if (conflicts.length > 0 && !window.confirm(`${name(toId)}さんは、同じ日の時刻が重なる別の作業があります。それでも入れ替えますか？`)) return;
    await runRpc(() => swapAssignment(ctx.sb, work.id, fromId, toId), "担当を入れ替えました");
    setFromId("");
    setToId("");
  }

  async function onReschedule(e: FormEvent) {
    e.preventDefault();
    if (!ctx || !work) return;
    const p = validateReschedule({ date, start, end });
    setProblem(p ?? undefined);
    if (p) return;
    await runRpc(() => rescheduleWork(ctx.sb, work.id, work.version, date, start, end), "日付と時刻を変えました");
  }

  async function onSkip() {
    if (!ctx || !work) return;
    if (!window.confirm("この作業を「行わず」にします。よろしいですか？")) return;
    await runRpc(() => skipWork(ctx.sb, work.id, work.version), "「行わず」にしました");
  }

  async function onCancel() {
    if (!ctx || !work) return;
    if (!window.confirm("この作業を取り消します。よろしいですか？（行は残り、定時の処理は同じ日に作り直しません）")) return;
    await runRpc(() => cancelWork(ctx.sb, work.id, work.version), "取り消しました");
  }

  const scheduled = work?.status === "scheduled";
  const assignable = work?.status === "scheduled" || work?.status === "in_progress";
  const warn = work ? overlapText(work.id, overlapMap(overlaps), [work]) : "";
  const candidates = staff.filter((s) => !asg.some((a) => a.membership_id === s.membership_id));

  return (
    <ScheduleShell title="作業" active="calendar" manage={ctx?.manage ?? false}>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {work ? (
        <>
          <div className="m-card">
            <strong>
              <span className={`s-status ${work.status}`}>{workStatusLabel(work.status)}</span>
              {work.title}
            </strong>
            <span className="m-sub">
              {building} ／ {formatDateJa(work.scheduled_date)} {timeRange(work.start_time, work.end_time)}
            </span>
            {warn ? (
              <span className="s-warn" role="alert">
                ⚠ {warn}
              </span>
            ) : null}
            <div className="m-row" style={{ marginTop: 8 }}>
              <Link href={reportHref(work.id)} className="m-btn sub">
                報告書
              </Link>
              <Link href="/schedule/" className="m-btn sub">
                予定表へ
              </Link>
            </div>
          </div>

          <div className="m-section">
            <h2>担当</h2>
            {asg.length === 0 ? <p>担当はいません。</p> : null}
            {asg.map((a) => (
              <div key={a.id} className="m-item">
                <span>{name(a.membership_id)}</span>
                {ctx?.manage && assignable ? (
                  <button type="button" className="m-btn danger" disabled={busy} onClick={() => void onRemove(a)} aria-label={`${name(a.membership_id)}を外す`}>
                    外す
                  </button>
                ) : null}
              </div>
            ))}
            {ctx?.manage && assignable ? (
              <>
                <div className="m-row" style={{ marginTop: 8 }}>
                  <select aria-label="担当に付ける人" value={addId} onChange={(e) => setAddId(e.target.value)} style={{ width: "auto" }}>
                    <option value="">付ける人を選ぶ</option>
                    {candidates.map((s) => (
                      <option key={s.membership_id} value={s.membership_id}>
                        {s.display_name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="m-btn" disabled={busy || !addId} onClick={() => void onAdd()}>
                    担当に付ける
                  </button>
                </div>
                <div className="m-row" style={{ marginTop: 8 }}>
                  <select aria-label="入れ替える人（今の担当）" value={fromId} onChange={(e) => setFromId(e.target.value)} style={{ width: "auto" }}>
                    <option value="">今の担当を選ぶ</option>
                    {asg.map((a) => (
                      <option key={a.id} value={a.membership_id}>
                        {name(a.membership_id)}
                      </option>
                    ))}
                  </select>
                  <select aria-label="入れ替え先" value={toId} onChange={(e) => setToId(e.target.value)} style={{ width: "auto" }}>
                    <option value="">入れ替え先を選ぶ</option>
                    {candidates.map((s) => (
                      <option key={s.membership_id} value={s.membership_id}>
                        {s.display_name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="m-btn sub" disabled={busy || !fromId || !toId} onClick={() => void onSwap()}>
                    入れ替える
                  </button>
                </div>
              </>
            ) : null}
          </div>

          <div className="m-section">
            <h2>実績</h2>
            {records.length === 0 ? <p>まだ開始していません。</p> : null}
            {records.map((r) => (
              <div key={r.id} className="m-item">
                <span>{name(r.membership_id)}</span>
                <span>
                  {timeText(r.started_at)} 〜 {timeText(r.ended_at)}
                </span>
                {r.distance_m != null ? (
                  <span className={r.distance_warning ? "s-warn" : "m-sub"} data-distance={r.distance_m}>
                    建物から{formatDistance(r.distance_m)}
                    {r.distance_warning ? "（離れています）" : ""}
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          {ctx?.manage ? (
            <div className="m-section">
              <h2>日付・時刻を変える</h2>
              {scheduled ? (
                <form className="m-form two" onSubmit={onReschedule} aria-label="日付・時刻の変更">
                  <Field label="日付" error={problem}>
                    <input type="date" aria-label="日付" value={date} onChange={(e) => setDate(e.target.value)} />
                  </Field>
                  <Field label="開始の時刻">
                    <input type="time" aria-label="開始の時刻" value={start} onChange={(e) => setStart(e.target.value)} />
                  </Field>
                  <Field label="終了の時刻">
                    <input type="time" aria-label="終了の時刻" value={end} onChange={(e) => setEnd(e.target.value)} />
                  </Field>
                  <div className="wide">
                    <button type="submit" className="m-btn" disabled={busy}>
                      日付と時刻を変える
                    </button>
                  </div>
                </form>
              ) : (
                <p className="m-sub">予定の作業だけ、日付と時刻を変えられます。</p>
              )}
              <div className="m-row" style={{ marginTop: 12 }}>
                <button type="button" className="m-btn sub" disabled={busy || !scheduled} onClick={() => void onSkip()}>
                  行わず
                </button>
                <button type="button" className="m-btn danger" disabled={busy || !scheduled} onClick={() => void onCancel()}>
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </ScheduleShell>
  );
}

export default function WorkPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Body />
    </Suspense>
  );
}
