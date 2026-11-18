"use client";

// スマホの「自分の予定」（R-012-27〜29）：自分が担当の今日以降の作業を見て、現場で「開始」「終了」を押す。
// 押すと、端末の uuid で呼ぶ RPC を送り箱にため（電波がなくても押せる）、電波があればすぐ送る。ためてある間は「送信待ち」。
// 行った項目は、報告書（009）の画面で付ける。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useOutbox } from "@/components/SyncProvider";
import { Loading, Notice, ScheduleShell, useScheduleCtx } from "@/components/schedule/Shell";
import "@/components/map/map.css";
import { describeError } from "@/lib/errors";
import { createSupabaseSender, flush, getDeviceId, type OutboxItem, type SupabaseLike } from "@/lib/offline";
import { appleMapsUrl, directionsUrl } from "@/lib/map/geo";
import { resolvePosition, type ConsentChoice, type GeoLike } from "@/lib/map/location";
import { listBuildings } from "@/lib/masters/repo";
import type { Building } from "@/lib/masters/types";
import { formatDateJa, todayJst } from "@/lib/quotes/format";
import { enqueueFinish, enqueueStart, fieldState, myWorks, pendingFor, reportHref, splitToday } from "@/lib/schedule/field";
import { dayLabel, timeRange, workStatusLabel } from "@/lib/schedule/format";
import { listMyAssignments, listMyOpenRecords, listWorksByIds } from "@/lib/schedule/repo";
import type { WorkRecordRow, WorkRow } from "@/lib/schedule/types";

export default function MinePage() {
  const { ctx, error } = useScheduleCtx();
  const box = useOutbox();
  const [works, setWorks] = useState<WorkRow[]>([]);
  const [open, setOpen] = useState<WorkRecordRow[]>([]);
  const [buildings, setBuildings] = useState<Record<string, Building>>({});
  // 開始・終了を押したあと、位置を記録するかを尋ねている間の作業（R-013-27）
  const [ask, setAsk] = useState<{ kind: "start" | "finish"; work: WorkRow } | null>(null);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayJst();

  const reload = useCallback(async () => {
    if (!ctx) return;
    try {
      const mine = await listMyAssignments(ctx.sb, ctx.tenantId, ctx.membershipId);
      const ids = [...new Set(mine.map((a) => a.work_id))];
      const [ws, recs, bs] = await Promise.all([listWorksByIds(ctx.sb, ctx.tenantId, ids, today), listMyOpenRecords(ctx.sb, ctx.tenantId, ctx.membershipId), listBuildings(ctx.sb, ctx.tenantId)]);
      setWorks(myWorks(ws, new Set(ids)));
      setOpen(recs);
      setBuildings(Object.fromEntries(bs.map((b) => [b.id, b])));
      setMsg(null);
    } catch (e) {
      setMsg(describeError(e)); // 前に読めた予定は、そのまま残す（電波がなくても、押せる）
    }
  }, [ctx, today]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 送信待ち（端末にためてある開始・終了）
  useEffect(() => {
    if (!box) return;
    let alive = true;
    const refresh = () => void box.list().then((l) => alive && setItems(l));
    refresh();
    const off = box.subscribe(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [box]);

  // 押したら、まず「位置を記録しますか」と尋ねる（毎回。了承の選びを端末に残さない）。位置を取るのは、了承した 1 回だけ
  function press(kind: "start" | "finish", w: WorkRow) {
    if (busy) return;
    setOk(null);
    setAsk({ kind, work: w });
  }

  async function answer(choice: ConsentChoice) {
    const cur = ask;
    setAsk(null);
    if (!cur || choice === "cancel") return;
    const { kind, work: w } = cur;
    if (!ctx || !box || busy) return;
    setBusy(true);
    try {
      const geo = typeof navigator !== "undefined" ? (navigator.geolocation as GeoLike | undefined) : undefined;
      const resolved = await resolvePosition(choice, geo);
      const deviceId = await getDeviceId();
      const scope = { tenantId: ctx.tenantId, membershipId: ctx.membershipId, deviceId };
      // 先に端末にためる（電波がなくても失われない）。そのあと送ってみる
      if (kind === "start") await enqueueStart(box, scope, w.id, new Date(), resolved.pos);
      else await enqueueFinish(box, scope, w.id, new Date(), resolved.pos);
      const r = await flush(box, createSupabaseSender(ctx.sb as unknown as SupabaseLike), { deviceId, appVersion: "0.0.0" });
      const base = r.offline ? "電波がないので、端末にためました。電波が戻ると自動で送ります" : kind === "start" ? "開始を送りました" : "終了を送りました";
      setOk(resolved.note ? `${base}。${resolved.note}` : base);
      await reload();
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const split = useMemo(() => splitToday(works, today), [works, today]);

  const row = (w: WorkRow) => {
    const st = fieldState(w, open, pendingFor(items, w.id));
    return (
      <div key={w.id} className="m-card" data-work={w.id}>
        <strong>
          <span className={`s-status ${st.status}`}>{workStatusLabel(st.status)}</span>
          {dayLabel(w.scheduled_date)} {timeRange(w.start_time, w.end_time)}
        </strong>
        <span className="m-sub">
          {buildings[w.building_id]?.name ?? ""} ／ {w.title}
        </span>
        {st.pending ? (
          <span className="s-pending" role="status">
            送信待ち（端末にためてあります）
          </span>
        ) : null}
        <div className="m-row" style={{ marginTop: 8 }}>
          {st.action === "start" ? (
            <button type="button" className="s-big" disabled={busy} onClick={() => press("start", w)} aria-label={`開始：${w.title}`}>
              開始
            </button>
          ) : null}
          {st.action === "finish" ? (
            <button type="button" className="s-big finish" disabled={busy} onClick={() => press("finish", w)} aria-label={`終了：${w.title}`}>
              終了
            </button>
          ) : null}
          <Link href={reportHref(w.id)} className="m-btn sub">
            行った項目（報告書）
          </Link>
        </div>
        {buildings[w.building_id] ? (
          <div className="m-row" style={{ marginTop: 8 }}>
            <Link href={`/map/?building=${w.building_id}&date=${w.scheduled_date}`} className="m-btn sub" aria-label={`地図：${w.title}`}>
              地図
            </Link>
            <a href={directionsUrl(buildings[w.building_id])} target="_blank" rel="noopener noreferrer" className="m-btn sub" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }} aria-label={`道案内：${w.title}`}>
              道案内
            </a>
            <a href={appleMapsUrl(buildings[w.building_id])} target="_blank" rel="noopener noreferrer" className="m-btn sub" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              Apple マップ
            </a>
            <Link href={`/buildings/edit/?id=${w.building_id}`} className="m-btn sub" aria-label={`建物カルテ：${w.title}`}>
              建物カルテ
            </Link>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <ScheduleShell title="自分の予定" active="mine" manage={ctx?.manage ?? false}>
      {ask ? (
        <div className="map-dialog" role="dialog" aria-modal="true" aria-label="位置の記録">
          <div>
            <h2>位置を記録しますか</h2>
            <p>
              {ask.kind === "start" ? "開始" : "終了"}を押す、この 1 回だけ、いまいる場所を記録します。建物から離れていると、社員に知らせが届きます。記録した位置は 90 日で消えます。位置を常に追うことはしません。
            </p>
            <button type="button" className="s-big" onClick={() => void answer("with")}>
              位置を記録して{ask.kind === "start" ? "開始" : "終了"}
            </button>
            <button type="button" className="m-btn sub" onClick={() => void answer("without")}>
              位置なしで{ask.kind === "start" ? "開始" : "終了"}
            </button>
            <button type="button" className="m-btn sub" onClick={() => void answer("cancel")}>
              やめる
            </button>
          </div>
        </div>
      ) : null}
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {ctx ? (
        <>
          <p className="m-sub">今日は {formatDateJa(today)}。現場で「開始」「終了」を押してください。電波がなくても押せます。</p>
          <h2>今日</h2>
          {split.today.length === 0 ? <p>今日の予定はありません。</p> : split.today.map(row)}
          <h2>これから</h2>
          {split.later.length === 0 ? <p>これからの予定はありません。</p> : split.later.map(row)}
        </>
      ) : null}
    </ScheduleShell>
  );
}
