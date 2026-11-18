"use client";

// 気づきの写真から案件を作る（R-008-36）：建物を選び、まだ案件に付いていない気づきの写真を選んで、題名などを入れる。
// 003 の RPC（create_request_from_observation）に写真の ID を渡す。写真の側に request_id が入る。
import Link from "next/link";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Field, Loading } from "@/components/masters/Shell";
import { Msg, PhotosShell } from "@/components/photos/Shell";
import { describeError } from "@/lib/errors";
import { selectableCandidates, sortRooms } from "@/lib/masters/format";
import { listBuildings, listRooms } from "@/lib/masters/repo";
import type { Building, Room } from "@/lib/masters/types";
import { kindLabel, sortPhotos, validateCapture } from "@/lib/photos/format";
import { createRequestFromPhotos, listPhotos, signPhotoUrls } from "@/lib/photos/repo";
import type { PhotoRow } from "@/lib/photos/types";
import { usePhotoEnv } from "@/lib/photos/usePhotoEnv";
import { CATEGORY_OPTIONS } from "@/lib/requests/format";

function RequestBody() {
  const params = useSearchParams();
  const router = useRouter();
  const { env, error } = usePhotoEnv();
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [building, setBuilding] = useState(params.get("building") ?? "");
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>(params.get("photo") ? [params.get("photo") as string] : []);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [room, setRoom] = useState("");
  const [category, setCategory] = useState("other");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const load = useCallback(async () => {
    if (!env || !building) {
      setPhotos([]);
      setRooms([]);
      return;
    }
    try {
      // まだ案件に付いていない、気づきの写真だけ
      const list = sortPhotos((await listPhotos(env.client, env.session.tenantId, { building, kind: "observation" })).filter((p) => !p.request_id));
      setPhotos(list);
      const r = await listRooms(env.client, building);
      setRooms(sortRooms(selectableCandidates(r)));
      setThumbs(list.length > 0 ? (await signPhotoUrls(env.client, list.map((p) => p.id), "thumb")).urls : {});
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [env, building]);
  useEffect(() => {
    void load();
  }, [load]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!env) return;
    setMsg(null);
    const errs = validateCapture({ building_id: building, kind: "observation", makeRequest: true, title });
    if (picked.length === 0) errs.photos = "写真を1枚以上選んでください";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const r = await createRequestFromPhotos(env.client, { id: crypto.randomUUID(), building_id: building, title, detail, room_id: room, category, photo_ids: picked });
      router.replace(`/requests/detail/?id=${r.id}`);
    } catch (err) {
      setMsg(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!env) return <Loading error={error} ctx={null} />;
  return (
    <>
      <Msg error={msg} ok={null} />
      <form className="m-form" onSubmit={onSubmit} noValidate>
        <Field label="建物" error={errors.building_id}>
          <select value={building} onChange={(e) => (setBuilding(e.target.value), setPicked([]), setRoom(""))} aria-label="建物">
            <option value="">選んでください</option>
            {buildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        {building ? (
          <Field label="案件につなぐ気づきの写真" error={errors.photos}>
            {photos.length === 0 ? <p className="m-sub">案件に付いていない気づきの写真はありません。</p> : null}
            <div className="p-grid">
              {photos.map((p) => (
                <label key={p.id} className="p-cell" data-testid="observation-cell">
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
                    aria-label={`${kindLabel(p.kind)}の写真を選ぶ`}
                  />
                  {thumbs[p.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbs[p.id]} alt="気づきの写真" loading="lazy" />
                  ) : (
                    <span className="p-ph">読み込み中</span>
                  )}
                </label>
              ))}
            </div>
          </Field>
        ) : null}
        <Field label="気づいたこと（題名）" error={errors.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" maxLength={100} aria-label="題名" />
        </Field>
        <Field label="くわしく（なくてもよい）">
          <textarea value={detail} onChange={(e) => setDetail(e.target.value)} aria-label="くわしく" />
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
        <Field label="分類">
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分類">
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="m-row">
          <button className="m-btn" type="submit" disabled={busy}>
            案件にする
          </button>
        </div>
      </form>
    </>
  );
}

export default function PhotoRequestPage() {
  return (
    <PhotosShell title="気づきの写真から案件を作る" active="other">
      <Suspense fallback={<p>読み込み中…</p>}>
        <RequestBody />
      </Suspense>
      <p>
        <Link href="/photos/">写真の一覧へ</Link>
      </p>
    </PhotosShell>
  );
}
