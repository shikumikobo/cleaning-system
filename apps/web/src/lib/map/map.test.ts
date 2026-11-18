// 機能 013 の画面の部品：距離・道案内の URL・地図に出すもの・了承と位置の取得・位置つきの開始/終了のため方・位置を直す層
// （R-013-15・18・21〜29。DB 側は supabase/tests/26_map.sql。Edge Function の判断は geocode-run.test.ts。画面の流れは e2e/map.e2e.ts）
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { flush, openOutbox, type Outbox, type OutboxItem, type Sender } from "../offline";
import { enqueueFinish, enqueueStart } from "../schedule/field";
import {
  appleMapsUrl,
  boundsOf,
  buildingMarkers,
  countByBuilding,
  dayWorks,
  DEFAULT_TILE_URL,
  directionsUrl,
  distanceM,
  FAR_THRESHOLD_M,
  formatDistance,
  formatLatLng,
  isValidLatLng,
  MAP_ATTRIBUTION,
  tileUrl,
  type DayWork,
} from "./geo";
import { CAPTURE_MESSAGES, captureLocation, resolvePosition, type GeoLike } from "./location";
import { describeGeocodeFailure, requestGeocode, resetBuildingPosition, saveBuildingPosition } from "./repo";

const TOKYO = { lat: 35.681236, lng: 139.767125 };
const OSAKA = { lat: 34.702485, lng: 135.495951 };

describe("距離（R-013-15）", () => {
  it("R-013-15 同じ点は 0 m、東京駅と大阪駅は約 400 km（DB の app.distance_m と同じ式）", () => {
    expect(distanceM(TOKYO, TOKYO)).toBe(0);
    const d = distanceM(TOKYO, OSAKA);
    expect(d).toBeGreaterThan(395_000);
    expect(d).toBeLessThan(405_000);
  });
  it("R-013-15 緯度 0.001 度は約 111 m、0.01 度は約 1112 m。離れているとみなす距離は 300 m", () => {
    expect(distanceM(TOKYO, { lat: TOKYO.lat + 0.001, lng: TOKYO.lng })).toBeGreaterThanOrEqual(110);
    expect(distanceM(TOKYO, { lat: TOKYO.lat + 0.001, lng: TOKYO.lng })).toBeLessThanOrEqual(112);
    expect(distanceM(TOKYO, { lat: TOKYO.lat + 0.01, lng: TOKYO.lng })).toBeGreaterThan(FAR_THRESHOLD_M);
    expect(FAR_THRESHOLD_M).toBe(300);
  });
  it("R-013-25 距離の書き方：1 km 未満は m、以上は km", () => {
    expect(formatDistance(350)).toBe("約 350 m");
    expect(formatDistance(1234)).toBe("約 1.2 km");
  });
  it("R-013-1 位置の範囲の確かめ（緯度 ±90・経度 ±180・有限の数）", () => {
    expect(isValidLatLng(35, 139)).toBe(true);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(0, 181)).toBe(false);
    expect(isValidLatLng(NaN, 0)).toBe(false);
    expect(isValidLatLng("35", 139)).toBe(false);
    expect(isValidLatLng(null, null)).toBe(false);
  });
  it("R-013-25 位置の表示：位置なしは「位置なし」", () => {
    expect(formatLatLng(null, null)).toBe("位置なし");
    expect(formatLatLng(35.681236, 139.767125)).toBe("35.681236, 139.767125");
  });
});

describe("道案内の URL（R-013-24）", () => {
  it("R-013-24 位置があれば、緯度・経度で道案内の URL を作る", () => {
    const u = directionsUrl({ name: "テストビル", address: "東京都千代田区1-1", ...TOKYO });
    expect(u).toBe("https://www.google.com/maps/dir/?api=1&destination=35.681236%2C139.767125");
    expect(appleMapsUrl({ name: "x", address: "x", ...TOKYO })).toBe("http://maps.apple.com/?daddr=35.681236%2C139.767125&dirflg=d");
  });
  it("R-013-24 位置がなければ、住所で作る。特殊な文字は符号化する", () => {
    const u = directionsUrl({ name: "A&B ビル", address: "東京都A区1-1 #3 & 別館", lat: null, lng: null });
    expect(u).toContain("destination=" + encodeURIComponent("東京都A区1-1 #3 & 別館"));
    expect(u).not.toContain(" ");
    expect(u).not.toContain("#");
    expect(new URL(u).searchParams.get("destination")).toBe("東京都A区1-1 #3 & 別館");
    expect(appleMapsUrl({ name: "x", address: "東京都A区1-1 #3 & 別館", lat: null, lng: null })).toContain(encodeURIComponent("東京都A区1-1 #3 & 別館"));
  });
  it("R-013-24 URL を作るだけで、外へは出ない（ネットワークを使わない純粋な関数）", () => {
    expect(typeof directionsUrl({ name: "x", address: "y", lat: null, lng: null })).toBe("string");
  });
});

describe("地図に出すもの（R-013-21・22・29）", () => {
  const bs = [
    { id: "b1", name: "A ビル", address: "東京", ...TOKYO },
    { id: "b2", name: "B ビル", address: "大阪", lat: null, lng: null },
    { id: "b3", name: "C ビル", address: "横浜", lat: 35.45, lng: 139.63 },
  ];
  it("R-013-21 位置のある建物だけが印になる。位置のない建物は印にならない", () => {
    expect(buildingMarkers(bs).map((m) => m.id)).toEqual(["b1", "b3"]);
  });
  it("R-013-21 地図の元データの帰属を、定数で持つ（画面が必ず出す）", () => {
    expect(MAP_ATTRIBUTION).toBe("© OpenStreetMap contributors");
  });
  const w = (id: string, building_id: string, over: Partial<DayWork & { d: string }> = {}) => ({ id, building_id, title: "清掃" + id, start_time: null, end_time: null, status: "scheduled", d: "2026-11-17", ...over });
  it("R-013-22 その日の作業だけを、取消・消したものを除いて、時刻の順に出す", () => {
    const ws = [
      w("w1", "b1", { start_time: "13:00:00" }),
      w("w2", "b3", { start_time: "09:00:00" }),
      w("w3", "b1", { status: "cancelled", start_time: "08:00:00" }),
      w("w4", "b1", { d: "2026-11-18" }),
      w("w5", "b1", { deleted_at: "2026-11-01T00:00:00Z" }),
      w("w6", "b3"),
    ];
    const day = dayWorks(ws, "2026-11-17", (x) => x.d);
    expect(day.map((x) => x.id)).toEqual(["w2", "w1", "w6"]); // 時刻なしは最後
  });
  it("R-013-22 建物ごとの作業の数が、印の数字になる", () => {
    const counts = countByBuilding([w("w1", "b1"), w("w2", "b1"), w("w3", "b3")]);
    expect(counts).toEqual({ b1: 2, b3: 1 });
    expect(buildingMarkers(bs, counts).map((m) => [m.id, m.works])).toEqual([["b1", 2], ["b3", 1]]);
  });
  it("R-013-22 印が入る範囲を求める（印がなければ null）", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([TOKYO, { lat: 35.45, lng: 139.63 }])).toEqual([{ lat: 35.45, lng: 139.63 }, { lat: 35.681236, lng: 139.767125 }]);
  });
  it("R-013-29 タイルの URL は、環境の設定で差し替えられる（既定は OpenStreetMap。壊れた設定は使わない）", () => {
    expect(tileUrl({})).toBe(DEFAULT_TILE_URL);
    expect(tileUrl({ NEXT_PUBLIC_MAP_TILE_URL: "https://tiles.example.test/{z}/{x}/{y}.png" })).toBe("https://tiles.example.test/{z}/{x}/{y}.png");
    expect(tileUrl({ NEXT_PUBLIC_MAP_TILE_URL: "http://insecure.example.test/{z}/{x}/{y}.png" })).toBe(DEFAULT_TILE_URL);
    expect(tileUrl({ NEXT_PUBLIC_MAP_TILE_URL: "https://no-placeholders.example.test/tile.png" })).toBe(DEFAULT_TILE_URL);
    expect(DEFAULT_TILE_URL).toContain("tile.openstreetmap.org");
  });
});

/** 呼ばれた回数を数える、偽の位置情報 */
function fakeGeo(kind: "ok" | "denied" | "timeout" | "unavailable" | "silent" | "bad") {
  const calls = { get: 0, watch: 0 };
  const geo: GeoLike & { watchPosition: () => number } = {
    getCurrentPosition(success, error) {
      calls.get++;
      if (kind === "ok") success({ coords: { latitude: 35.68, longitude: 139.76 } });
      else if (kind === "bad") success({ coords: { latitude: 135, longitude: 139.76 } });
      else if (kind === "denied") error({ code: 1 });
      else if (kind === "timeout") error({ code: 3 });
      else if (kind === "unavailable") error({ code: 2 });
      // silent：応答しない
    },
    watchPosition() {
      calls.watch++;
      return 0;
    },
  };
  return { geo, calls };
}

describe("了承と位置の取得（R-013-18・27・28）", () => {
  it("R-013-27 「位置なしで押す」では、位置を取りに行かない", async () => {
    const { geo, calls } = fakeGeo("ok");
    const r = await resolvePosition("without", geo);
    expect(r).toEqual({ cancelled: false, pos: null, note: null });
    expect(calls.get).toBe(0);
  });
  it("R-013-27 「やめる」では、何も記録せず、位置も取りに行かない", async () => {
    const { geo, calls } = fakeGeo("ok");
    const r = await resolvePosition("cancel", geo);
    expect(r).toEqual({ cancelled: true, pos: null, note: null });
    expect(calls.get).toBe(0);
  });
  it("R-013-27・18 「記録して押す」では、位置を 1 回だけ取る。常時の追跡（watchPosition）は使わない", async () => {
    const { geo, calls } = fakeGeo("ok");
    const r = await resolvePosition("with", geo);
    expect(r.pos).toEqual({ lat: 35.68, lng: 139.76 });
    expect(r.note).toBeNull();
    expect(calls).toEqual({ get: 1, watch: 0 });
  });
  it("R-013-28 位置の使用が許可されていないときは、位置なしで記録し、そのことを出す", async () => {
    const { geo } = fakeGeo("denied");
    const r = await resolvePosition("with", geo);
    expect(r.pos).toBeNull();
    expect(r.cancelled).toBe(false);
    expect(r.note).toBe(CAPTURE_MESSAGES.denied);
  });
  it("R-013-28 時間切れ・取れない・非対応・変な値のときも、位置なしで記録する", async () => {
    expect((await resolvePosition("with", fakeGeo("timeout").geo)).note).toBe(CAPTURE_MESSAGES.timeout);
    expect((await resolvePosition("with", fakeGeo("unavailable").geo)).note).toBe(CAPTURE_MESSAGES.unavailable);
    expect((await resolvePosition("with", undefined)).note).toBe(CAPTURE_MESSAGES.unsupported);
    const bad = await resolvePosition("with", fakeGeo("bad").geo);
    expect(bad.pos).toBeNull();
    expect(bad.note).toBe(CAPTURE_MESSAGES.invalid);
  });
  it("R-013-28 端末が応答しなくても、時間で切って位置なしにする", async () => {
    const { geo } = fakeGeo("silent");
    const r = await captureLocation(geo, 10); // 10 ms + 余裕 1 秒で切る
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("位置つきの開始・終了のため方（R-013-28）", () => {
  let box: Outbox;
  const scope = { tenantId: "t", membershipId: "me", deviceId: "dev-1" };
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    box = await openOutbox("m-" + Math.random());
  });
  it("R-013-28 位置を付けて開始・終了を端末にためる（電波がなくても、位置つきで残る）", async () => {
    const s = await enqueueStart(box, scope, "w1", new Date("2026-11-17T00:05:00Z"), { lat: 35.68, lng: 139.76 });
    expect(s.item.payload).toMatchObject({ p_work_id: "w1", p_lat: 35.68, p_lng: 139.76 });
    const f = await enqueueFinish(box, scope, "w1", new Date("2026-11-17T02:00:00Z"), { lat: 35.69, lng: 139.77 });
    expect(f.item.payload).toMatchObject({ p_work_id: "w1", p_lat: 35.69, p_lng: 139.77 });
    const offline: Sender = { send: async () => ({ ok: false, kind: "network", message: "offline" }) };
    expect((await flush(box, offline)).offline).toBe(true);
    expect(await box.pendingCount()).toBe(2);
  });
  it("R-013-27 位置なしでためたものには、位置の引数がない", async () => {
    const s = await enqueueStart(box, scope, "w1", new Date(), null);
    expect(Object.keys(s.item.payload)).not.toContain("p_lat");
    expect(Object.keys(s.item.payload)).not.toContain("p_lng");
    const f = await enqueueFinish(box, scope, "w1");
    expect(Object.keys(f.item.payload)).not.toContain("p_lat");
  });
  it("R-013-28 二度押しても 1 回（位置つきでも、同じ作業の開始は 1 件）", async () => {
    const a = await enqueueStart(box, scope, "w1", new Date(), { lat: 35.68, lng: 139.76 });
    const b = await enqueueStart(box, scope, "w1", new Date(), { lat: 35.7, lng: 139.8 });
    expect(b.duplicate).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.payload).toMatchObject({ p_lat: 35.68 });
    expect(await box.pendingCount()).toBe(1);
  });
  it("R-013-28 電波が戻ると、位置つきの引数のまま、端末の uuid（p_id）つきで送る", async () => {
    await enqueueStart(box, scope, "w1", new Date(), { lat: 35.68, lng: 139.76 });
    const sent: OutboxItem[] = [];
    await flush(box, { send: async (i) => (sent.push(i), { ok: true }) });
    expect(sent[0].target).toBe("start_work");
    expect(sent[0].payload).toMatchObject({ p_lat: 35.68, p_lng: 139.76 });
  });
});

/** 呼ばれた更新を記録する、偽の Supabase */
function fakeSb(over: { invoke?: () => Promise<{ data: unknown; error: unknown }> } = {}) {
  const calls: Array<{ table: string; row: Record<string, unknown>; id: string }> = [];
  const sb = {
    from(table: string) {
      return {
        update(row: Record<string, unknown>) {
          return {
            eq(_c: string, id: string) {
              calls.push({ table, row, id });
              return { select: () => ({ single: async () => ({ data: { id }, error: null }) }) };
            },
          };
        },
      };
    },
    functions: { invoke: over.invoke ?? (async () => ({ data: { found: true, lat: 35.1, lng: 139.2 }, error: null })) },
  };
  return { sb: sb as never, calls };
}

describe("位置を直す層（R-013-6・7・10・25）", () => {
  it("R-013-25 位置を保存すると、直した印（location_fixed）も付けて、建物の表に書く", async () => {
    const { sb, calls } = fakeSb();
    await saveBuildingPosition(sb, "b1", 35.6812361, 139.7671259);
    expect(calls).toEqual([{ table: "buildings", id: "b1", row: { lat: 35.681236, lng: 139.767126, location_fixed: true } }]);
  });
  it("R-013-1 範囲外の位置は、送らずに断る", async () => {
    const { sb, calls } = fakeSb();
    await expect(saveBuildingPosition(sb, "b1", 95, 10)).rejects.toThrow("位置が正しくありません");
    await expect(saveBuildingPosition(sb, "b1", 10, 200)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it("R-013-7 「住所から求め直す」は、位置を空に、直した印を外す", async () => {
    const { sb, calls } = fakeSb();
    await resetBuildingPosition(sb, "b1");
    expect(calls).toEqual([{ table: "buildings", id: "b1", row: { lat: null, lng: null, location_fixed: false } }]);
  });
  it("R-013-10 住所から求めた候補を受け取る（見つかった・見つからない・変な値）", async () => {
    expect(await requestGeocode(fakeSb().sb, "b1")).toEqual({ found: true, lat: 35.1, lng: 139.2 });
    expect(await requestGeocode(fakeSb({ invoke: async () => ({ data: { found: false }, error: null }) }).sb, "b1")).toEqual({ found: false });
    expect(await requestGeocode(fakeSb({ invoke: async () => ({ data: { found: true, lat: 999, lng: 1 }, error: null }) }).sb, "b1")).toEqual({ found: false });
  });
  it("R-013-10 失敗の理由を、日本語で出す（口が未設定・権限なし・ほか）", async () => {
    const err = (status: number, code?: string) => ({ context: new Response(JSON.stringify({ code }), { status }) });
    await expect(requestGeocode(fakeSb({ invoke: async () => ({ data: null, error: err(503, "geocoder_not_configured") }) }).sb, "b1")).rejects.toThrow("まだ選ばれていません");
    await expect(requestGeocode(fakeSb({ invoke: async () => ({ data: null, error: err(403, "42501") }) }).sb, "b1")).rejects.toThrow("権限がありません");
    await expect(requestGeocode(fakeSb({ invoke: async () => ({ data: null, error: err(502) }) }).sb, "b1")).rejects.toThrow("求められませんでした");
    expect(describeGeocodeFailure(401, null)).toContain("ログイン");
    expect(describeGeocodeFailure(null, null)).toContain("求められませんでした");
  });
});
