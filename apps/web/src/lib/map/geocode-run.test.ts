// 住所から位置を求める定時の処理と、位置の掃除の判断（R-013-2〜4・8〜11・19・20）。DB と外の API は偽物に差し替える。
// 何を求めるか・何を消すかの本体は DB の関数で、supabase/tests/26_map.sql が確かめる。
import { describe, expect, it } from "vitest";
import {
  createGeocoder,
  createGsiGeocoder,
  GEOCODE_LIMIT,
  GeocoderNotConfigured,
  GSI_ENDPOINT,
  handleGeocodeOne,
  MAX_CONSECUTIVE_ERRORS,
  notConfiguredGeocoder,
  parseGsiResponse,
  runGeocode,
  sanitizeError,
  type FetchLike,
  type Geocoder,
  type GeocodeStore,
} from "../../../../../supabase/functions/_shared/geocode";
import { KEEP_DAYS, runPurgeLocations, type PurgeStore } from "../../../../../supabase/functions/_shared/purgeLocations";

interface Call {
  fn: string;
  args: unknown[];
}

function fakeStore(opts: {
  tenants: string[];
  pending?: Record<string, Array<{ id: string; address: string }>>;
  busy?: string[];
  applyFalse?: string[];
  failStart?: string[];
  failFinish?: boolean;
}) {
  const calls: Call[] = [];
  const store: GeocodeStore = {
    async tenants() {
      calls.push({ fn: "tenants", args: [] });
      return opts.tenants;
    },
    async startRun(t) {
      calls.push({ fn: "startRun", args: [t] });
      if (opts.failStart?.includes(t)) throw new Error("db down " + "x".repeat(40));
      return opts.busy?.includes(t) ? null : `run-${t}`;
    },
    async pending(t, limit) {
      calls.push({ fn: "pending", args: [t, limit] });
      return opts.pending?.[t] ?? [];
    },
    async apply(t, b, lat, lng) {
      calls.push({ fn: "apply", args: [t, b, lat, lng] });
      return !opts.applyFalse?.includes(b);
    },
    async fail(t, b) {
      calls.push({ fn: "fail", args: [t, b] });
    },
    async finishRun(t, run, status, counts, error) {
      calls.push({ fn: "finishRun", args: [t, run, status, counts, error] });
      if (opts.failFinish) throw new Error("finish failed");
    },
  };
  return { store, calls };
}

const found = (lat = 35.1, lng = 139.2): Geocoder => ({ geocode: async () => ({ lat, lng }) });
const noSleep = async () => {};

describe("R-013-8 住所から位置を求める定時の処理", () => {
  it("R-013-8 会社ごとに、記録を始め → 対象を読み → 求めて保存し → 記録を閉じる", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"], pending: { tA: [{ id: "b1", address: "東京都A区1" }], tB: [{ id: "b2", address: "大阪府B市1" }] } });
    const s = await runGeocode({ store, geocoder: found(), delayMs: 0 });
    expect(s).toEqual({ tenants: 2, skipped: 0, failedTenants: 0, geocoded: 2, notFound: 0, errors: 0, superseded: 0 });
    expect(calls.map((c) => `${c.fn}:${c.args[0] ?? ""}`)).toEqual([
      "tenants:", "startRun:tA", "pending:tA", "apply:tA", "finishRun:tA", "startRun:tB", "pending:tB", "apply:tB", "finishRun:tB",
    ]);
    expect(calls.find((c) => c.fn === "finishRun")!.args).toEqual(["tA", "run-tA", "success", { geocoded: 1, not_found: 0, errors: 0, superseded: 0 }, null]);
  });
  it("R-013-8 会社の ID は、会社の一覧から取ったものだけを使う（呼び出し側から渡さない）", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA"], pending: { tA: [{ id: "b1", address: "x" }] } });
    await runGeocode({ store, geocoder: found(), delayMs: 0 });
    for (const c of calls.filter((x) => x.fn !== "tenants")) expect(c.args[0]).toBe("tA");
  });
  it("R-013-8 同じ会社で動いている最中なら、その会社は飛ばす（ほかは続ける）", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"], busy: ["tA"], pending: { tB: [{ id: "b2", address: "x" }] } });
    const s = await runGeocode({ store, geocoder: found(), delayMs: 0 });
    expect(s).toMatchObject({ tenants: 2, skipped: 1, geocoded: 1 });
    expect(calls.some((c) => c.fn === "pending" && c.args[0] === "tA")).toBe(false);
  });
  it("R-013-8 1 つの会社の失敗は、ほかの会社を止めない。失敗は記録に残り、鍵のような長い文字列は伏せる", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"], failStart: [], pending: { tA: [{ id: "b1", address: "x" }], tB: [{ id: "b2", address: "y" }] } });
    const bad: Geocoder = {
      geocode: async (a) => {
        if (a === "x") throw new GeocoderNotConfigured();
        return { lat: 1, lng: 2 };
      },
    };
    const s = await runGeocode({ store, geocoder: bad, delayMs: 0 });
    expect(s).toMatchObject({ failedTenants: 1, geocoded: 1 });
    const fin = calls.filter((c) => c.fn === "finishRun");
    expect(fin[0].args).toEqual(["tA", "run-tA", "failure", { geocoded: 0, not_found: 0, errors: 0, superseded: 0 }, "geocoder_not_configured"]);
    expect(fin[1].args[2]).toBe("success");
  });
  it("R-013-8 DB の失敗（開始できない）でも、記録に残る失敗の文面から長い文字列（鍵のようなもの）を伏せ、次の会社へ進む", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"], failStart: ["tA"], pending: { tB: [{ id: "b2", address: "y" }] } });
    const s = await runGeocode({ store, geocoder: found(), delayMs: 0 });
    expect(s).toMatchObject({ tenants: 2, failedTenants: 1, geocoded: 1 });
    expect(calls.filter((c) => c.fn === "finishRun")).toHaveLength(1); // tA は記録を始められていないので閉じる記録がない
    expect(sanitizeError(new Error("key " + "A".repeat(50)))).toBe("key ***");
    expect(sanitizeError(new Error("ab ".repeat(100)))).toHaveLength(200);
  });
  it("R-013-8 記録を閉じるのに失敗しても、次の会社へ進む", async () => {
    const { store } = fakeStore({ tenants: ["tA", "tB"], pending: { tA: [{ id: "b1", address: "x" }], tB: [{ id: "b2", address: "y" }] }, failFinish: true });
    const s = await runGeocode({ store, geocoder: found(), delayMs: 0 });
    expect(s.tenants).toBe(2);
    expect(s.failedTenants).toBe(2);
  });
  it("R-013-2 1 社あたりの件数の上限（既定 50）を、対象の読み出しに渡す", async () => {
    const { store, calls } = fakeStore({ tenants: ["tA"] });
    await runGeocode({ store, geocoder: found(), delayMs: 0 });
    expect(calls.find((c) => c.fn === "pending")!.args).toEqual(["tA", GEOCODE_LIMIT]);
    expect(GEOCODE_LIMIT).toBe(50);
    const o = fakeStore({ tenants: ["tA"] });
    await runGeocode({ store: o.store, geocoder: found(), delayMs: 0, limit: 5 });
    expect(o.calls.find((c) => c.fn === "pending")!.args).toEqual(["tA", 5]);
  });
});

describe("R-013-3・4 求めた結果の扱い", () => {
  it("R-013-4 住所が見つからないときは、失敗の印を付けて（保存はしない）、次の建物へ進む。ほかの建物は求める", async () => {
    const g: Geocoder = { geocode: async (a) => (a === "ない" ? null : { lat: 35, lng: 139 }) };
    const { store, calls } = fakeStore({ tenants: ["tA"], pending: { tA: [{ id: "b1", address: "ない" }, { id: "b2", address: "ある" }] } });
    const s = await runGeocode({ store, geocoder: g, delayMs: 0 });
    expect(s).toMatchObject({ geocoded: 1, notFound: 1, failedTenants: 0 });
    expect(calls.filter((c) => c.fn === "fail").map((c) => c.args)).toEqual([["tA", "b1"]]);
    expect(calls.filter((c) => c.fn === "apply").map((c) => c.args[1])).toEqual(["b2"]);
  });
  it("R-013-4 住所が空の建物は、位置の API を呼ばずに、失敗の印を付ける", async () => {
    let asked = 0;
    const g: Geocoder = { geocode: async () => (asked++, { lat: 1, lng: 1 }) };
    const { store, calls } = fakeStore({ tenants: ["tA"], pending: { tA: [{ id: "b1", address: "   " }] } });
    await runGeocode({ store, geocoder: g, delayMs: 0 });
    expect(asked).toBe(0);
    expect(calls.some((c) => c.fn === "fail")).toBe(true);
  });
  it("R-013-3 保存の時点で、人が先に直していたら（apply が false）上書きせず、数えるだけ", async () => {
    const { store } = fakeStore({ tenants: ["tA"], pending: { tA: [{ id: "b1", address: "x" }] }, applyFalse: ["b1"] });
    const s = await runGeocode({ store, geocoder: found(), delayMs: 0 });
    expect(s).toMatchObject({ geocoded: 0, superseded: 1 });
  });
  it("R-013-4 通信の失敗（例外）では、失敗の印を付けない（次の処理でもう一度）。続けて失敗したら、その会社の処理を止める", async () => {
    const boom: Geocoder = { geocode: async () => { throw new Error("network"); } };
    const ps = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, address: "x" }));
    const { store, calls } = fakeStore({ tenants: ["tA", "tB"], pending: { tA: ps, tB: [] } });
    const s = await runGeocode({ store, geocoder: boom, delayMs: 0 });
    expect(calls.some((c) => c.fn === "fail")).toBe(false);
    expect(s.errors).toBe(MAX_CONSECUTIVE_ERRORS);
    expect(s.failedTenants).toBe(1);
    const fin = calls.filter((c) => c.fn === "finishRun");
    expect(fin[0].args[2]).toBe("failure");
    expect(fin[0].args[4]).toBe("too_many_errors");
    expect(fin[1].args[2]).toBe("success"); // 会社 B は続く
  });
  it("R-013-9 外の API の利用の決まりを守るため、1 件ごとに待ち時間を置く（最初の 1 件の前には置かない）", async () => {
    const waits: number[] = [];
    const { store } = fakeStore({ tenants: ["tA"], pending: { tA: [{ id: "b1", address: "x" }, { id: "b2", address: "y" }, { id: "b3", address: "z" }] } });
    await runGeocode({ store, geocoder: found(), delayMs: 1100, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1100, 1100]);
  });
});

describe("R-013-9 位置の API の口（adapter）", () => {
  it("R-013-9 何も選ばれていなければ、「口が未設定」で失敗にし、位置を作らない", async () => {
    await expect(notConfiguredGeocoder.geocode("x")).rejects.toBeInstanceOf(GeocoderNotConfigured);
    const { store, calls } = fakeStore({ tenants: ["tA"], pending: { tA: [{ id: "b1", address: "x" }] } });
    const s = await runGeocode({ store, geocoder: createGeocoder({}, async () => { throw new Error("呼ばれてはいけない"); }), delayMs: 0, sleep: noSleep });
    expect(s).toMatchObject({ geocoded: 0, failedTenants: 1 });
    expect(calls.some((c) => c.fn === "apply")).toBe(false);
    expect(calls.some((c) => c.fn === "fail")).toBe(false); // 口が無いだけなので、建物に失敗の印は付けない
    expect(calls.find((c) => c.fn === "finishRun")!.args.slice(2)).toEqual(["failure", { geocoded: 0, not_found: 0, errors: 0, superseded: 0 }, "geocoder_not_configured"]);
  });
  it("R-013-9 環境の GEOCODER で口を選ぶ。知らない名前は未設定と同じ", async () => {
    expect(createGeocoder({ GEOCODER: "unknown" }, async () => { throw new Error("x"); })).toBe(notConfiguredGeocoder);
    expect(createGeocoder({ GEOCODER: "gsi" }, async () => ({ ok: true, status: 200, json: async () => [] }))).not.toBe(notConfiguredGeocoder);
  });
});

describe("R-013-11 国土地理院の住所検索の口", () => {
  const feature = (lng: number, lat: number) => ({ geometry: { coordinates: [lng, lat], type: "Point" }, type: "Feature", properties: { addressCode: "", title: "東京都千代田区" } });
  it("R-013-11 応答（GeoJSON の配列）の先頭の点を、{lat, lng} に読み替える（座標の順は [経度, 緯度]）", () => {
    expect(parseGsiResponse([feature(139.7671, 35.6812), feature(1, 2)])).toEqual({ lat: 35.6812, lng: 139.7671 });
  });
  it("R-013-11 点がなければ「見つからない」。壊れた応答でも落ちない", () => {
    expect(parseGsiResponse([])).toBeNull();
    expect(parseGsiResponse(null)).toBeNull();
    expect(parseGsiResponse({ error: "x" })).toBeNull();
    expect(parseGsiResponse([null, 1, "x", {}, { geometry: null }, { geometry: { type: "Polygon", coordinates: [] } }])).toBeNull();
    expect(parseGsiResponse([{ geometry: { type: "Point", coordinates: ["a", "b"] } }])).toBeNull();
    expect(parseGsiResponse([{ geometry: { type: "Point", coordinates: [139, 135] } }])).toBeNull(); // 緯度が範囲外
  });
  it("R-013-11 検索の URL に住所を符号化して付ける。通信が失敗したら例外（見つからないとは区別する）", async () => {
    const urls: string[] = [];
    const ok: FetchLike = async (u) => (urls.push(u), { ok: true, status: 200, json: async () => [feature(139.7, 35.6)] });
    expect(await createGsiGeocoder(ok).geocode("東京都千代田区 1-1")).toEqual({ lat: 35.6, lng: 139.7 });
    expect(urls[0]).toBe(`${GSI_ENDPOINT}?q=${encodeURIComponent("東京都千代田区 1-1")}`);
    const ng: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await expect(createGsiGeocoder(ng).geocode("x")).rejects.toThrow("geocoder_http_503");
    const empty: FetchLike = async () => ({ ok: true, status: 200, json: async () => [] });
    expect(await createGsiGeocoder(empty).geocode("x")).toBeNull();
  });
});

describe("R-013-10 画面から 1 件だけ求める入口", () => {
  const ID = "00000000-0000-4000-8000-0000000000b1";
  const mk = (target: (a: string, id: string) => Promise<{ address: string } | null>, geocoder: Geocoder = found(35.5, 139.5)) => ({ target, geocoder });
  it("R-013-10 ログインの鍵がなければ 401。建物の ID が正しくなければ 400（位置の API は呼ばない）", async () => {
    let called = 0;
    const g: Geocoder = { geocode: async () => (called++, null) };
    const deps = mk(async () => ({ address: "x" }), g);
    expect((await handleGeocodeOne(null, { building_id: ID }, deps)).status).toBe(401);
    expect((await handleGeocodeOne("Bearer t", { building_id: "x" }, deps)).status).toBe(400);
    expect((await handleGeocodeOne("Bearer t", null, deps)).status).toBe(400);
    expect(called).toBe(0);
  });
  it("R-013-10 master.edit の人が、自分の会社の建物の住所を求めると、候補の位置を返す（保存はしない）", async () => {
    const seen: string[] = [];
    const r = await handleGeocodeOne("Bearer t", { building_id: ID }, mk(async (a, id) => (seen.push(a, id), { address: "東京都A区1-1" })));
    expect(r).toEqual({ status: 200, body: { found: true, lat: 35.5, lng: 139.5 } });
    expect(seen).toEqual(["Bearer t", ID]);
  });
  it("R-013-10 権限のない人・ほかの会社・存在しない建物は、同じ 403 で断る（位置の API は呼ばない）", async () => {
    let called = 0;
    const g: Geocoder = { geocode: async () => (called++, null) };
    const r = await handleGeocodeOne("Bearer t", { building_id: ID }, mk(async () => null, g));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "42501" });
    expect(called).toBe(0);
  });
  it("R-013-10 見つからない・口が未設定（503）・通信の失敗（502）を区別して返す", async () => {
    const nf = await handleGeocodeOne("Bearer t", { building_id: ID }, mk(async () => ({ address: "x" }), { geocode: async () => null }));
    expect(nf).toEqual({ status: 200, body: { found: false } });
    const nc = await handleGeocodeOne("Bearer t", { building_id: ID }, mk(async () => ({ address: "x" }), notConfiguredGeocoder));
    expect(nc.status).toBe(503);
    expect(nc.body).toMatchObject({ code: "geocoder_not_configured" });
    const bad = await handleGeocodeOne("Bearer t", { building_id: ID }, mk(async () => ({ address: "x" }), { geocode: async () => { throw new Error("network"); } }));
    expect(bad.status).toBe(502);
    const empty = await handleGeocodeOne("Bearer t", { building_id: ID }, mk(async () => ({ address: "  " })));
    expect(empty).toEqual({ status: 200, body: { found: false } });
    const dbFail = await handleGeocodeOne("Bearer t", { building_id: ID }, mk(async () => { throw new Error("db"); }));
    expect(dbFail.status).toBe(500);
  });
});

function fakePurge(opts: { tenants: string[]; busy?: string[]; failPurge?: string[]; n?: number }) {
  const calls: Call[] = [];
  const store: PurgeStore = {
    async tenants() {
      calls.push({ fn: "tenants", args: [] });
      return opts.tenants;
    },
    async startRun(t) {
      calls.push({ fn: "startRun", args: [t] });
      return opts.busy?.includes(t) ? null : `run-${t}`;
    },
    async purge(t) {
      calls.push({ fn: "purge", args: [t] });
      if (opts.failPurge?.includes(t)) throw new Error("boom " + "x".repeat(40));
      return opts.n ?? 2;
    },
    async finishRun(t, run, status, counts, error) {
      calls.push({ fn: "finishRun", args: [t, run, status, counts, error] });
    },
  };
  return { store, calls };
}

describe("R-013-19・20 位置を 90 日で消す定時の処理", () => {
  it("R-013-19 位置を残す日数は 90 日", () => {
    expect(KEEP_DAYS).toBe(90);
  });
  it("R-013-20 会社ごとに、記録を始め → その会社の分だけ消し → 記録を閉じる", async () => {
    const { store, calls } = fakePurge({ tenants: ["tA", "tB"] });
    const s = await runPurgeLocations(store);
    expect(s).toEqual({ tenants: 2, skipped: 0, failedTenants: 0, purged: 4 });
    expect(calls.map((c) => `${c.fn}:${c.args[0] ?? ""}`)).toEqual(["tenants:", "startRun:tA", "purge:tA", "finishRun:tA", "startRun:tB", "purge:tB", "finishRun:tB"]);
    expect(calls.find((c) => c.fn === "finishRun")!.args).toEqual(["tA", "run-tA", "success", { purged: 2 }, null]);
  });
  it("R-013-20 動いている最中の会社は飛ばし、1 つの会社の失敗はほかを止めない（失敗の文面は鍵のような文字列を伏せる）", async () => {
    const { store, calls } = fakePurge({ tenants: ["tA", "tB", "tC"], busy: ["tA"], failPurge: ["tB"] });
    const s = await runPurgeLocations(store);
    expect(s).toEqual({ tenants: 3, skipped: 1, failedTenants: 1, purged: 2 });
    const failed = calls.find((c) => c.fn === "finishRun" && c.args[0] === "tB")!;
    expect(failed.args[2]).toBe("failure");
    expect(String(failed.args[4])).toContain("boom");
    expect(calls.some((c) => c.fn === "purge" && c.args[0] === "tA")).toBe(false);
    expect(calls.some((c) => c.fn === "purge" && c.args[0] === "tC")).toBe(true);
  });
});
