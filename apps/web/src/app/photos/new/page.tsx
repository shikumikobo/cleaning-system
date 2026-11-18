"use client";

// 現場の写真を撮る（スマホ）。カメラで撮ると、端末で縮小し（元の画像・小さな画像）、Exif の位置を消し、端末にためてから送る。
// 電波がなければ端末にため、戻ったら自動で送る。気づきは、そのまま案件にもできる（R-008-24〜27・31・37）。
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Field, Msg, PendingPhotos, PhotosShell } from "@/components/photos/Shell";
import { Loading } from "@/components/masters/Shell";
import { describeError } from "@/lib/errors";
import { selectableCandidates, sortAreas, sortRooms } from "@/lib/masters/format";
import { listAreas, listBuildings, listRooms } from "@/lib/masters/repo";
import type { Area, Building, Room } from "@/lib/masters/types";
import { KIND_OPTIONS, validateCapture } from "@/lib/photos/format";
import { processPhoto } from "@/lib/photos/process";
import { capturePhoto } from "@/lib/photos/queue";
import type { PhotoKind } from "@/lib/photos/types";
import { usePhotoEnv } from "@/lib/photos/usePhotoEnv";
import { CATEGORY_OPTIONS } from "@/lib/requests/format";
import { enqueueObservation } from "@/lib/requests/observation";

function NewPhotoBody() {
  const params = useSearchParams();
  const { env, error, pending } = usePhotoEnv();
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [building, setBuilding] = useState(params.get("building") ?? "");
  const [kind, setKind] = useState<PhotoKind>("before");
  const [area, setArea] = useState("");
  const [room, setRoom] = useState("");
  const [makeRequest, setMakeRequest] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [category, setCategory] = useState("other");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canRecord = env ? env.session.perms.includes("field.record") : false;

  useEffect(() => {
    if (!env) return;
    let cancelled = false;
    void listBuildings(env.client, env.session.tenantId)
      .then((b) => !cancelled && setBuildings(b))
      .catch((e) => !cancelled && setMsg(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [env]);

  useEffect(() => {
    if (!env || !building) {
      setAreas([]);
      setRooms([]);
      return;
    }
    let cancelled = false;
    void Promise.all([listAreas(env.client, building), listRooms(env.client, building)])
      .then(([a, r]) => {
        if (cancelled) return;
        setAreas(sortAreas(selectableCandidates(a)));
        setRooms(sortRooms(selectableCandidates(r)));
      })
      .catch(() => !cancelled && (setAreas([]), setRooms([])));
    return () => {
      cancelled = true;
    };
  }, [env, building]);

  async function onPick(file: File | null) {
    if (!file || !env) return;
    setMsg(null);
    setOk(null);
    const errs = validateCapture({ building_id: building, kind, makeRequest, title });
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      if (input.current) input.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const takenAt = new Date().toISOString();
      const processed = await processPhoto(file); // 端末で縮小し、Exif の位置を消す
      const requestId = kind === "observation" && makeRequest ? crypto.randomUUID() : null;
      if (requestId) {
        // 案件の気づきを先にためる（送るときも、案件が先に届いてから写真の行を送る）
        await enqueueObservation(env.box, { tenantId: env.session.tenantId, membershipId: env.session.membershipId }, {
          id: requestId,
          building_id: building,
          title,
          detail,
          room_id: room,
          category,
        });
      }
      await capturePhoto(env.queue, { tenantId: env.session.tenantId, membershipId: env.session.membershipId }, {
        building_id: building,
        area_id: area || null,
        room_id: room || null,
        kind,
        taken_at: takenAt,
        request_id: requestId,
        processed,
      });
      await env.sync();
      const left = await env.queue.count();
      setOk(left === 0 ? (requestId ? "撮って、案件にしました" : "撮りました") : "電波がないので、端末にためました。電波が戻ると自動で送ります");
      if (requestId) {
        setTitle("");
        setDetail("");
        setMakeRequest(false);
      }
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  if (!env) return <Loading error={error} ctx={null} />;
  return (
    <>
      <Msg error={msg} ok={ok} />
      <PendingPhotos pending={pending} queue={env.queue} onSync={() => void env.sync()} />
      {!canRecord ? <p>写真を撮れるのは、現場の記録の権限がある人です。</p> : null}
      {canRecord ? (
        <div className="m-form">
          <Field label="建物" error={errors.building_id}>
            <select value={building} onChange={(e) => (setBuilding(e.target.value), setArea(""), setRoom(""))} aria-label="建物">
              <option value="">選んでください</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="種類">
            <select value={kind} onChange={(e) => setKind(e.target.value as PhotoKind)} aria-label="種類">
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="場所（なくてもよい）">
            <select value={area} onChange={(e) => setArea(e.target.value)} disabled={!building} aria-label="場所">
              <option value="">なし</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="部屋（なくてもよい）">
            <select value={room} onChange={(e) => setRoom(e.target.value)} disabled={!building} aria-label="部屋">
              <option value="">なし</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.room_no}
                </option>
              ))}
            </select>
          </Field>
          {kind === "observation" ? (
            <>
              <label className="m-row">
                <input type="checkbox" checked={makeRequest} onChange={(e) => setMakeRequest(e.target.checked)} />
                この気づきを案件にもする
              </label>
              {makeRequest ? (
                <>
                  <Field label="気づいたこと（題名）" error={errors.title}>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" maxLength={100} aria-label="題名" />
                  </Field>
                  <Field label="くわしく（なくてもよい）">
                    <textarea value={detail} onChange={(e) => setDetail(e.target.value)} aria-label="くわしく" />
                  </Field>
                  <Field label="分類">
                    <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分類">
                      {CATEGORY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              ) : null}
            </>
          ) : null}
          <div className="m-field">
            <label htmlFor="photo-shot">写真を撮る</label>
            <input
              id="photo-shot"
              ref={input}
              className="p-shot"
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy}
              onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function NewPhotoPage() {
  return (
    <PhotosShell title="写真を撮る" active="new">
      <Suspense fallback={<p>読み込み中…</p>}>
        <NewPhotoBody />
      </Suspense>
    </PhotosShell>
  );
}
