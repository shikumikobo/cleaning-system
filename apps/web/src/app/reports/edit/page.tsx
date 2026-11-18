"use client";

// スマホで報告書を作る（R-009-32）：作業を開くと、ひな形の項目が並んだ報告書がすぐ作れる。
// 項目のチェック・メモ・前と後の写真・全体のメモと気づき（写真）を入れる。変えるたびに端末にため、電波があれば送る。
// 確認・提出のあとは固定され、読むだけ。電波がないときは、端末にためた件数を出し、戻ったら自動で送る。
import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loading, Notice, ReportShell } from "@/components/reports/Shell";
import { PendingPhotos } from "@/components/photos/Shell";
import { getDeviceId } from "@/lib/offline";
import { describeError } from "@/lib/errors";
import { formatDateJa } from "@/lib/quotes/format";
import { getBuilding } from "@/lib/masters/repo";
import { kindLabel } from "@/lib/photos/format";
import { processPhoto } from "@/lib/photos/process";
import { capturePhoto } from "@/lib/photos/queue";
import { listPhotos, signPhotoUrls } from "@/lib/photos/repo";
import type { PhotoKind, PhotoRow } from "@/lib/photos/types";
import { usePhotoEnv, type PhotoEnv } from "@/lib/photos/usePhotoEnv";
import { buildReportDraft, isLocked, progressLabel, reportStatusLabel, sortReportItems } from "@/lib/reports/format";
import { flushReports, openReportQueue, type QueuedReport, type ReportQueue } from "@/lib/reports/queue";
import {
  createReportSender,
  getReportOfWork,
  getWork,
  listReportItems,
  listTemplateItems,
  type WorkRef,
} from "@/lib/reports/repo";
import type { ReportDraft, ReportStatus } from "@/lib/reports/types";
import "@/components/reports/reports.css";

function EditBody() {
  const workId = useSearchParams().get("work") ?? "";
  const rq = useRef<ReportQueue | null>(null);
  const [queued, setQueued] = useState<QueuedReport[]>([]);
  const { env, error, pending } = usePhotoEnv(undefined, async (client) => {
    if (rq.current) await flushReports(rq.current, createReportSender(client));
  });

  const [work, setWork] = useState<WorkRef | null>(null);
  const [buildingName, setBuildingName] = useState("");
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [status, setStatus] = useState<ReportStatus>("draft");
  const [baseVersion, setBaseVersion] = useState(1);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draftRef = useRef<ReportDraft | null>(null);
  draftRef.current = draft;
  const versionRef = useRef(1);
  versionRef.current = baseVersion;
  const serverRemarksRef = useRef("");

  // 報告書の端末の入れ物を開く（ためた件数を見せる）
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    void openReportQueue().then(async (q) => {
      if (cancelled) return;
      rq.current = q;
      const refresh = async () => !cancelled && setQueued(await q.list());
      unsub = q.subscribe(() => void refresh());
      await refresh();
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const loadPhotos = useCallback(
    async (e: PhotoEnv, w: WorkRef) => {
      const list = await listPhotos(e.client, e.session.tenantId, { work: w.id });
      setPhotos(list);
      setUrls(list.length > 0 ? (await signPhotoUrls(e.client, list.map((p) => p.id), "thumb")).urls : {});
    },
    [],
  );

  // 作業・報告書（端末にためたものを先に）・ひな形から、下書きを用意する
  useEffect(() => {
    if (!env || !workId) return;
    let cancelled = false;
    void (async () => {
      try {
        // 入れ物が開くのを待つ
        for (let i = 0; i < 50 && !rq.current; i++) await new Promise((r) => setTimeout(r, 40));
        const q = rq.current;
        if (!q) throw new Error("端末の入れ物を開けませんでした");
        const tenantId = env.session.tenantId;
        const w = await getWork(env.client, tenantId, workId);
        if (!w) {
          setMsg("この作業は見つかりません（消されたか、担当の作業ではありません）");
          return;
        }
        const server = await getReportOfWork(env.client, tenantId, w.id).catch(() => null);
        const local = (await q.list()).find((x) => x.draft.report.work_id === w.id);
        const b = await getBuilding(env.client, tenantId, w.building_id).catch(() => null);
        let d: ReportDraft;
        let version = 1;
        let st: ReportStatus = "draft";
        if (local) {
          d = local.draft;
          version = local.baseVersion;
          st = server?.status ?? "draft";
        } else if (server) {
          const items = await listReportItems(env.client, tenantId, server.id);
          d = {
            report: { id: server.id, tenant_id: tenantId, work_id: w.id, template_id: server.template_id, remarks: server.remarks, client_created_at: server.created_at, device_id: null },
            items: items.map((i) => ({
              id: i.id, tenant_id: tenantId, report_id: server.id, template_item_id: i.template_item_id, area_id: i.area_id, name: i.name, sort: i.sort,
              done: i.done, note: i.note, client_created_at: server.created_at, device_id: null,
            })),
          };
          version = server.version;
          st = server.status;
        } else {
          const tItems = w.report_template_id ? await listTemplateItems(env.client, tenantId, [w.report_template_id]).catch(() => []) : [];
          d = buildReportDraft({ tenantId, work: w, templateItems: tItems, deviceId: await getDeviceId() });
        }
        if (cancelled) return;
        setWork(w);
        setBuildingName(b?.name ?? "");
        setDraft(d);
        setBaseVersion(version);
        serverRemarksRef.current = local ? local.serverRemarks : server?.remarks ?? "";
        setStatus(st);
        await loadPhotos(env, w).catch(() => undefined);
      } catch (e) {
        if (!cancelled) setMsg(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [env, workId, loadPhotos]);

  /** 端末にためて、送る（変えるたびに呼ぶ。電波がなければ、ためたまま） */
  const persist = useCallback(
    async (d: ReportDraft) => {
      if (!env || !rq.current) return;
      await rq.current.save(d, { tenantId: env.session.tenantId, baseVersion: versionRef.current, serverRemarks: serverRemarksRef.current });
      try {
        const r = await flushReports(rq.current, createReportSender(env.client));
        const done = r.synced[d.report.id]; // 送れたら、次の保存の条件（サーバーの版とメモ）にする
        if (done) {
          versionRef.current = done.version;
          serverRemarksRef.current = done.remarks;
        }
        await env.sync();
      } catch {
        /* ためたままにして、あとで送る */
      }
    },
    [env],
  );

  function change(next: ReportDraft, save: boolean) {
    setDraft(next);
    if (save) void persist(next);
  }

  async function onShot(file: File | null, kind: PhotoKind, itemId: string | null) {
    const d = draftRef.current;
    if (!file || !env || !work || !d) return;
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      await persist(d); // 項目の行が先に届くよう、報告書を先にためて送る
      const takenAt = new Date().toISOString();
      const processed = await processPhoto(file); // 端末で縮小し、Exif の位置を消す
      const item = d.items.find((i) => i.id === itemId);
      await capturePhoto(env.queue, { tenantId: env.session.tenantId, membershipId: env.session.membershipId }, {
        building_id: work.building_id,
        area_id: item?.area_id ?? null,
        kind,
        taken_at: takenAt,
        work_id: work.id,
        report_item_id: itemId,
        processed,
      });
      await env.sync();
      await loadPhotos(env, work).catch(() => undefined);
      setOk((await env.queue.count()) === 0 ? "写真を撮りました" : "電波がないので、端末にためました。電波が戻ると自動で送ります");
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveNow() {
    const d = draftRef.current;
    if (!d) return;
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      await persist(d);
      setOk((await rq.current?.count()) === 0 ? "送りました" : "端末にためました。電波が戻ると自動で送ります");
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!workId) return <p>作業が選ばれていません。</p>;
  if (!env) return <Loading error={error} ctx={null} />;
  const locked = isLocked(status);
  const items = draft ? sortReportItems(draft.items) : [];
  const canRecord = env.session.perms.includes("field.record");
  const stuck = queued.filter((q) => q.attempts > 0);
  return (
    <>
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {queued.length > 0 ? (
        <div className="r-pending" role="status" data-testid="pending-reports">
          <strong>送れていない報告書：{queued.length} 件</strong>
          <span className="m-sub">電波が戻ると、自動で送ります。送れるまで、この端末から消えません。</span>
          <button type="button" className="m-btn sub" onClick={() => void saveNow()}>
            今すぐ送る
          </button>
          {stuck.map((q) => (
            <p key={q.id} className="m-sub" data-testid="stuck-report">
              サーバーに断られました（{q.lastError ?? describeError({ code: q.lastCode })}）
              <button
                type="button"
                className="m-btn danger"
                onClick={() => {
                  if (window.confirm("この報告書の、端末の分を消しますか？ サーバーには届いていないので、元に戻せません")) void rq.current?.remove(q.id);
                }}
              >
                あきらめて消す
              </button>
            </p>
          ))}
        </div>
      ) : null}
      <PendingPhotos pending={pending} queue={env.queue} onSync={() => void env.sync()} />
      {work && draft ? (
        <>
          <p>
            <span className={`r-status ${status}`} data-testid="report-status">
              {reportStatusLabel(status)}
            </span>
            {formatDateJa(work.scheduled_date)} ／ {buildingName} ／ {work.title}
          </p>
          <p className="m-sub">チェック {progressLabel(items)}</p>
          {locked ? <p className="m-msg">確認・提出のあとなので、直せません（読むだけです）。直すときは、社員に下書きへ戻してもらってください。</p> : null}
          {!locked && !canRecord ? <p className="m-msg">報告書を作れるのは、現場の記録の権限がある人です。</p> : null}
          {items.map((i) => (
            <div key={i.id} className={`r-item${i.done ? " done" : ""}`} data-testid="report-item">
              <label className="r-check">
                <input
                  type="checkbox"
                  checked={i.done}
                  disabled={locked || !canRecord}
                  aria-label={`${i.name}をチェック`}
                  onChange={(e) => change({ ...draft, items: draft.items.map((x) => (x.id === i.id ? { ...x, done: e.target.checked } : x)) }, true)}
                />
                {i.name}
              </label>
              <textarea
                aria-label={`${i.name}のメモ`}
                placeholder="メモ（なくてもよい）"
                value={i.note}
                disabled={locked || !canRecord}
                maxLength={2000}
                onChange={(e) => change({ ...draft, items: draft.items.map((x) => (x.id === i.id ? { ...x, note: e.target.value } : x)) }, false)}
                onBlur={() => void persist(draftRef.current!)}
              />
              {!locked && canRecord ? (
                <div className="r-shots">
                  {(["before", "after"] as const).map((k) => (
                    <label key={k} className="r-shot">
                      {kindLabel(k)}を撮る
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        aria-label={`${i.name}の${kindLabel(k)}の写真`}
                        disabled={busy}
                        onChange={(e) => {
                          void onShot(e.target.files?.[0] ?? null, k, i.id);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="r-thumbs">
                {photos
                  .filter((p) => p.report_item_id === i.id)
                  .map((p) =>
                    urls[p.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={p.id} src={urls[p.id]} alt={`${i.name}の${kindLabel(p.kind)}の写真`} />
                    ) : (
                      <span key={p.id} className="m-sub">{kindLabel(p.kind)}</span>
                    ),
                  )}
              </div>
            </div>
          ))}
          <div className="m-field">
            <label htmlFor="r-remarks">全体のメモ・気づき</label>
            <textarea
              id="r-remarks"
              value={draft.report.remarks}
              disabled={locked || !canRecord}
              maxLength={4000}
              onChange={(e) => change({ ...draft, report: { ...draft.report, remarks: e.target.value } }, false)}
              onBlur={() => void persist(draftRef.current!)}
            />
          </div>
          {!locked && canRecord ? (
            <div className="r-shots" style={{ margin: "8px 0 16px" }}>
              <label className="r-shot">
                気づきを撮る
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  aria-label="気づきの写真"
                  disabled={busy}
                  onChange={(e) => {
                    void onShot(e.target.files?.[0] ?? null, "observation", null);
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="m-sub">気づきの写真は、あとから案件にできます（写真の画面）。</span>
            </div>
          ) : null}
          <div className="m-row">
            {!locked && canRecord ? (
              <button type="button" className="m-btn" disabled={busy} onClick={() => void saveNow()}>
                保存して送る
              </button>
            ) : null}
            <Link href="/reports/" className="m-btn sub" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              一覧へ
            </Link>
          </div>
        </>
      ) : null}
    </>
  );
}

export default function EditPage() {
  return (
    <ReportShell title="報告書" active="reports">
      <Suspense fallback={<p>読み込み中…</p>}>
        <EditBody />
      </Suspense>
    </ReportShell>
  );
}
