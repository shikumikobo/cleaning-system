"use client";

// 写真の一覧：建物・日・案件・作業・種類で絞り込む。一覧は小さな画像だけを読む（R-008-29・32）。
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loading } from "@/components/masters/Shell";
import { Msg, PendingPhotos, PhotosShell } from "@/components/photos/Shell";
import { describeError } from "@/lib/errors";
import { listBuildings } from "@/lib/masters/repo";
import type { Building } from "@/lib/masters/types";
import { groupByDay, KIND_OPTIONS, kindLabel, sortPhotos } from "@/lib/photos/format";
import { listPhotos, signPhotoUrls } from "@/lib/photos/repo";
import type { PhotoRow } from "@/lib/photos/types";
import { usePhotoEnv } from "@/lib/photos/usePhotoEnv";

function time(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function ListBody() {
  const params = useSearchParams();
  const [building, setBuilding] = useState(params.get("building") ?? "");
  const [day, setDay] = useState(params.get("day") ?? "");
  const [kind, setKind] = useState(params.get("kind") ?? "");
  const request = params.get("request") ?? "";
  const work = params.get("work") ?? "";
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [rows, setRows] = useState<PhotoRow[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const { env, error, pending } = usePhotoEnv(() => setVersion((v) => v + 1));

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
    if (!env) return;
    try {
      const list = sortPhotos(await listPhotos(env.client, env.session.tenantId, { building, day, kind, request, work }));
      setRows(list);
      setMsg(null);
      setLoaded(true);
      // 一覧は小さな画像だけを読む（元の画像は、詳細で開いたときだけ）
      if (list.length > 0) {
        const s = await signPhotoUrls(env.client, list.map((r) => r.id), "thumb");
        setThumbs(s.urls);
      } else setThumbs({});
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [env, building, day, kind, request, work]);
  useEffect(() => {
    void load();
  }, [load, version]);

  const names = useMemo(() => new Map(buildings.map((b) => [b.id, b.name])), [buildings]);
  const groups = useMemo(() => groupByDay(rows), [rows]);

  if (!env) return <Loading error={error} ctx={null} />;
  return (
    <>
      <Msg error={msg} ok={null} />
      <PendingPhotos pending={pending} queue={env.queue} onSync={() => void env.sync()} />
      <div className="p-filters">
        <select value={building} onChange={(e) => setBuilding(e.target.value)} aria-label="建物">
          <option value="">すべての建物</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="日" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="種類">
          <option value="">すべての種類</option>
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {request ? <p className="m-sub">案件で絞り込んでいます。<Link href="/photos/">絞り込みを外す</Link></p> : null}
      {work ? <p className="m-sub">作業で絞り込んでいます。<Link href="/photos/">絞り込みを外す</Link></p> : null}
      {loaded && rows.length === 0 ? <p>写真はありません。</p> : null}
      {groups.map((g) => (
        <section key={g.day} aria-label={g.day}>
          <h2 className="p-day">{g.day}</h2>
          <div className="p-grid">
            {g.photos.map((p) => (
              <Link key={p.id} className="p-cell" href={`/photos/detail/?id=${p.id}`} data-testid="photo-cell">
                {thumbs[p.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbs[p.id]} alt={`${kindLabel(p.kind)} ${time(p.taken_at)}`} loading="lazy" />
                ) : (
                  <span className="p-ph">読み込み中</span>
                )}
                <span className="p-meta">
                  {kindLabel(p.kind)}・{time(p.taken_at)}
                  <br />
                  {names.get(p.building_id) ?? ""}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export default function PhotosPage() {
  return (
    <PhotosShell title="現場の写真" active="list">
      <Suspense fallback={<p>読み込み中…</p>}>
        <ListBody />
      </Suspense>
      <p>
        <Link href="/photos/request/">気づきの写真から案件を作る</Link>
      </p>
    </PhotosShell>
  );
}
