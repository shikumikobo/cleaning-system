"use client";

// 写真の詳細：元の画像（期限つきの URL）・撮った日時と人と場所・種類と場所の直し・消す・案件へ（R-008-33〜35）。
// 直す・消すを出すのは撮った本人だけ（作業の担当の判定は DB。出さなくても DB が断る）。
import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Field, Loading } from "@/components/masters/Shell";
import { Msg, PhotosShell } from "@/components/photos/Shell";
import { describeError } from "@/lib/errors";
import { selectableCandidates, sortAreas, sortRooms } from "@/lib/masters/format";
import { getBuilding, listAreas, listRooms } from "@/lib/masters/repo";
import type { Area, Building, Room } from "@/lib/masters/types";
import { jstDay, KIND_OPTIONS, kindLabel, takenByMe } from "@/lib/photos/format";
import { deletePhoto, getPhoto, signPhotoUrls, updatePhoto } from "@/lib/photos/repo";
import type { PhotoKind, PhotoRow } from "@/lib/photos/types";
import { usePhotoEnv } from "@/lib/photos/usePhotoEnv";

function stamp(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${jstDay(iso)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function DetailBody() {
  const id = useSearchParams().get("id") ?? "";
  const { env, error } = usePhotoEnv();
  const [photo, setPhoto] = useState<PhotoRow | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [building, setBuilding] = useState<Building | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [kind, setKind] = useState<PhotoKind>("before");
  const [area, setArea] = useState("");
  const [room, setRoom] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!env || !id) return;
    try {
      const p = await getPhoto(env.client, env.session.tenantId, id);
      if (!p) {
        setMsg("この写真は見つかりません（消されたか、見られない写真です）");
        return;
      }
      setPhoto(p);
      setKind(p.kind);
      setArea(p.area_id ?? "");
      setRoom(p.room_id ?? "");
      const [b, a, r, s] = await Promise.all([
        getBuilding(env.client, env.session.tenantId, p.building_id),
        listAreas(env.client, p.building_id),
        listRooms(env.client, p.building_id),
        signPhotoUrls(env.client, [p.id], "original"), // 元の画像は、ここで開くときだけ読む
      ]);
      setBuilding(b);
      setAreas(sortAreas(selectableCandidates(a)));
      setRooms(sortRooms(selectableCandidates(r)));
      setUrl(s.urls[p.id] ?? null);
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [env, id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      await fn();
      setOk(done);
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!env) return <Loading error={error} ctx={null} />;
  if (gone) {
    return (
      <>
        <Msg error={null} ok="消しました" />
        <p>
          <Link href="/photos/">写真の一覧へ</Link>
        </p>
      </>
    );
  }
  const mine = photo ? takenByMe(photo, env.session.membershipId) : false;
  const areaName = areas.find((a) => a.id === photo?.area_id)?.name;
  const roomNo = rooms.find((r) => r.id === photo?.room_id)?.room_no;
  return (
    <>
      <Msg error={msg} ok={ok} />
      {photo ? (
        <>
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="p-full" src={url} alt={`${kindLabel(photo.kind)}の写真`} width={photo.width} height={photo.height} />
          ) : (
            <p>画像を読み込めませんでした。</p>
          )}
          <dl className="m-sub" data-testid="photo-info">
            <div>種類：{kindLabel(photo.kind)}</div>
            <div>撮った日時：{stamp(photo.taken_at)}</div>
            <div>建物：{building?.name ?? ""}</div>
            <div>場所：{areaName ?? "なし"}</div>
            <div>部屋：{roomNo ?? "なし"}</div>
          </dl>
          {photo.request_id ? (
            <p>
              <Link href={`/requests/detail/?id=${photo.request_id}`}>つながっている案件を見る</Link>
            </p>
          ) : photo.kind === "observation" ? (
            <p>
              <Link href={`/photos/request/?building=${photo.building_id}&photo=${photo.id}`}>この気づきを案件にする</Link>
            </p>
          ) : null}
          {mine ? (
            <div className="m-form">
              <Field label="種類">
                <select value={kind} onChange={(e) => setKind(e.target.value as PhotoKind)} aria-label="種類を直す">
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="場所">
                <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="場所を直す">
                  <option value="">なし</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="部屋">
                <select value={room} onChange={(e) => setRoom(e.target.value)} aria-label="部屋を直す">
                  <option value="">なし</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.room_no}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="m-row">
                <button
                  type="button"
                  className="m-btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setPhoto(await updatePhoto(env.client, photo.id, { kind, area_id: area || null, room_id: room || null }));
                    }, "保存しました")
                  }
                >
                  保存する
                </button>
                <button
                  type="button"
                  className="m-btn danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("この写真を消しますか？")) void run(async () => (await deletePhoto(env.client, photo.id), setGone(true)), "消しました");
                  }}
                >
                  消す
                </button>
              </div>
            </div>
          ) : (
            <p className="m-sub">種類と場所を直せるのは、撮った本人（作業の担当）です。</p>
          )}
        </>
      ) : null}
    </>
  );
}

export default function PhotoDetailPage() {
  return (
    <PhotosShell title="写真" active="other">
      <Suspense fallback={<p>読み込み中…</p>}>
        <DetailBody />
      </Suspense>
    </PhotosShell>
  );
}
