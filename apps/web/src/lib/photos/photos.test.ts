// 機能 008 の端末側の部品（縮小・Exif を消す・端末にためる・送り直し・一覧の整理）。画面を使わず、偽の口で確かめる。
import { describe, expect, it } from "vitest";
import { buildPhotoPaths, dayRangeJst, filterPhotos, groupByDay, jstDay, kindLabel, KIND_OPTIONS, sortPhotos, takenByMe, validateCapture } from "./format";
import { assertCleanJpeg, fitSize, hasJpegMetadata, PHOTO_MAX_SIDE, stripJpegMetadata, THUMB_MAX_SIDE } from "./image";
import { processPhotoWith, type Renderer } from "./process";
import { capturePhoto, flushPhotos, openPhotoQueue, type Outcome, type PhotoSender } from "./queue";
import type { PhotoRow } from "./types";

const T = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";

// ---- JPEG の見本（SOI・APP0・APP1(Exif・GPS)・COM・DQT・SOS・画素・EOI）----
function seg(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
function jpegWithMetadata(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...ascii("Exif"), 0, 0, ...ascii("GPSLatitude=35.68;GPSLongitude=139.76")]),
    ...seg(0xe2, ascii("ICC_PROFILE")),
    ...seg(0xed, ascii("Photoshop 3.0")),
    ...seg(0xfe, ascii("camera comment")),
    ...seg(0xdb, [0, 16, 11, 12, 14]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    1, 2, 3, 0xff, 0x00, 4, 5, // 画素（0xff 0x00 は詰め物）
    0xff, 0xd9,
  ]);
}
const text = (b: Uint8Array) => String.fromCharCode(...b);

describe("縮小（端末）", () => {
  it("R-008-22 長辺が上限を超えるときだけ縮め、縦横比を保つ。小さい画像は拡大しない", () => {
    expect(PHOTO_MAX_SIDE).toBe(1600);
    expect(THUMB_MAX_SIDE).toBe(320);
    expect(fitSize(4032, 3024, PHOTO_MAX_SIDE)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(3024, 4032, PHOTO_MAX_SIDE)).toEqual({ width: 1200, height: 1600 });
    expect(fitSize(4032, 3024, THUMB_MAX_SIDE)).toEqual({ width: 320, height: 240 });
    expect(fitSize(800, 600, PHOTO_MAX_SIDE)).toEqual({ width: 800, height: 600 });
    expect(fitSize(1600, 1600, PHOTO_MAX_SIDE)).toEqual({ width: 1600, height: 1600 });
    expect(fitSize(10000, 1, 320)).toEqual({ width: 320, height: 1 });
  });

  it("R-008-22 元の画像と小さな画像を作り、幅・高さ・大きさを返す", async () => {
    const r = await processPhotoWith(fakeRenderer(4032, 3024), new Blob([]));
    expect(r.width).toBe(1600);
    expect(r.height).toBe(1200);
    expect(r.bytes).toBe(r.photo.byteLength);
    expect(r.thumbWidth).toBe(320);
    expect(r.thumbHeight).toBe(240);
    expect(r.thumb.byteLength).toBeGreaterThan(0);
  });
});

function fakeRenderer(w: number, h: number, bytes: Uint8Array = jpegWithMetadata()): Renderer {
  return {
    async open() {
      return { width: w, height: h };
    },
    async encode() {
      return bytes;
    },
  };
}

describe("Exif・位置の情報を消す（端末）", () => {
  it("R-008-23 JPEG の Exif（位置）・ICC・コメントなどの付属の情報を消し、画素と必要な部分は残す", () => {
    const src = jpegWithMetadata();
    expect(hasJpegMetadata(src)).toBe(true);
    expect(text(src)).toContain("GPSLatitude");
    const out = stripJpegMetadata(src);
    expect(hasJpegMetadata(out)).toBe(false);
    expect(text(out)).not.toContain("GPS");
    expect(text(out)).not.toContain("Exif");
    expect(text(out)).not.toContain("camera comment");
    expect(text(out)).toContain("JFIF"); // 画像の読み方に要る APP0 は残す
    expect([...out.slice(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.slice(-2)]).toEqual([0xff, 0xd9]);
    // 圧縮された画素（SOS 以降）は一字も変えない
    const sos = (b: Uint8Array) => b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xda);
    expect([...out.slice(sos(out))]).toEqual([...src.slice(sos(src))]);
    // 二度かけても同じ
    expect([...stripJpegMetadata(out)]).toEqual([...out]);
  });

  it("R-008-23 縮小して作った元の画像・小さな画像の両方から、位置の情報が消えている", async () => {
    const r = await processPhotoWith(fakeRenderer(3000, 2000), new Blob([]));
    expect(hasJpegMetadata(new Uint8Array(r.photo))).toBe(false);
    expect(hasJpegMetadata(new Uint8Array(r.thumb))).toBe(false);
    expect(text(new Uint8Array(r.photo))).not.toContain("GPS");
    expect(text(new Uint8Array(r.thumb))).not.toContain("GPS");
  });

  it("R-008-23 JPEG でないもの・壊れたものは、そのまま送らず断る", async () => {
    expect(() => stripJpegMetadata(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0]))).toThrow();
    expect(() => assertCleanJpeg(jpegWithMetadata())).toThrow();
    await expect(processPhotoWith(fakeRenderer(100, 100, new Uint8Array([9, 9, 9])), new Blob([]))).rejects.toThrow();
  });
});

// ---- 端末にためる・送り直し ----
function sender(log: string[], over: { upload?: (path: string) => Outcome; insert?: (row: { id: string }) => Outcome } = {}): PhotoSender {
  return {
    async uploadFile(path) {
      log.push(`upload:${path.split("/").slice(-1)[0]}`);
      return over.upload?.(path) ?? { ok: true };
    },
    async insertRow(row) {
      log.push(`insert:${row.id.slice(0, 4)}`);
      return over.insert?.(row) ?? { ok: true };
    },
  };
}
let seq = 0;
async function newQueue() {
  return openPhotoQueue(`photos-test-${++seq}`);
}
async function shoot(q: Awaited<ReturnType<typeof newQueue>>, id: string, over: Partial<Parameters<typeof capturePhoto>[2]> = {}) {
  const p = await processPhotoWith(fakeRenderer(2000, 1500), new Blob([]));
  return capturePhoto(q, { tenantId: T, membershipId: M }, { id, building_id: B, kind: "before", taken_at: "2026-11-16T01:00:00.000Z", processed: p, ...over });
}
const ID1 = "aaaa0000-0000-4000-8000-000000000001";
const ID2 = "bbbb0000-0000-4000-8000-000000000002";

describe("端末にためる・送り直し", () => {
  it("R-008-24 撮ったら、まず端末にためる（元の画像・小さな画像・行の中身）。電波がなくても失われない", async () => {
    const q = await newQueue();
    await shoot(q, ID1);
    expect(await q.count()).toBe(1);
    const [it] = await q.list();
    expect(it.row).toMatchObject({
      id: ID1,
      tenant_id: T,
      building_id: B,
      kind: "before",
      taken_by: M,
      storage_path: `${T}/photos/${ID1}/photo.jpg`,
      thumb_path: `${T}/photos/${ID1}/thumb.jpg`,
      width: 1600,
      height: 1200,
    });
    expect(it.photo.byteLength).toBeGreaterThan(0);
    expect(it.thumb.byteLength).toBeGreaterThan(0);
  });

  it("R-008-24 電波がない間は送らず残し、電波が戻ったら、元の画像 → 小さな画像 → 行の順に送って、端末から消す", async () => {
    const q = await newQueue();
    await shoot(q, ID1);
    const offline: Outcome = { ok: false, kind: "network", message: "Failed to fetch" };
    const log: string[] = [];
    const r1 = await flushPhotos(q, sender(log, { upload: () => offline }));
    expect(r1).toMatchObject({ sent: 0, remaining: 1, offline: true });
    expect(await q.count()).toBe(1);
    expect(log).toEqual(["upload:photo.jpg"]); // つながらないと分かったら、そこで止める
    const log2: string[] = [];
    const r2 = await flushPhotos(q, sender(log2));
    expect(log2).toEqual(["upload:photo.jpg", "upload:thumb.jpg", "insert:aaaa"]);
    expect(r2).toMatchObject({ sent: 1, remaining: 0, offline: false });
    expect(await q.count()).toBe(0);
  });

  it("R-008-24 画像が上がらなかったら、行は作らない（行だけが先に出来ない）", async () => {
    const q = await newQueue();
    await shoot(q, ID1);
    const log: string[] = [];
    await flushPhotos(q, sender(log, { upload: (p) => (p.endsWith("thumb.jpg") ? { ok: false, kind: "server", message: "x", code: "500" } : { ok: true }) }));
    expect(log).toEqual(["upload:photo.jpg", "upload:thumb.jpg"]);
    expect(await q.count()).toBe(1);
  });

  it("R-008-25 同じ uuid は、ためるのも1件。もう一度ためても、先にためた中身を残す", async () => {
    const q = await newQueue();
    await shoot(q, ID1, { kind: "before" });
    await shoot(q, ID1, { kind: "after" });
    expect(await q.count()).toBe(1);
    expect((await q.list())[0].row.kind).toBe("before");
  });

  it("R-008-25 送る行は、端末の uuid のまま（既にあれば無視する書き方で送る側が二重を作らない）。届いていた（重複）も送れたこととして消す", async () => {
    const q = await newQueue();
    await shoot(q, ID1);
    const log: string[] = [];
    const r = await flushPhotos(q, sender(log, { insert: () => ({ ok: true, duplicate: true }) }));
    expect(r).toMatchObject({ sent: 1, duplicates: 1, remaining: 0 });
    expect(log).toContain("insert:aaaa");
  });

  it("R-008-25 送りの途中でつながらなくなったら、そこで止め、続きから送る。同時に2回呼んでも二重に送らない", async () => {
    const q = await newQueue();
    await shoot(q, ID1);
    await shoot(q, ID2);
    let n = 0;
    const log: string[] = [];
    const flaky = sender(log, { upload: () => (++n === 3 ? { ok: false, kind: "network", message: "offline" } : { ok: true }) });
    const r1 = await flushPhotos(q, flaky);
    expect(r1).toMatchObject({ sent: 1, remaining: 1, offline: true });
    const log2: string[] = [];
    const [a, b] = await Promise.all([flushPhotos(q, sender(log2)), flushPhotos(q, sender(log2))]);
    expect(a).toBe(b);
    expect(log2.filter((l) => l.startsWith("insert"))).toEqual(["insert:bbbb"]);
    expect(await q.count()).toBe(0);
  });

  it("R-008-26 サーバーに断られた写真は、端末に残し（理由を覚え）、次の写真を送る。ログインが切れていたら止める", async () => {
    const q = await newQueue();
    await shoot(q, ID1);
    await shoot(q, ID2);
    const log: string[] = [];
    const r = await flushPhotos(q, sender(log, { insert: (row) => (row.id === ID1 ? { ok: false, kind: "server", message: "権限がない", code: "42501" } : { ok: true }) }));
    expect(r).toMatchObject({ sent: 1, rejected: 1, remaining: 1, offline: false });
    const [left] = await q.list();
    expect(left.row.id).toBe(ID1);
    expect(left).toMatchObject({ lastCode: "42501", lastError: "権限がない", attempts: 1 });
    const log2: string[] = [];
    const r2 = await flushPhotos(q, sender(log2, { upload: () => ({ ok: false, kind: "auth", message: "jwt expired" }) }));
    expect(r2.offline).toBe(true);
    expect(log2).toEqual(["upload:photo.jpg"]);
    expect(await q.count()).toBe(1);
  });

  it("R-008-26 あきらめて端末から消せる（送れない写真だけ。画面から人が選ぶ）", async () => {
    const q = await newQueue();
    await shoot(q, ID1);
    await q.remove(ID1);
    expect(await q.count()).toBe(0);
  });

  it("R-008-27 気づきの写真に案件の uuid を付けておくと、行に request_id が入る（案件を作る気づきを先に送ってから送る）", async () => {
    const q = await newQueue();
    const REQ = "cccc0000-0000-4000-8000-000000000003";
    await shoot(q, ID1, { kind: "observation", request_id: REQ });
    expect((await q.list())[0].row).toMatchObject({ kind: "observation", request_id: REQ });
    // 案件がまだ届いていない間の断り（外部キー）は、送れなかったこととして残し、あとで送り直す
    const r = await flushPhotos(q, sender([], { insert: () => ({ ok: false, kind: "server", message: "fk", code: "23503" }) }));
    expect(r).toMatchObject({ sent: 0, rejected: 1, remaining: 1 });
    const r2 = await flushPhotos(q, sender([]));
    expect(r2).toMatchObject({ sent: 1, remaining: 0 });
  });

  it("R-008-28 置き場所は <会社>/photos/<写真の id>/photo.jpg と thumb.jpg（DB の check と同じ）", () => {
    expect(buildPhotoPaths(T, ID1)).toEqual({ photo: `${T}/photos/${ID1}/photo.jpg`, thumb: `${T}/photos/${ID1}/thumb.jpg` });
  });
});

// ---- 一覧の整理 ----
const row = (over: Partial<PhotoRow>): PhotoRow => ({
  id: "p",
  tenant_id: T,
  building_id: B,
  area_id: null,
  room_id: null,
  work_id: null,
  report_item_id: null,
  request_id: null,
  kind: "before",
  taken_at: "2026-11-16T01:00:00.000Z",
  taken_by: M,
  storage_path: "",
  thumb_path: "",
  width: 1600,
  height: 1200,
  bytes: 1,
  created_at: "2026-11-16T01:00:00.000Z",
  deleted_at: null,
  ...over,
});

describe("一覧の整理", () => {
  it("R-008-29 新しい順に並べ、日本時間の日ごとにまとめる（UTC の15時は翌日）", () => {
    const rows = [
      row({ id: "a", taken_at: "2026-11-15T14:59:59.000Z" }), // 日本時間 11/15 23:59
      row({ id: "b", taken_at: "2026-11-15T15:00:00.000Z" }), // 日本時間 11/16 00:00
      row({ id: "c", taken_at: "2026-11-16T05:00:00.000Z" }),
    ];
    expect(sortPhotos(rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(jstDay("2026-11-15T15:00:00.000Z")).toBe("2026-11-16");
    const g = groupByDay(sortPhotos(rows));
    expect(g.map((x) => [x.day, x.photos.map((p) => p.id)])).toEqual([
      ["2026-11-16", ["c", "b"]],
      ["2026-11-15", ["a"]],
    ]);
    expect(sortPhotos(rows)).not.toBe(rows);
  });

  it("R-008-29 建物・日・案件・作業・種類で絞り込む（消した写真は出さない）", () => {
    const rows = [
      row({ id: "1", building_id: "b1", kind: "before", taken_at: "2026-11-16T01:00:00.000Z" }),
      row({ id: "2", building_id: "b2", kind: "observation", request_id: "r1", taken_at: "2026-11-16T02:00:00.000Z" }),
      row({ id: "3", building_id: "b1", kind: "after", work_id: "w1", taken_at: "2026-11-17T02:00:00.000Z" }),
      row({ id: "4", building_id: "b1", deleted_at: "2026-11-16T00:00:00.000Z" }),
    ];
    const ids = (f: Parameters<typeof filterPhotos>[1]) => filterPhotos(rows, f).map((r) => r.id);
    expect(ids({})).toEqual(["1", "2", "3"]);
    expect(ids({ building: "b1" })).toEqual(["1", "3"]);
    expect(ids({ day: "2026-11-16" })).toEqual(["1", "2"]);
    expect(ids({ request: "r1" })).toEqual(["2"]);
    expect(ids({ work: "w1" })).toEqual(["3"]);
    expect(ids({ kind: "after" })).toEqual(["3"]);
    expect(ids({ building: "b1", day: "2026-11-17" })).toEqual(["3"]);
  });

  it("R-008-30 日の範囲は、日本時間の0時から翌日の0時（UTC では前日の15時から）", () => {
    expect(dayRangeJst("2026-11-16")).toEqual({ from: "2026-11-15T15:00:00.000Z", to: "2026-11-16T15:00:00.000Z" });
    expect(dayRangeJst("2026-12-31")).toEqual({ from: "2026-12-30T15:00:00.000Z", to: "2026-12-31T15:00:00.000Z" });
    expect(dayRangeJst("")).toBeNull();
    expect(dayRangeJst("2026-13-45")).toBeNull();
  });

  it("R-008-31 撮る前の検査：建物が要る。種類は前・後・気づき。気づきから案件を作るなら題名が要る", () => {
    expect(KIND_OPTIONS.map((o) => o.value)).toEqual(["before", "after", "observation"]);
    expect(kindLabel("observation")).toBe("気づき");
    expect(validateCapture({ building_id: "", kind: "before" })).toEqual({ building_id: "建物を選んでください" });
    expect(validateCapture({ building_id: B, kind: "before" })).toEqual({});
    expect(validateCapture({ building_id: B, kind: "observation", makeRequest: true, title: " " })).toEqual({ title: "題名を入れてください" });
    expect(validateCapture({ building_id: B, kind: "before", makeRequest: true, title: "" })).toEqual({}); // 気づき以外では案件は作らない
    expect(validateCapture({ building_id: B, kind: "observation", makeRequest: true, title: "あ".repeat(101) })).toEqual({ title: "題名は 100 字までにしてください" });
  });

  it("R-008-35 直す・消すを出すのは、撮った本人だけ（判定は DB。ここは出し分け）", () => {
    expect(takenByMe(row({ taken_by: M }), M)).toBe(true);
    expect(takenByMe(row({ taken_by: M }), "other")).toBe(false);
  });
});
