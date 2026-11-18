"use client";

// 地図（機能 013、R-013-21〜25）：建物と、その日の作業の場所を地図に出す。選んだ建物のカルテ・道案内。
// 社員（master.edit）は、ずれた位置を地図で直せる。位置を求める外の API は Edge Function の向こう（候補を返すだけ。保存はここで行う）。
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { MapView } from "@/components/map/MapView";
import { useMapCtx, type MapCtx } from "@/components/map/useMapCtx";
import { Loading, Notice } from "@/components/masters/Shell";
import { describeError } from "@/lib/errors";
import { appleMapsUrl, ATTRIBUTION_URL, buildingMarkers, countByBuilding, dayWorks, directionsUrl, distanceM, formatDistance, formatLatLng, MAP_ATTRIBUTION, tileUrl, type LatLng } from "@/lib/map/geo";
import { requestGeocode, resetBuildingPosition, saveBuildingPosition } from "@/lib/map/repo";
import { getKarte, listBuildings } from "@/lib/masters/repo";
import type { Building, Karte } from "@/lib/masters/types";
import { formatDateJa, todayJst } from "@/lib/quotes/format";
import { timeRange } from "@/lib/schedule/format";
import { listWorksInRange } from "@/lib/schedule/repo";
import type { WorkRow } from "@/lib/schedule/types";
import "@/components/masters/masters.css";
import "@/components/map/map.css";

type Mode = "day" | "all";

function KarteView({ karte }: { karte: Karte | null }) {
  if (!karte) return <p className="m-sub">建物カルテはまだありません。</p>;
  const rows: Array<[string, string | null]> = [
    ["入り方", karte.entry],
    ["鍵の場所", karte.key_place],
    ["駐車場", karte.parking],
    ["ごみの日", karte.garbage_days],
    ["管理者の連絡", karte.manager_contact],
    ["注意", karte.cautions],
  ];
  return (
    <dl className="map-karte" aria-label="建物カルテ">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v || "―"}</dd>
        </div>
      ))}
    </dl>
  );
}

function MapBody({ ctx }: { ctx: MapCtx }) {
  const params = useSearchParams();
  const qBuilding = params.get("building");
  const qDate = params.get("date");
  const [mode, setMode] = useState<Mode>(qDate ? "day" : qBuilding ? "all" : "day");
  const [date, setDate] = useState(qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : todayJst());
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [works, setWorks] = useState<WorkRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(qBuilding);
  const [karte, setKarte] = useState<Karte | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [pick, setPick] = useState<LatLng | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadBuildings = useCallback(async () => {
    try {
      setBuildings(await listBuildings(ctx.sb, ctx.tenantId));
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [ctx]);

  useEffect(() => {
    void reloadBuildings();
  }, [reloadBuildings]);

  useEffect(() => {
    let cancelled = false;
    listWorksInRange(ctx.sb, ctx.tenantId, date, date)
      .then((w) => !cancelled && setWorks(w))
      .catch((e) => !cancelled && setMsg(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [ctx, date]);

  useEffect(() => {
    if (!selectedId) {
      setKarte(null);
      return;
    }
    let cancelled = false;
    getKarte(ctx.sb, selectedId)
      .then((k) => !cancelled && setKarte(k))
      .catch(() => !cancelled && setKarte(null)); // カルテが読めなくても、地図は使える
    return () => {
      cancelled = true;
    };
  }, [ctx, selectedId]);

  const today = useMemo(() => dayWorks(works, date, (w) => w.scheduled_date), [works, date]);
  const counts = useMemo(() => countByBuilding(today), [today]);
  const byId = useMemo(() => new Map(buildings.map((b) => [b.id, b])), [buildings]);
  const shownBuildings = useMemo(() => (mode === "day" ? buildings.filter((b) => counts[b.id]) : buildings), [mode, buildings, counts]);
  const markers = useMemo(() => buildingMarkers(shownBuildings, counts), [shownBuildings, counts]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const current: LatLng | null = selected && selected.lat != null && selected.lng != null ? { lat: selected.lat, lng: selected.lng } : null;

  function select(id: string) {
    setSelectedId(id);
    setFixing(false);
    setPick(null);
    setOk(null);
  }

  async function searchAddress() {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await requestGeocode(ctx.sb, selected.id);
      if (r.found && r.lat != null && r.lng != null) {
        setPick({ lat: r.lat, lng: r.lng });
        setOk("住所から求めた位置を、地図に出しました。確かめて「この位置で保存」を押してください");
      } else {
        setMsg("住所から位置を求められませんでした。地図を押して位置を決めてください");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!selected || !pick) return;
    setBusy(true);
    setMsg(null);
    try {
      await saveBuildingPosition(ctx.sb, selected.id, pick.lat, pick.lng);
      setOk("位置を保存しました（直した位置は、自動では上書きされません）");
      setFixing(false);
      setPick(null);
      await reloadBuildings();
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function resetToAuto() {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    try {
      await resetBuildingPosition(ctx.sb, selected.id);
      setOk("位置を空に戻しました。次の定時の処理で、住所から求め直します");
      setFixing(false);
      setPick(null);
      await reloadBuildings();
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const moved = current && pick ? distanceM(current, pick) : null;

  return (
    <>
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      <div className="map-chips" role="group" aria-label="地図に出すもの">
        <button type="button" className="s-chip" aria-pressed={mode === "day"} onClick={() => setMode("day")}>
          その日の作業
        </button>
        <button type="button" className="s-chip" aria-pressed={mode === "all"} onClick={() => setMode("all")}>
          すべての建物
        </button>
      </div>
      {mode === "day" ? (
        <div className="m-row" style={{ marginBottom: 8 }}>
          <label htmlFor="map-date">日付</label>
          <input id="map-date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: "auto", minHeight: 44 }} />
          <button type="button" className="m-btn sub" onClick={() => setDate(todayJst())}>
            今日
          </button>
        </div>
      ) : null}
      <MapView
        markers={markers}
        selectedId={selectedId}
        onSelect={select}
        tileUrl={tileUrl({ NEXT_PUBLIC_MAP_TILE_URL: process.env.NEXT_PUBLIC_MAP_TILE_URL })}
        pick={fixing ? { point: pick, onPick: setPick } : null}
        current={fixing ? current : null}
      />
      <p className="map-attr">
        地図：
        <a href={ATTRIBUTION_URL} target="_blank" rel="noopener noreferrer">
          {MAP_ATTRIBUTION}
        </a>
      </p>

      {selected ? (
        <div className="map-panel" data-building={selected.id}>
          <h3>{selected.name}</h3>
          <div className="m-sub">{selected.address}</div>
          <div className="m-sub">位置：{formatLatLng(selected.lat, selected.lng)}{selected.location_fixed ? "（地図で直した位置）" : ""}</div>
          <div className="m-row" style={{ margin: "8px 0" }}>
            <a className="map-link" href={directionsUrl(selected)} target="_blank" rel="noopener noreferrer">
              道案内を開く
            </a>
            <a className="map-link sub" href={appleMapsUrl(selected)} target="_blank" rel="noopener noreferrer">
              Apple マップで開く
            </a>
            <Link className="map-link sub" href={`/buildings/edit/?id=${selected.id}`}>
              建物のカルテへ
            </Link>
          </div>
          <KarteView karte={karte} />
          {ctx.canEdit ? (
            fixing ? (
              <div data-fixing="true">
                <p className="m-sub">地図を押すと、新しい位置が決まります。住所から求めた位置を、候補にもできます。</p>
                <p role="status" data-pick={pick ? "set" : "none"}>
                  今の位置：{formatLatLng(selected.lat, selected.lng)} → 新しい位置：{pick ? formatLatLng(pick.lat, pick.lng) : "まだ決めていません"}
                  {moved != null ? `（${formatDistance(moved)}動きます）` : ""}
                </p>
                <div className="m-row">
                  <button type="button" className="m-btn" disabled={!pick || busy} onClick={() => void save()}>
                    この位置で保存
                  </button>
                  <button type="button" className="m-btn sub" disabled={busy} onClick={() => void searchAddress()}>
                    住所から求める
                  </button>
                  <button type="button" className="m-btn sub" disabled={busy} onClick={() => void resetToAuto()}>
                    住所から求め直す（自動に戻す）
                  </button>
                  <button type="button" className="m-btn sub" onClick={() => { setFixing(false); setPick(null); }}>
                    やめる
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="m-btn sub" onClick={() => { setFixing(true); setPick(null); setOk(null); }}>
                位置を直す
              </button>
            )
          ) : null}
        </div>
      ) : (
        <p className="m-sub">地図の印か、下の一覧から建物を選ぶと、カルテと道案内が出ます。</p>
      )}

      {mode === "day" ? (
        <>
          <h2>{formatDateJa(date)} の作業</h2>
          {today.length === 0 ? <p>この日の作業はありません。</p> : null}
          {today.map((w) => {
            const b = byId.get(w.building_id);
            return (
              <button key={w.id} type="button" className="m-card" style={{ width: "100%", textAlign: "left", background: "transparent", font: "inherit" }} data-work={w.id} onClick={() => select(w.building_id)}>
                <strong>
                  {timeRange(w.start_time, w.end_time)} {w.title}
                </strong>
                <span className="m-sub">
                  {b?.name ?? ""}
                  {b && b.lat == null ? "（位置なし）" : ""}
                </span>
              </button>
            );
          })}
        </>
      ) : (
        <>
          <h2>建物の一覧</h2>
          {buildings.length === 0 ? <p>建物はありません。</p> : null}
          {buildings.map((b) => (
            <button key={b.id} type="button" className="m-card" style={{ width: "100%", textAlign: "left", background: "transparent", font: "inherit" }} data-building-row={b.id} onClick={() => select(b.id)}>
              <strong>{b.name}</strong>
              <span className="m-sub">{b.address}</span>
              {b.lat == null ? <span className="m-badge off">位置なし</span> : null}
            </button>
          ))}
        </>
      )}
    </>
  );
}

function Inner() {
  const { ctx, error } = useMapCtx();
  return (
    <section>
      <h1>地図</h1>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      {ctx ? <MapBody ctx={ctx} /> : null}
    </section>
  );
}

export default function MapPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Inner />
    </Suspense>
  );
}
