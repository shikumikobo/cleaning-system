"use client";

// 地図の表示（機能 013）。Leaflet（BSD-2 の地図の部品）を、この画面を開いたときだけ読み込む（R-013-29。ほかの画面を重くしない）。
// タイルは OpenStreetMap などの地図の画像。帰属の表示は、呼ぶ画面が地図の下に必ず出す（MAP_ATTRIBUTION）。
// 印は画像を使わない（div の印。バンドラーで画像の道がずれないように）。
import { useEffect, useRef } from "react";
import type { Map as LeafletMap, LayerGroup, Marker, TileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";
import { boundsOf, DEFAULT_CENTER, type LatLng, type MapMarker } from "@/lib/map/geo";
import "./map.css";

export interface MapViewProps {
  markers: MapMarker[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  tileUrl: string;
  /** 位置を直しているとき：地図を押した場所を決める */
  pick?: { point: LatLng | null; onPick: (p: LatLng) => void } | null;
  /** 位置を直しているとき：今の位置（印のない建物では null） */
  current?: LatLng | null;
}

type Leaflet = typeof import("leaflet");

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function MapView({ markers, selectedId, onSelect, tileUrl, pick, current }: MapViewProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const L = useRef<Leaflet | null>(null);
  const map = useRef<LeafletMap | null>(null);
  const tiles = useRef<TileLayer | null>(null);
  const layer = useRef<LayerGroup | null>(null);
  const pickLayer = useRef<LayerGroup | null>(null);
  const fitted = useRef<string>("");
  const cb = useRef({ onSelect, onPick: pick?.onPick });
  cb.current = { onSelect, onPick: pick?.onPick };
  const picking = !!pick;

  // 地図を作る（この画面を開いたときだけ Leaflet を読む）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mod = await import("leaflet");
      if (cancelled || !host.current) return;
      const lf = ((mod as unknown as { default?: Leaflet }).default ?? mod) as Leaflet;
      L.current = lf;
      const m = lf.map(host.current, { zoomControl: true, attributionControl: false }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 5);
      tiles.current = lf.tileLayer(tileUrl, { maxZoom: 19 }).addTo(m);
      layer.current = lf.layerGroup().addTo(m);
      pickLayer.current = lf.layerGroup().addTo(m);
      m.on("click", (e) => cb.current.onPick?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
      map.current = m;
      host.current.setAttribute("data-map-ready", "true");
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      layer.current = null;
      pickLayer.current = null;
      tiles.current = null;
    };
    // 地図は 1 回だけ作る（タイルの URL は作るときの値）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 建物の印
  useEffect(() => {
    let alive = true;
    const draw = () => {
      const lf = L.current;
      const m = map.current;
      const g = layer.current;
      if (!lf || !m || !g) {
        if (alive) setTimeout(draw, 50); // 地図の用意ができるまで待つ
        return;
      }
      g.clearLayers();
      for (const k of markers) {
        const sel = k.id === selectedId;
        const icon = lf.divIcon({
          className: `map-pin${sel ? " sel" : ""}${k.works > 0 ? " has-work" : ""}`,
          html: `<span data-marker-id="${escapeHtml(k.id)}" role="button" aria-label="${escapeHtml(k.label)}">${k.works > 0 ? k.works : ""}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });
        const mk: Marker = lf.marker([k.lat, k.lng], { icon, title: k.label, keyboard: true });
        mk.on("click", () => cb.current.onSelect(k.id));
        mk.addTo(g);
      }
      // 印の入れ替わりのときだけ、範囲に合わせる（選んだだけでは動かさない）
      const key = markers.map((k) => k.id).join(",");
      if (key !== fitted.current) {
        fitted.current = key;
        const b = boundsOf(markers);
        if (b) {
          if (markers.length === 1) m.setView([markers[0].lat, markers[0].lng], 16);
          else m.fitBounds([[b[0].lat, b[0].lng], [b[1].lat, b[1].lng]], { padding: [30, 30], maxZoom: 17 });
        }
      }
    };
    draw();
    return () => {
      alive = false;
    };
  }, [markers, selectedId]);

  // 位置を直しているときの、今の位置と新しい位置
  useEffect(() => {
    let alive = true;
    const draw = () => {
      const lf = L.current;
      const m = map.current;
      const g = pickLayer.current;
      if (!lf || !m || !g) {
        if (alive) setTimeout(draw, 50);
        return;
      }
      g.clearLayers();
      if (current) {
        lf.circleMarker([current.lat, current.lng], { radius: 8, color: "#6b7280", weight: 2, fillOpacity: 0.2 }).addTo(g);
      }
      if (pick?.point) {
        const icon = lf.divIcon({ className: "map-pin pick", html: '<span data-marker-id="pick" aria-label="新しい位置"></span>', iconSize: [30, 30], iconAnchor: [15, 15] });
        lf.marker([pick.point.lat, pick.point.lng], { icon, title: "新しい位置" }).addTo(g);
        m.panTo([pick.point.lat, pick.point.lng]);
      }
    };
    draw();
    return () => {
      alive = false;
    };
  }, [pick?.point, current, picking]);

  return <div ref={host} className={`map-box${picking ? " picking" : ""}`} role="application" aria-label="地図" data-map="true" />;
}
