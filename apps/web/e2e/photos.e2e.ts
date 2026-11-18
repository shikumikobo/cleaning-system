// 機能 008 の画面の流れ（Node 版 Playwright + Edge）。接続先は偽物。共通の偽の接続先（harness.ts）に、
// 写真・建物・場所・部屋・置き場所・期限つきの URL・案件の気づきの通信を、このファイルの中で足して上書きする。
import type { Server } from "node:http";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPABASE, TENANT_A, launch, newPage, newState, serveOut, tenant, type FakeMember } from "./harness";

let browser: Browser;
let server: Server;
let origin: string;

beforeAll(async () => {
  ({ server, origin } = await serveOut());
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  server?.close();
});

const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";
const BUILDINGS = [B1, B2].map((id, i) => ({ id, name: `テスト建物${i + 1}`, address: "東京都", lat: null, lng: null, client_id: "c1", owner_client_id: null, location_fixed: false, tenant_id: TENANT_A, deleted_at: null }));
const AREA = { id: "00000000-0000-4000-8000-0000000000a1", tenant_id: TENANT_A, building_id: B1, name: "エントランス", sort: 1, active: true, deleted_at: null };
const ROOM = { id: "00000000-0000-4000-8000-0000000000c1", tenant_id: TENANT_A, building_id: B1, room_no: "101", floor: 1, active: true, deleted_at: null };
const ME = "m-me";
const user = (role: FakeMember["role"]): FakeMember => ({ id: ME, tenant_id: TENANT_A, user_id: "u-me", status: "active", role, display_name: "テスト 太郎" });
const PERMS: Record<string, string[]> = { admin: ["master.edit", "field.record", "amount.read"], member: ["master.edit", "field.record", "amount.read"], staff: ["field.record"], external: [] };

interface Photo {
  id: string;
  tenant_id: string;
  building_id: string;
  area_id: string | null;
  room_id: string | null;
  work_id: string | null;
  report_item_id: string | null;
  request_id: string | null;
  kind: string;
  taken_at: string;
  taken_by: string;
  storage_path: string;
  thumb_path: string;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
  deleted_at: string | null;
}
interface Backend {
  photos: Photo[];
  /** 起きた順の記録 */
  log: string[];
  uploads: Array<{ path: string; bytes: Buffer }>;
  inserts: Array<Record<string, unknown>>;
  photoQueries: string[];
  signed: Array<{ ids: string[]; source: string; variant: string }>;
  rpcs: Array<Record<string, unknown>>;
  failInsertWith: { code: string; message: string } | null;
  /** true の間、接続先（Supabase）への通信を失敗させる（偽の接続先は route で答えるので、setOffline だけでは電波なしにならない） */
  offline: boolean;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-expose-headers": "*" };
// 1x1 の JPEG（外部の画像の置き場所の代わり）
const TINY_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

const photo = (id: string, over: Partial<Photo> = {}): Photo => ({
  id, tenant_id: TENANT_A, building_id: B1, area_id: null, room_id: null, work_id: null, report_item_id: null, request_id: null,
  kind: "before", taken_at: "2026-11-16T01:00:00.000Z", taken_by: ME, storage_path: `${TENANT_A}/photos/${id}/photo.jpg`, thumb_path: `${TENANT_A}/photos/${id}/thumb.jpg`,
  width: 1600, height: 1200, bytes: 300000, created_at: "2026-11-16T01:00:05.000Z", deleted_at: null, ...over,
});
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`.replace(/^00000000/, "0000face");

async function addBackend(ctx: BrowserContext, be: Backend, role: FakeMember["role"]) {
  const reply = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
  const wantsObject = (route: Route) => (route.request().headers()["accept"] ?? "").includes("vnd.pgrst.object");

  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/role_permissions`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const code = new URL(route.request().url()).searchParams.get("roles.code")?.replace("eq.", "") ?? "";
    return reply(route, 200, (PERMS[code] ?? []).map((c) => ({ permissions: { code: c } })));
  });
  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/buildings`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const id = new URL(route.request().url()).searchParams.get("id")?.replace("eq.", "");
    const rows = id ? BUILDINGS.filter((b) => b.id === id) : BUILDINGS;
    return wantsObject(route) ? (rows[0] ? reply(route, 200, rows[0]) : reply(route, 406, { code: "PGRST116", message: "none" })) : reply(route, 200, rows);
  });
  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/building_areas`), async (route) => (route.request().method() === "OPTIONS" ? route.fallback() : reply(route, 200, [AREA])));
  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/rooms`), async (route) => (route.request().method() === "OPTIONS" ? route.fallback() : reply(route, 200, [ROOM])));

  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/photos`), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const url = new URL(req.url());
    const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "") ?? null;
    if (req.method() === "GET") {
      be.photoQueries.push(url.search);
      let rows = be.photos.filter((p) => !p.deleted_at);
      if (eq("id")) rows = rows.filter((p) => p.id === eq("id"));
      if (eq("building_id")) rows = rows.filter((p) => p.building_id === eq("building_id"));
      if (eq("kind")) rows = rows.filter((p) => p.kind === eq("kind"));
      if (eq("request_id")) rows = rows.filter((p) => p.request_id === eq("request_id"));
      for (const t of url.searchParams.getAll("taken_at")) {
        if (t.startsWith("gte.")) rows = rows.filter((p) => p.taken_at >= t.slice(4));
        if (t.startsWith("lt.")) rows = rows.filter((p) => p.taken_at < t.slice(3));
      }
      rows = [...rows].sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1));
      be.log.push("rest:photos:get");
      return wantsObject(route) ? (rows[0] ? reply(route, 200, rows[0]) : reply(route, 406, { code: "PGRST116", message: "none" })) : reply(route, 200, rows);
    }
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
      if (be.failInsertWith) return reply(route, 403, be.failInsertWith);
      be.log.push(`rest:photos:insert:${body.id}`);
      be.inserts.push(body);
      if (!be.photos.some((p) => p.id === body.id)) be.photos.push({ ...photo(String(body.id)), ...(body as Partial<Photo>), created_at: new Date().toISOString() });
      return route.fulfill({ status: 201, headers: CORS, body: "" });
    }
    if (req.method() === "PATCH") {
      const body = JSON.parse(req.postData() ?? "{}");
      const row = be.photos.find((p) => p.id === eq("id"));
      if (!row) return reply(route, 404, { code: "PGRST116", message: "none" });
      Object.assign(row, body);
      be.log.push(`rest:photos:patch:${JSON.stringify(body)}`);
      return wantsObject(route) ? reply(route, 200, row) : reply(route, 200, [row]);
    }
    return route.fallback();
  });

  await ctx.route(new RegExp(`^${SUPABASE}/storage/v1/object/tenant-files`), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const path = decodeURIComponent(new URL(req.url()).pathname.replace("/storage/v1/object/tenant-files/", ""));
    be.log.push(`storage:upload:${path}`);
    be.uploads.push({ path, bytes: req.postDataBuffer() ?? Buffer.alloc(0) });
    return reply(route, 200, { Key: `tenant-files/${path}`, Id: "obj" });
  });

  await ctx.route(new RegExp(`^${SUPABASE}/functions/v1/sign-file-urls`), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const b = JSON.parse(req.postData() ?? "{}") as { ids: string[]; source: string; variant: string };
    be.signed.push(b);
    const visible = be.photos.filter((p) => b.ids.includes(p.id) && !p.deleted_at);
    return reply(route, 200, {
      urls: Object.fromEntries(visible.map((p) => [p.id, `https://files.example.test/${p.id}/${b.variant ?? "original"}.jpg`])),
      not_found: b.ids.filter((i) => !visible.some((p) => p.id === i)),
      failed: [],
      expires_in: 600,
    });
  });
  await ctx.route("https://files.example.test/**", (route) => route.fulfill({ status: 200, headers: { "content-type": "image/jpeg", "access-control-allow-origin": "*" }, body: TINY_JPEG }));

  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/rpc/create_request_from_observation`), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const b = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    be.rpcs.push(b);
    be.log.push(`rpc:create_request_from_observation:${b.p_id}`);
    for (const id of (b.p_photo_ids as string[] | null) ?? []) {
      const row = be.photos.find((p) => p.id === id);
      if (row) row.request_id = String(b.p_id);
    }
    return reply(route, 200, { ok: true, id: b.p_id, already: false, photos: ((b.p_photo_ids as string[] | null) ?? []).length });
  });
  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/requests`), async (route) => (route.request().method() === "OPTIONS" ? route.fallback() : reply(route, 200, [])));
  // 電波なし：いちばん後に足した route が先に効く。offline の間だけ失敗させ、それ以外は前の route に渡す
  await ctx.route(new RegExp(`^${SUPABASE}/`), async (route) => (be.offline ? route.abort("internetdisconnected") : route.fallback()));
  void role;
}

async function setup(role: FakeMember["role"], photos: Photo[] = []) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [user(role)] });
  const be: Backend = { photos, log: [], uploads: [], inserts: [], photoQueries: [], signed: [], rpcs: [], failInsertWith: null, offline: false };
  const { ctx, page } = await newPage(browser, st);
  await addBackend(ctx, be, role);
  page.on("dialog", (d) => void d.accept());
  return { ctx, page, be };
}

/** 位置（GPS）つきの Exif を持つ JPEG を、画面の canvas で作って、APP1 を足す */
async function jpegWithGps(page: Page, w = 3000, h = 2000): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([cw, ch]) => {
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      const g = c.getContext("2d")!;
      g.fillStyle = "#4a7";
      g.fillRect(0, 0, cw, ch);
      g.fillStyle = "#fff";
      g.fillRect(cw / 4, ch / 4, cw / 2, ch / 2);
      const blob: Blob = await new Promise((r) => c.toBlob((x) => r(x as Blob), "image/jpeg", 0.9));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const v of bytes) s += String.fromCharCode(v);
      return btoa(s);
    },
    [w, h],
  );
  const src = Buffer.from(b64, "base64");
  const payload = Buffer.from("Exif\0\0GPSLatitude=35.6812;GPSLongitude=139.7671;Make=TestCam");
  const len = payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), payload]);
  return Buffer.concat([src.subarray(0, 2), app1, src.subarray(2)]);
}
async function dims(page: Page, bytes: Buffer): Promise<{ w: number; h: number }> {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([arr], { type: "image/jpeg" }));
    return { w: bmp.width, h: bmp.height };
  }, bytes.toString("base64"));
}
const shot = (buffer: Buffer) => ({ name: "camera.jpg", mimeType: "image/jpeg", buffer });
const uploadedName = (u: { path: string }) => u.path.split("/").slice(-1)[0];

describe("撮る", () => {
  it("R-008-31 R-008-22 R-008-23 R-008-24 撮ると、端末で縮小して Exif の位置を消し、元の画像 → 小さな画像 → 行の順に送る", async () => {
    const { ctx, page, be } = await setup("staff");
    await page.goto(`${origin}/photos/new/`);
    await page.getByLabel("建物").selectOption(B1);
    await page.getByLabel("種類", { exact: true }).selectOption("after");
    await page.getByLabel("場所").selectOption(AREA.id);
    await page.getByLabel("部屋", { exact: true }).selectOption(ROOM.id);
    const src = await jpegWithGps(page);
    expect(src.toString("latin1")).toContain("GPSLatitude"); // 元の画像には位置がある
    await page.getByLabel("写真を撮る").setInputFiles(shot(src));
    await page.getByText("撮りました").waitFor();
    const order = be.log.filter((l) => l.startsWith("storage:upload") || l.startsWith("rest:photos:insert"));
    expect(order).toHaveLength(3);
    expect(order[0]).toMatch(new RegExp(`^storage:upload:${TENANT_A}/photos/[0-9a-f-]{36}/photo\\.jpg$`));
    expect(order[1]).toMatch(new RegExp(`^storage:upload:${TENANT_A}/photos/[0-9a-f-]{36}/thumb\\.jpg$`));
    expect(order[2]).toMatch(/^rest:photos:insert:[0-9a-f-]{36}$/);
    const [big, small] = [be.uploads.find((u) => uploadedName(u) === "photo.jpg")!, be.uploads.find((u) => uploadedName(u) === "thumb.jpg")!];
    // 位置・撮影機の情報が、どちらにも入っていない（R-008-23）
    for (const u of [big, small]) {
      expect([...u.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      const text = u.bytes.toString("latin1");
      expect(text).not.toContain("GPS");
      expect(text).not.toContain("Exif");
      expect(text).not.toContain("TestCam");
    }
    // 縮小（R-008-22）：3000x2000 → 長辺 1600 と 320
    expect(await dims(page, big.bytes)).toEqual({ w: 1600, h: 1067 });
    expect(await dims(page, small.bytes)).toEqual({ w: 320, h: 213 });
    const row = be.inserts[0];
    expect(row).toMatchObject({ tenant_id: TENANT_A, building_id: B1, area_id: AREA.id, room_id: ROOM.id, kind: "after", taken_by: ME, width: 1600, height: 1067 });
    expect(String(row.storage_path)).toBe(`${TENANT_A}/photos/${row.id}/photo.jpg`);
    expect(String(row.thumb_path)).toBe(`${TENANT_A}/photos/${row.id}/thumb.jpg`);
    expect(row.bytes).toBe(big.bytes.length);
    await ctx.close();
  });

  it("R-008-31 建物を選んでいなければ、撮っても送らず、理由を出す。カメラの入力は端末のカメラを開く形（capture）", async () => {
    const { ctx, page, be } = await setup("staff");
    await page.goto(`${origin}/photos/new/`);
    expect(await page.getByLabel("写真を撮る").getAttribute("capture")).toBe("environment");
    expect(await page.getByLabel("写真を撮る").getAttribute("accept")).toBe("image/*");
    await page.getByLabel("写真を撮る").setInputFiles(shot(await jpegWithGps(page, 400, 300)));
    await page.getByText("建物を選んでください").waitFor();
    expect(be.uploads).toHaveLength(0);
    expect(await page.getByTestId("pending-photos").count()).toBe(0);
    await ctx.close();
  });

  it("R-008-24 R-008-25 R-008-37 電波がないときは端末にため、件数を出す。戻ったら自動で送り、二度送らない（1件）", async () => {
    const { ctx, page, be } = await setup("staff");
    await page.goto(`${origin}/photos/new/`);
    await page.getByLabel("建物").selectOption(B1);
    be.offline = true;
    await ctx.setOffline(true);
    await page.getByLabel("写真を撮る").setInputFiles(shot(await jpegWithGps(page, 800, 600)));
    await page.getByText("電波がないので、端末にためました").waitFor();
    await page.getByText("送れていない写真：1 件").waitFor();
    expect(be.inserts).toHaveLength(0);
    be.offline = false;
    await ctx.setOffline(false);
    await expect.poll(() => be.inserts.length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => page.getByTestId("pending-photos").count(), { timeout: 15_000 }).toBe(0);
    // しばらく待っても、同じ写真は増えない
    await page.waitForTimeout(1500);
    expect(be.inserts).toHaveLength(1);
    expect(be.photos).toHaveLength(1);
    expect(be.uploads.map(uploadedName)).toEqual(["photo.jpg", "thumb.jpg"]);
    await ctx.close();
  });

  it("R-008-26 R-008-37 サーバーに断られた写真は、理由つきで「送れていない」に残り、あきらめて端末から消せる", async () => {
    const { ctx, page, be } = await setup("staff");
    be.failInsertWith = { code: "42501", message: "new row violates row-level security policy" };
    await page.goto(`${origin}/photos/new/`);
    await page.getByLabel("建物").selectOption(B1);
    await page.getByLabel("写真を撮る").setInputFiles(shot(await jpegWithGps(page, 800, 600)));
    await page.getByTestId("stuck-photo").waitFor();
    expect(await page.getByTestId("stuck-photo").innerText()).toContain("この操作をする権限がありません");
    expect(await page.getByText("送れていない写真：1 件").count()).toBe(1);
    await page.getByRole("button", { name: "あきらめて消す" }).click();
    await expect.poll(() => page.getByTestId("pending-photos").count()).toBe(0);
    await ctx.close();
  });

  it("R-008-27 気づきを案件にもすると、案件の気づきを先に送り、写真の行に案件の uuid を入れる（電波がない間も、戻ってから正しい順で届く）", async () => {
    const { ctx, page, be } = await setup("staff");
    await page.goto(`${origin}/photos/new/`);
    await page.getByLabel("建物").selectOption(B1);
    await page.getByLabel("種類", { exact: true }).selectOption("observation");
    await page.getByLabel("この気づきを案件にもする").check();
    await page.getByLabel("題名").fill("廊下の天井にしみ");
    be.offline = true;
    await ctx.setOffline(true);
    await page.getByLabel("写真を撮る").setInputFiles(shot(await jpegWithGps(page, 800, 600)));
    await page.getByText("電波がないので、端末にためました").waitFor();
    be.offline = false;
    await ctx.setOffline(false);
    await expect.poll(() => be.inserts.length, { timeout: 15_000 }).toBe(1);
    const rpcAt = be.log.findIndex((l) => l.startsWith("rpc:create_request_from_observation:"));
    const insertAt = be.log.findIndex((l) => l.startsWith("rest:photos:insert:"));
    expect(rpcAt).toBeGreaterThanOrEqual(0);
    expect(rpcAt).toBeLessThan(insertAt);
    expect(be.rpcs[0]).toMatchObject({ p_building_id: B1, p_title: "廊下の天井にしみ" });
    expect(be.inserts[0]).toMatchObject({ kind: "observation", request_id: be.rpcs[0].p_id });
    await ctx.close();
  });

  it("R-008-31 題名のない「案件にもする」は、撮っても送らない", async () => {
    const { ctx, page, be } = await setup("staff");
    await page.goto(`${origin}/photos/new/`);
    await page.getByLabel("建物").selectOption(B1);
    await page.getByLabel("種類", { exact: true }).selectOption("observation");
    await page.getByLabel("この気づきを案件にもする").check();
    await page.getByLabel("写真を撮る").setInputFiles(shot(await jpegWithGps(page, 400, 300)));
    await page.getByText("題名を入れてください").waitFor();
    expect(be.uploads).toHaveLength(0);
    expect(be.rpcs).toHaveLength(0);
    await ctx.close();
  });
});

describe("一覧・詳細", () => {
  const P1 = pid(1);
  const P2 = pid(2);
  const P3 = pid(3);
  const rows = () => [
    photo(P1, { kind: "before", taken_at: "2026-11-16T01:00:00.000Z" }),
    photo(P2, { kind: "observation", taken_at: "2026-11-16T05:00:00.000Z", building_id: B2 }),
    photo(P3, { kind: "after", taken_at: "2026-11-17T05:00:00.000Z", taken_by: "someone-else" }),
  ];

  it("R-008-32 R-008-29 一覧は、新しい日から日ごとに並び、小さな画像の URL だけを取る（元の画像は取らない）", async () => {
    const { ctx, page, be } = await setup("member", rows());
    await page.goto(`${origin}/photos/`);
    await page.getByTestId("photo-cell").first().waitFor();
    const headings = await page.locator("h2.p-day").allInnerTexts();
    expect(headings).toEqual(["2026-11-17", "2026-11-16"]);
    expect(await page.getByTestId("photo-cell").count()).toBe(3);
    await expect.poll(() => be.signed.length).toBeGreaterThan(0);
    expect(be.signed.every((s) => s.source === "photos" && s.variant === "thumb")).toBe(true);
    expect(be.signed.some((s) => s.variant === "original")).toBe(false);
    await page.locator("img[alt^='作業前']").waitFor();
    expect(await page.locator("img[alt^='作業前']").getAttribute("src")).toBe(`https://files.example.test/${P1}/thumb.jpg`);
    await ctx.close();
  });

  it("R-008-32 R-008-29 建物・日・種類で絞り込むと、その条件で読み直す（日は日本時間の0時から）", async () => {
    const { ctx, page, be } = await setup("member", rows());
    await page.goto(`${origin}/photos/`);
    await page.getByTestId("photo-cell").first().waitFor();
    await page.getByLabel("建物").selectOption(B2);
    await expect.poll(() => page.getByTestId("photo-cell").count()).toBe(1);
    await page.getByLabel("建物").selectOption("");
    await page.getByLabel("日").fill("2026-11-16");
    await expect.poll(() => page.getByTestId("photo-cell").count()).toBe(2);
    const q = be.photoQueries.at(-1) ?? "";
    expect(decodeURIComponent(q)).toContain("taken_at=gte.2026-11-15T15:00:00.000Z");
    expect(decodeURIComponent(q)).toContain("taken_at=lt.2026-11-16T15:00:00.000Z");
    await page.getByLabel("種類", { exact: true }).selectOption("observation");
    await expect.poll(() => page.getByTestId("photo-cell").count()).toBe(1);
    await ctx.close();
  });

  it("R-008-29 案件・作業で絞り込める（?request=）", async () => {
    const REQ = pid(99);
    const { ctx, page } = await setup("member", [photo(P1, { request_id: REQ }), photo(P2), photo(P3)]);
    await page.goto(`${origin}/photos/?request=${REQ}`);
    await page.getByTestId("photo-cell").first().waitFor();
    expect(await page.getByTestId("photo-cell").count()).toBe(1);
    await page.getByText("案件で絞り込んでいます").waitFor();
    await ctx.close();
  });

  it("R-008-33 詳細：元の画像を期限つきの URL で出し、撮った日時（日本時間）・建物・場所・部屋・案件へのリンクを出す", async () => {
    const REQ = pid(98);
    const { ctx, page, be } = await setup("member", [photo(P1, { area_id: AREA.id, room_id: ROOM.id, request_id: REQ, taken_at: "2026-11-16T15:30:00.000Z" })]);
    await page.goto(`${origin}/photos/detail/?id=${P1}`);
    await page.locator("img.p-full").waitFor();
    expect(await page.locator("img.p-full").getAttribute("src")).toBe(`https://files.example.test/${P1}/original.jpg`);
    expect(be.signed).toEqual([{ ids: [P1], source: "photos", variant: "original" }]);
    const info = await page.getByTestId("photo-info").innerText();
    expect(info).toContain("2026-11-17 00:30");
    expect(info).toContain("テスト建物1");
    expect(info).toContain("エントランス");
    expect(info).toContain("101");
    expect(await page.getByRole("link", { name: "つながっている案件を見る" }).getAttribute("href")).toContain(`/requests/detail/?id=${REQ}`);
    await ctx.close();
  });

  it("R-008-34 R-008-35 撮った本人は、種類と場所を直して保存でき、消せる（論理削除）", async () => {
    const { ctx, page, be } = await setup("staff", [photo(P1)]);
    await page.goto(`${origin}/photos/detail/?id=${P1}`);
    await page.getByLabel("種類を直す").selectOption("after");
    await page.getByLabel("場所を直す").selectOption(AREA.id);
    await page.getByRole("button", { name: "保存する" }).click();
    await page.getByText("保存しました").waitFor();
    expect(be.photos[0]).toMatchObject({ kind: "after", area_id: AREA.id });
    expect(be.log).toContain(`rest:photos:patch:${JSON.stringify({ kind: "after", area_id: AREA.id, room_id: null })}`);
    await page.getByRole("button", { name: "消す" }).click();
    await page.getByText("消しました").waitFor();
    expect(be.photos[0].deleted_at).toBeTruthy();
    await ctx.close();
  });

  it("R-008-35 撮った本人でない人（読むだけの社員）には、直す・消すを出さない", async () => {
    const { ctx, page } = await setup("member", [photo(P3, { taken_by: "someone-else" })]);
    await page.goto(`${origin}/photos/detail/?id=${P3}`);
    await page.locator("img.p-full").waitFor();
    expect(await page.getByRole("button", { name: /保存する|消す/ }).count()).toBe(0);
    await page.getByText("種類と場所を直せるのは、撮った本人").waitFor();
    await ctx.close();
  });
});

describe("気づきから案件", () => {
  it("R-008-36 気づきの写真を選んで題名を入れると、003 の RPC に写真の ID を渡し、案件の画面へ移る。案件に付いた写真は候補に出ない", async () => {
    const O1 = pid(11);
    const O2 = pid(12);
    const { ctx, page, be } = await setup("staff", [
      photo(O1, { kind: "observation" }),
      photo(O2, { kind: "observation", taken_at: "2026-11-16T02:00:00.000Z" }),
      photo(pid(13), { kind: "observation", request_id: pid(97) }), // すでに案件に付いている
      photo(pid(14), { kind: "before" }), // 気づきではない
    ]);
    await page.goto(`${origin}/photos/request/`);
    await page.getByLabel("建物").selectOption(B1);
    await page.getByTestId("observation-cell").first().waitFor();
    expect(await page.getByTestId("observation-cell").count()).toBe(2);
    await page.getByLabel("気づきの写真を選ぶ").first().check();
    await page.getByLabel("題名").fill("階段の手すりが緩んでいる");
    await page.getByLabel("分類").selectOption("repair");
    await page.getByRole("button", { name: "案件にする" }).click();
    await page.waitForURL("**/requests/detail/**");
    expect(be.rpcs).toHaveLength(1);
    expect(be.rpcs[0]).toMatchObject({ p_building_id: B1, p_title: "階段の手すりが緩んでいる", p_category: "repair" });
    expect((be.rpcs[0].p_photo_ids as string[]).length).toBe(1);
    expect([O1, O2]).toContain((be.rpcs[0].p_photo_ids as string[])[0]);
    expect(page.url()).toContain(`id=${be.rpcs[0].p_id}`);
    expect(be.photos.filter((p) => p.request_id === be.rpcs[0].p_id)).toHaveLength(1);
    await ctx.close();
  });

  it("R-008-36 写真を選ばない・題名がないときは、送らず理由を出す", async () => {
    const { ctx, page, be } = await setup("staff", [photo(pid(11), { kind: "observation" })]);
    await page.goto(`${origin}/photos/request/`);
    await page.getByLabel("建物").selectOption(B1);
    await page.getByTestId("observation-cell").first().waitFor();
    await page.getByRole("button", { name: "案件にする" }).click();
    await page.getByText("写真を1枚以上選んでください").waitFor();
    await page.getByText("題名を入れてください").waitFor();
    expect(be.rpcs).toHaveLength(0);
    await ctx.close();
  });

  it("R-008-36 詳細の「この気づきを案件にする」から、その写真を選んだ状態で開く", async () => {
    const O1 = pid(11);
    const { ctx, page } = await setup("staff", [photo(O1, { kind: "observation" })]);
    await page.goto(`${origin}/photos/detail/?id=${O1}`);
    await page.getByRole("link", { name: "この気づきを案件にする" }).click();
    await page.getByTestId("observation-cell").first().waitFor();
    expect(await page.getByLabel("気づきの写真を選ぶ").isChecked()).toBe(true);
    await ctx.close();
  });
});

describe("入口", () => {
  it("R-008-32 ホームに「現場の写真」のリンクがあり、押すと一覧が開く", async () => {
    const { ctx, page } = await setup("staff");
    await page.goto(`${origin}/`);
    await page.getByRole("link", { name: "現場の写真" }).click();
    await page.getByRole("heading", { name: "現場の写真" }).waitFor();
    await ctx.close();
  });
});
