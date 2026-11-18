// 機能 009 の画面の流れ（Node 版 Playwright + Edge）。接続先は偽物。共通の偽の接続先（harness.ts）に、
// 作業・報告書・項目・ひな形・写真・建物・置き場所・期限つきの URL・確認と提出の RPC の通信を、このファイルの中で足して上書きする。
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
const BUILDINGS = [{ id: B1, name: "テスト建物1", address: "東京都1-1", lat: null, lng: null, client_id: "c1", owner_client_id: null, location_fixed: false, tenant_id: TENANT_A, deleted_at: null }];
const AREA = { id: "00000000-0000-4000-8000-0000000000a1", tenant_id: TENANT_A, building_id: B1, name: "エントランス", sort: 1, active: true, deleted_at: null };
const W1 = "00000000-0000-4000-8000-0000000000e1"; // ひな形つきの作業（報告書はまだない）
const W2 = "00000000-0000-4000-8000-0000000000e2"; // 下書きの報告書がある作業
const W3 = "00000000-0000-4000-8000-0000000000e3"; // 提出済みの報告書がある作業
const TPL = "00000000-0000-4000-8000-0000000000d1";
const ME = "m-me";
const user = (role: FakeMember["role"]): FakeMember => ({ id: ME, tenant_id: TENANT_A, user_id: "u-me", status: "active", role, display_name: "テスト 太郎" });
const PERMS: Record<string, string[]> = {
  admin: ["master.edit", "field.record", "amount.read", "work.assign"],
  member: ["master.edit", "field.record", "amount.read", "work.assign"],
  staff: ["field.record"],
  external: [],
};
const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

interface Obj {
  [k: string]: unknown;
}
interface Backend {
  works: Obj[];
  reports: Obj[];
  items: Obj[];
  templates: Obj[];
  tItems: Obj[];
  photos: Obj[];
  /** 起きた順の記録 */
  log: string[];
  rpcs: Array<{ name: string; body: Obj }>;
  uploads: string[];
  offline: boolean;
  failReportInsert: { code: string; message: string } | null;
  /** 外部の人の許された建物 */
  externalBuildings: string[];
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-expose-headers": "*" };
const TINY_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

const work = (id: string, title: string, over: Obj = {}): Obj => ({
  id, tenant_id: TENANT_A, building_id: B1, title, scheduled_date: todayJst(), status: "scheduled", report_template_id: TPL, deleted_at: null, ...over,
});
const report = (id: string, workId: string, status: string, over: Obj = {}): Obj => ({
  id, tenant_id: TENANT_A, work_id: workId, template_id: TPL, status, remarks: "", checked_by: null, checked_at: null, submitted_by: null, submitted_at: null,
  version: 1, created_at: "2026-11-20T00:00:00.000Z", deleted_at: null, ...over,
});
const item = (id: string, reportId: string, name: string, sort: number, over: Obj = {}): Obj => ({
  id, tenant_id: TENANT_A, report_id: reportId, template_item_id: null, area_id: null, name, sort, done: false, note: "", deleted_at: null, ...over,
});
const tItem = (id: string, name: string, sort: number, over: Obj = {}): Obj => ({ id, tenant_id: TENANT_A, template_id: TPL, area_id: null, name, sort, active: true, deleted_at: null, ...over });

function newBackend(over: Partial<Backend> = {}): Backend {
  return {
    works: [work(W1, "定期清掃（新規）"), work(W2, "定期清掃（下書き）", { scheduled_date: "2026-11-10" }), work(W3, "定期清掃（提出済み）", { scheduled_date: "2026-11-09" })],
    reports: [report("r2", W2, "draft", { remarks: "下書きのメモ" }), report("r3", W3, "submitted", { checked_by: ME, checked_at: "2026-11-10T00:00:00Z", submitted_by: ME, submitted_at: "2026-11-11T00:00:00Z" })],
    items: [item("i2a", "r2", "エントランス", 1, { done: true, note: "拭いた" }), item("i2b", "r2", "ゴミ置き場", 2), item("i3a", "r3", "階段", 1, { done: true })],
    templates: [{ id: TPL, tenant_id: TENANT_A, building_id: B1, name: "定期清掃のひな形", active: true, deleted_at: null }],
    tItems: [tItem("t1", "エントランスの床", 1, { area_id: AREA.id }), tItem("t2", "ゴミ置き場", 2), tItem("t3", "もう使わない", 3, { active: false })],
    photos: [],
    log: [],
    rpcs: [],
    uploads: [],
    offline: false,
    failReportInsert: null,
    externalBuildings: [B1],
    ...over,
  };
}

async function addBackend(ctx: BrowserContext, be: Backend, role: FakeMember["role"]) {
  const reply = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
  const wantsObject = (route: Route) => (route.request().headers()["accept"] ?? "").includes("vnd.pgrst.object");
  const q = (route: Route) => new URL(route.request().url()).searchParams;
  const eqv = (route: Route, k: string) => {
    const v = q(route).get(k);
    return v?.startsWith("eq.") ? v.slice(3) : null;
  };
  const inv = (route: Route, k: string) => {
    const v = q(route).get(k);
    const m = v ? /^in\.\((.*)\)$/.exec(v) : null;
    return m ? m[1].split(",").map((s) => s.replace(/^"|"$/g, "")) : null;
  };
  const send = (route: Route, rows: Obj[]) => (wantsObject(route) ? (rows[0] ? reply(route, 200, rows[0]) : reply(route, 406, { code: "PGRST116", message: "none" })) : reply(route, 200, rows));
  const bodyOf = (route: Route) => JSON.parse(route.request().postData() ?? "null");
  const isExternal = role === "external";
  const on = (table: string, handler: (route: Route, method: string) => Promise<void> | void) =>
    ctx.route(new RegExp(`^${SUPABASE}/rest/v1/${table}(\\?|$)`), async (route) => {
      const m = route.request().method();
      if (m === "OPTIONS") return route.fallback();
      return handler(route, m);
    });

  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/role_permissions`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const code = q(route).get("roles.code")?.replace("eq.", "") ?? "";
    return reply(route, 200, (PERMS[code] ?? []).map((c) => ({ permissions: { code: c } })));
  });
  await on("buildings", (route) => {
    const id = eqv(route, "id");
    return send(route, BUILDINGS.filter((b) => !id || b.id === id));
  });
  await on("building_areas", (route) => reply(route, 200, [AREA]));
  await on("rooms", (route) => reply(route, 200, []));

  await on("works", (route) => {
    const id = eqv(route, "id");
    const b = eqv(route, "building_id");
    let rows = be.works.filter((w) => !w.deleted_at && (!id || w.id === id) && (!b || w.building_id === b));
    if (isExternal && !be.externalBuildings.includes(String(b))) rows = [];
    return send(route, rows);
  });

  await on("reports", async (route, m) => {
    if (m === "GET") {
      const id = eqv(route, "id");
      const wid = eqv(route, "work_id");
      const wins = inv(route, "work_id");
      const st = eqv(route, "status");
      let rows = be.reports.filter((r) => !r.deleted_at && (!id || r.id === id) && (!wid || r.work_id === wid) && (!wins || wins.includes(String(r.work_id))) && (!st || r.status === st));
      if (isExternal) rows = rows.filter((r) => r.status === "submitted");
      be.log.push("rest:reports:get");
      return send(route, rows);
    }
    if (m === "POST") {
      const b = bodyOf(route) as Obj;
      if (be.failReportInsert) return reply(route, 403, be.failReportInsert);
      be.log.push(`rest:reports:insert:${b.id}`);
      if (!be.reports.some((r) => r.id === b.id)) be.reports.push({ ...report(String(b.id), String(b.work_id), "draft"), ...b, version: 1, created_at: new Date().toISOString() });
      return route.fulfill({ status: 201, headers: CORS, body: "" });
    }
    if (m === "PATCH") {
      const b = bodyOf(route) as Obj;
      const row = be.reports.find((r) => r.id === eqv(route, "id") && (!eqv(route, "version") || String(r.version) === eqv(route, "version")));
      if (!row || row.status !== "draft") return reply(route, 200, []);
      Object.assign(row, b);
      be.log.push(`rest:reports:patch:${JSON.stringify(b)}`);
      return reply(route, 200, [{ id: row.id }]);
    }
    return route.fallback();
  });

  await on("report_items", async (route, m) => {
    if (m === "GET") {
      const rid = eqv(route, "report_id");
      const id = eqv(route, "id");
      const rins = inv(route, "report_id");
      return send(route, be.items.filter((i) => !i.deleted_at && (!rid || i.report_id === rid) && (!id || i.id === id) && (!rins || rins.includes(String(i.report_id)))));
    }
    if (m === "POST") {
      const rows = (bodyOf(route) as Obj[]) ?? [];
      be.log.push(`rest:report_items:insert:${rows.length}`);
      for (const r of rows) if (!be.items.some((i) => i.id === r.id)) be.items.push({ ...item(String(r.id), String(r.report_id), String(r.name), Number(r.sort)), ...r });
      return route.fulfill({ status: 201, headers: CORS, body: "" });
    }
    if (m === "PATCH") {
      const b = bodyOf(route) as Obj;
      const row = be.items.find((i) => i.id === eqv(route, "id"));
      const rep = be.reports.find((r) => r.id === row?.report_id);
      if (!row || !rep || rep.status !== "draft") return reply(route, 200, []);
      Object.assign(row, b);
      be.log.push(`rest:report_items:patch:${row.id}`);
      return reply(route, 200, [{ id: row.id }]);
    }
    return route.fallback();
  });

  await on("report_templates", async (route, m) => {
    if (m === "GET") {
      const b = eqv(route, "building_id");
      return send(route, be.templates.filter((t) => !t.deleted_at && (!b || t.building_id === b)));
    }
    if (m === "POST") {
      const b = bodyOf(route) as Obj;
      const row = { id: `tpl-${be.templates.length + 1}`, active: true, deleted_at: null, ...b };
      be.templates.push(row);
      be.log.push(`rest:report_templates:insert:${b.name}`);
      return wantsObject(route) ? reply(route, 201, row) : reply(route, 201, [row]);
    }
    if (m === "PATCH") {
      const b = bodyOf(route) as Obj;
      const row = be.templates.find((t) => t.id === eqv(route, "id"))!;
      Object.assign(row, b);
      be.log.push(`rest:report_templates:patch:${JSON.stringify(b)}`);
      return wantsObject(route) ? reply(route, 200, row) : reply(route, 200, [row]);
    }
    return route.fallback();
  });
  await on("template_items", async (route, m) => {
    if (m === "GET") {
      const ids = inv(route, "template_id");
      return send(route, be.tItems.filter((t) => !t.deleted_at && (!ids || ids.includes(String(t.template_id)))));
    }
    if (m === "POST") {
      const b = bodyOf(route) as Obj;
      const row = { id: `ti-${be.tItems.length + 1}`, active: true, deleted_at: null, ...b };
      be.tItems.push(row);
      be.log.push(`rest:template_items:insert:${b.name}`);
      return wantsObject(route) ? reply(route, 201, row) : reply(route, 201, [row]);
    }
    if (m === "PATCH") {
      const b = bodyOf(route) as Obj;
      const row = be.tItems.find((t) => t.id === eqv(route, "id"))!;
      Object.assign(row, b);
      be.log.push(`rest:template_items:patch:${row.id}:${JSON.stringify(b)}`);
      return wantsObject(route) ? reply(route, 200, row) : reply(route, 200, [row]);
    }
    return route.fallback();
  });

  await on("photos", async (route, m) => {
    if (m === "GET") {
      const w = eqv(route, "work_id");
      const b = eqv(route, "building_id");
      let rows = be.photos.filter((p) => !p.deleted_at && (!w || p.work_id === w) && (!b || p.building_id === b));
      if (q(route).get("report_item_id")?.startsWith("not.is")) rows = rows.filter((p) => p.report_item_id);
      if (isExternal) rows = rows.filter((p) => p.report_item_id);
      return send(route, rows);
    }
    if (m === "POST") {
      const b = bodyOf(route) as Obj;
      be.log.push(`rest:photos:insert:${b.id}`);
      if (!be.photos.some((p) => p.id === b.id)) be.photos.push({ ...b, created_at: new Date().toISOString(), deleted_at: null });
      return route.fulfill({ status: 201, headers: CORS, body: "" });
    }
    return route.fallback();
  });
  await ctx.route(new RegExp(`^${SUPABASE}/storage/v1/object/tenant-files`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace("/storage/v1/object/tenant-files/", ""));
    be.log.push(`storage:upload:${path.split("/").pop()}`);
    be.uploads.push(path);
    return reply(route, 200, { Key: `tenant-files/${path}`, Id: "obj" });
  });
  await ctx.route(new RegExp(`^${SUPABASE}/functions/v1/sign-file-urls`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const b = bodyOf(route) as { ids: string[]; variant?: string };
    const visible = be.photos.filter((p) => b.ids.includes(String(p.id)));
    return reply(route, 200, {
      urls: Object.fromEntries(visible.map((p) => [p.id, `https://files.example.test/${p.id}/${b.variant ?? "original"}.jpg`])),
      not_found: b.ids.filter((i) => !visible.some((p) => p.id === i)),
      failed: [],
      expires_in: 600,
    });
  });
  await ctx.route("https://files.example.test/**", (route) => route.fulfill({ status: 200, headers: { "content-type": "image/jpeg", "access-control-allow-origin": "*" }, body: TINY_JPEG }));

  // 確認・差し戻し・提出・消す RPC
  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/rpc/`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    const b = bodyOf(route) as Obj;
    be.rpcs.push({ name, body: b });
    be.log.push(`rpc:${name}`);
    const rep = be.reports.find((r) => r.id === b.p_id);
    if (name === "check_report" && rep) {
      if (rep.status === "draft") Object.assign(rep, { status: "checked", checked_by: ME, checked_at: new Date().toISOString(), version: Number(rep.version) + 1 });
      return reply(route, 200, { ok: true, status: rep.status, version: rep.version });
    }
    if (name === "reopen_report" && rep) {
      if (rep.status === "checked") Object.assign(rep, { status: "draft", checked_by: null, checked_at: null, version: Number(rep.version) + 1 });
      return reply(route, 200, { ok: true, status: rep.status, version: rep.version });
    }
    if (name === "submit_report" && rep) {
      if (rep.status !== "checked") return reply(route, 200, { ok: false, reason: "not_checked" });
      Object.assign(rep, { status: "submitted", submitted_by: ME, submitted_at: new Date().toISOString(), version: Number(rep.version) + 1 });
      return reply(route, 200, { ok: true, status: "submitted", version: rep.version });
    }
    if (name === "delete_report_template") {
      const t = be.templates.find((x) => x.id === b.p_id);
      if (t) t.active = false;
      return reply(route, 200, { ok: true, deleted: false, deactivated: true, blockers: [{ reason: "used_by_works", table: "works", count: 3 }] });
    }
    if (name === "delete_template_item") {
      const t = be.tItems.find((x) => x.id === b.p_id);
      if (t) t.deleted_at = new Date().toISOString();
      return reply(route, 200, { ok: true, deleted: true });
    }
    return reply(route, 404, { message: "no rpc" });
  });

  // 外部の人の許された建物
  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/external_building_access`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    return reply(route, 200, be.externalBuildings.map((b) => ({ membership_id: ME, building_id: b })));
  });
  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/files`), async (route) => (route.request().method() === "OPTIONS" ? route.fallback() : reply(route, 200, [])));
  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/quotes`), async (route) => (route.request().method() === "OPTIONS" ? route.fallback() : reply(route, 200, [])));
  // 電波なし：いちばん後に足した route が先に効く。offline の間だけ失敗させ、それ以外は前の route に渡す
  await ctx.route(new RegExp(`^${SUPABASE}/`), async (route) => (be.offline ? route.abort("internetdisconnected") : route.fallback()));
}

async function setup(role: FakeMember["role"], over: Partial<Backend> = {}) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [user(role)] });
  const be = newBackend(over);
  const { ctx, page } = await newPage(browser, st);
  await addBackend(ctx, be, role);
  page.on("dialog", (d) => void d.accept());
  return { ctx, page, be };
}

async function jpeg(page: Page, w = 800, h = 600): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([cw, ch]) => {
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      const g = c.getContext("2d")!;
      g.fillStyle = "#4a7";
      g.fillRect(0, 0, cw, ch);
      const blob: Blob = await new Promise((r) => c.toBlob((x) => r(x as Blob), "image/jpeg", 0.9));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const v of bytes) s += String.fromCharCode(v);
      return btoa(s);
    },
    [w, h],
  );
  return Buffer.from(b64, "base64");
}

describe("入口・一覧", () => {
  it("R-009-37 ホームに「清掃報告書」のリンクがある", async () => {
    const { ctx, page } = await setup("staff");
    await page.goto(`${origin}/`);
    const link = page.getByRole("link", { name: "清掃報告書" });
    await link.waitFor();
    expect(await link.getAttribute("href")).toBe("/reports/");
    await ctx.close();
  });

  it("R-009-31 一覧：作業ごとに報告書の状況が出る。スタッフは「報告書を作る・開く」だけ。状況で絞れる", async () => {
    const { ctx, page } = await setup("staff");
    await page.goto(`${origin}/reports/`);
    await page.getByTestId("report-row").first().waitFor();
    const rows = page.getByTestId("report-row");
    expect(await rows.count()).toBe(3);
    const texts = await rows.allInnerTexts();
    expect(texts.join("\n")).toContain("未作成");
    expect(texts.join("\n")).toContain("下書き");
    expect(texts.join("\n")).toContain("提出");
    expect(texts.join("\n")).toContain("チェック 1 / 2"); // 下書きの進み具合
    expect(await page.getByRole("link", { name: "確認・提出" }).count()).toBe(0); // work.assign のない人には出さない
    expect(await page.getByRole("link", { name: "報告書を作る" }).getAttribute("href")).toBe(`/reports/edit/?work=${W1}`);
    await page.getByLabel("報告書の状況").selectOption("none");
    expect(await rows.count()).toBe(1);
    await page.getByLabel("報告書の状況").selectOption("draft");
    expect(await rows.count()).toBe(1);
    await ctx.close();
  });

  it("R-009-31 work.assign を持つ人には、報告書のある作業に「確認・提出」が出る", async () => {
    const { ctx, page } = await setup("member");
    await page.goto(`${origin}/reports/`);
    await page.getByTestId("report-row").first().waitFor();
    expect(await page.getByRole("link", { name: "確認・提出" }).count()).toBe(2);
    expect(await page.getByRole("link", { name: "確認・提出" }).first().getAttribute("href")).toMatch(/^\/reports\/review\/\?id=r[23]$/);
    await ctx.close();
  });
});

describe("スマホで報告書を作る", () => {
  it("R-009-24 R-009-32 作業を開くとひな形の使う項目が並び、チェックとメモを入れて保存すると、報告書 → 項目 → チェック → メモの順に、端末の uuid で送られる", async () => {
    const { ctx, page, be } = await setup("staff");
    await page.goto(`${origin}/reports/edit/?work=${W1}`);
    const items = page.getByTestId("report-item");
    await items.first().waitFor();
    expect(await items.count()).toBe(2); // 「使わない」項目は出ない
    expect((await items.allInnerTexts()).join("|")).toContain("エントランスの床");
    await page.getByLabel("エントランスの床をチェック").check();
    await page.getByLabel("エントランスの床のメモ").fill("しみは落ちた");
    await page.getByLabel("エントランスの床のメモ").blur();
    await page.getByLabel("全体のメモ・気づき").fill("電球が切れかけ");
    await page.getByLabel("全体のメモ・気づき").blur();
    await page.getByRole("button", { name: "保存して送る" }).click();
    await page.getByText("送りました").waitFor();
    const order = be.log.filter((l) => /^rest:(reports:insert|report_items:insert|report_items:patch|reports:patch)/.test(l));
    expect(order[0]).toMatch(/^rest:reports:insert:[0-9a-f-]{36}$/);
    expect(order[1]).toBe("rest:report_items:insert:2");
    // 項目のチェックとメモ → 報告書のメモの順（保存のたびに送り直すので、最初の1回で見る）
    const firstItemPatch = order.findIndex((l) => l.startsWith("rest:report_items:patch"));
    const firstReportPatch = order.findIndex((l) => l.startsWith("rest:reports:patch"));
    expect(firstItemPatch).toBeGreaterThan(1);
    expect(firstReportPatch).toBeGreaterThan(firstItemPatch);
    const sent = be.reports.find((r) => r.work_id === W1)!;
    expect(sent).toMatchObject({ template_id: TPL, status: "draft", remarks: "電球が切れかけ", version: 2 });
    const mine = be.items.filter((i) => i.report_id === sent.id);
    expect(mine.map((i) => [i.name, i.done, i.note])).toEqual([["エントランスの床", true, "しみは落ちた"], ["ゴミ置き場", false, ""]]);
    expect(mine[0].area_id).toBe(AREA.id);
    // 同じ画面で何度保存しても、報告書は増えない（端末の uuid）
    await page.getByRole("button", { name: "保存して送る" }).click();
    await page.getByText("送りました").waitFor();
    expect(be.reports.filter((r) => r.work_id === W1)).toHaveLength(1);
    expect(be.items.filter((i) => i.report_id === sent.id)).toHaveLength(2);
    await ctx.close();
  });

  it("R-009-25 R-009-26 電波がないときは端末にため、件数を出す。戻ったら自動で送り、二度送らない（1件）", async () => {
    const { ctx, page, be } = await setup("staff");
    await page.goto(`${origin}/reports/edit/?work=${W1}`);
    await page.getByTestId("report-item").first().waitFor();
    be.offline = true;
    await ctx.setOffline(true);
    await page.getByLabel("エントランスの床をチェック").check();
    await page.getByText("送れていない報告書：1 件").waitFor();
    expect(be.reports.filter((r) => r.work_id === W1)).toHaveLength(0);
    be.offline = false;
    await ctx.setOffline(false);
    await expect.poll(() => be.reports.filter((r) => r.work_id === W1).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => page.getByTestId("pending-reports").count(), { timeout: 20_000 }).toBe(0);
    await page.waitForTimeout(1500);
    expect(be.reports.filter((r) => r.work_id === W1)).toHaveLength(1);
    const sent = be.reports.find((r) => r.work_id === W1)!;
    expect(be.items.filter((i) => i.report_id === sent.id)).toHaveLength(2);
    expect(be.items.find((i) => i.report_id === sent.id && i.name === "エントランスの床")!.done).toBe(true);
    await ctx.close();
  });

  it("R-009-27 サーバーに断られた報告書は、理由つきで「送れていない」に残り、あきらめて端末から消せる", async () => {
    const { ctx, page, be } = await setup("staff", { failReportInsert: { code: "42501", message: "new row violates row-level security policy" } });
    await page.goto(`${origin}/reports/edit/?work=${W1}`);
    await page.getByTestId("report-item").first().waitFor();
    await page.getByLabel("エントランスの床をチェック").check();
    await page.getByTestId("stuck-report").waitFor();
    expect(await page.getByTestId("stuck-report").innerText()).toContain("サーバーに断られました");
    expect(be.reports.filter((r) => r.work_id === W1)).toHaveLength(0);
    await page.getByRole("button", { name: "あきらめて消す" }).click();
    await expect.poll(() => page.getByTestId("pending-reports").count()).toBe(0);
    await ctx.close();
  });

  it("R-009-30 R-009-32 下書きは、サーバーの中身が出て直せる。提出済みの報告書は、読むだけで直せない", async () => {
    const { ctx, page } = await setup("staff");
    await page.goto(`${origin}/reports/edit/?work=${W2}`);
    await page.getByTestId("report-item").first().waitFor();
    expect(await page.getByLabel("エントランスをチェック").isChecked()).toBe(true);
    expect(await page.getByLabel("エントランスのメモ").inputValue()).toBe("拭いた");
    expect(await page.getByLabel("全体のメモ・気づき").inputValue()).toBe("下書きのメモ");
    expect(await page.getByLabel("エントランスをチェック").isDisabled()).toBe(false);
    expect(await page.getByTestId("report-status").innerText()).toBe("下書き");
    await page.goto(`${origin}/reports/edit/?work=${W3}`);
    await page.getByTestId("report-item").first().waitFor();
    expect(await page.getByTestId("report-status").innerText()).toBe("提出");
    expect(await page.getByLabel("階段をチェック").isDisabled()).toBe(true);
    expect(await page.getByLabel("全体のメモ・気づき").isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "保存して送る" }).count()).toBe(0);
    expect(await page.getByText("確認・提出のあとなので、直せません").count()).toBe(1);
    expect(await page.getByLabel("階段の作業前の写真").count()).toBe(0); // 写真も足せない
    await ctx.close();
  });

  it("R-009-29 R-009-32 項目に前の写真を撮ると、端末で縮小して、報告書の項目の行が先に届いてから、写真の行（作業・項目つき）を送る", async () => {
    const { ctx, page, be } = await setup("staff");
    await page.goto(`${origin}/reports/edit/?work=${W1}`);
    await page.getByTestId("report-item").first().waitFor();
    await page.getByLabel("エントランスの床の作業前の写真").setInputFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) });
    await page.getByText("写真を撮りました").waitFor();
    const reportAt = be.log.findIndex((l) => l.startsWith("rest:report_items:insert"));
    const photoAt = be.log.findIndex((l) => l.startsWith("rest:photos:insert"));
    expect(reportAt).toBeGreaterThanOrEqual(0);
    expect(reportAt).toBeLessThan(photoAt);
    expect(be.uploads.map((p) => p.split("/").pop())).toEqual(["photo.jpg", "thumb.jpg"]);
    const rep = be.reports.find((r) => r.work_id === W1)!;
    const target = be.items.find((i) => i.report_id === rep.id && i.name === "エントランスの床")!;
    expect(be.photos[0]).toMatchObject({ kind: "before", work_id: W1, report_item_id: target.id, building_id: B1, area_id: AREA.id });
    await ctx.close();
  });
});

describe("確認・提出", () => {
  it("R-009-33 社員は、下書きを確認し、提出できる。ボタンは状況で変わる（確認 → 戻す・提出）", async () => {
    const { ctx, page, be } = await setup("member");
    await page.goto(`${origin}/reports/review/?id=r2`);
    await page.getByTestId("review-item").first().waitFor();
    expect(await page.getByTestId("report-status").innerText()).toBe("下書き");
    expect(await page.getByRole("button", { name: "確認する" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: /^提出する/ }).count()).toBe(0);
    await page.getByRole("button", { name: "確認する" }).click();
    await page.getByText("確認済みにしました").waitFor();
    expect(await page.getByTestId("report-status").innerText()).toBe("確認済み");
    expect(await page.getByRole("button", { name: "下書きに戻す" }).count()).toBe(1);
    await page.getByRole("button", { name: /^提出する/ }).click();
    await page.getByText("提出しました").waitFor();
    expect(await page.getByTestId("report-status").innerText()).toBe("提出");
    expect(await page.getByRole("button", { name: "下書きに戻す" }).count()).toBe(0); // 提出済みは戻せない
    expect(be.rpcs.map((r) => r.name)).toEqual(["check_report", "submit_report"]);
    expect(be.rpcs[0].body).toEqual({ p_id: "r2" });
    await ctx.close();
  });

  it("R-009-33 確認済みを下書きに戻せる。work.assign のないスタッフには、ボタンが出ない", async () => {
    const { ctx, page, be } = await setup("member", { reports: [report("r2", W2, "checked", { checked_by: ME, checked_at: "2026-11-10T00:00:00Z", version: 2 })] });
    await page.goto(`${origin}/reports/review/?id=r2`);
    await page.getByRole("button", { name: "下書きに戻す" }).click();
    await page.getByText("下書きに戻しました").waitFor();
    expect(be.reports[0].status).toBe("draft");
    await ctx.close();
    const staff = await setup("staff");
    await staff.page.goto(`${origin}/reports/review/?id=r2`);
    await staff.page.getByTestId("review-item").first().waitFor();
    expect(await staff.page.getByRole("button", { name: "確認する" }).count()).toBe(0);
    expect(await staff.page.getByRole("button", { name: /^提出する/ }).count()).toBe(0);
    await staff.ctx.close();
  });
});

describe("印刷", () => {
  it("R-009-34 印刷の画面は、建物・日・項目と結果・メモ・写真を出し、印刷のときは操作を隠す", async () => {
    const photo = { id: "ph1", tenant_id: TENANT_A, building_id: B1, work_id: W2, report_item_id: "i2a", kind: "after", taken_at: "2026-11-10T01:00:00Z", deleted_at: null };
    const { ctx, page } = await setup("member", { photos: [photo] });
    await page.goto(`${origin}/reports/print/?id=r2`);
    const paper = page.getByRole("article", { name: "清掃報告書" });
    await paper.waitFor();
    const text = await paper.innerText();
    expect(text).toContain("テスト建物1");
    expect(text).toContain("2026年11月10日");
    expect(text).toContain("定期清掃（下書き）");
    expect(text).toContain("下書きのメモ");
    expect(text).toContain("チェック 1 / 2");
    const rows = await paper.getByRole("table", { name: "チェック項目" }).locator("tbody tr").allInnerTexts();
    expect(rows.map((r) => r.replace(/\s+/g, " ").trim())).toEqual(["済 エントランス 拭いた", "未 ゴミ置き場"]);
    await paper.locator("img").first().waitFor();
    expect(await paper.locator("img").first().getAttribute("alt")).toBe("作業後の写真");
    expect(await page.getByRole("button", { name: /印刷する/ }).isEnabled()).toBe(true);
    await page.emulateMedia({ media: "print" });
    expect(await page.getByRole("button", { name: /印刷する/ }).isVisible()).toBe(false);
    expect(await paper.isVisible()).toBe(true);
    await ctx.close();
  });
});

describe("ひな形の編集", () => {
  it("R-009-35 社員は、建物を選んで、ひな形と項目を作り、使わない・並べ替え・消すができる", async () => {
    const { ctx, page, be } = await setup("member");
    await page.goto(`${origin}/reports/templates/`);
    await page.getByLabel("建物", { exact: true }).selectOption(B1);
    const tpl = page.getByRole("article", { name: "定期清掃のひな形" });
    await tpl.waitFor();
    expect(await tpl.getByTestId("template-item").count()).toBe(3);
    // 新しいひな形
    await page.getByLabel("新しいひな形の名前").fill("臨時清掃");
    await page.getByRole("button", { name: "ひな形を作る" }).click();
    await page.getByText("ひな形を作りました").waitFor();
    expect(be.log).toContain("rest:report_templates:insert:臨時清掃");
    // 項目を足す（場所つき）
    await tpl.getByLabel("定期清掃のひな形の新しい項目", { exact: true }).fill("階段の手すり");
    await tpl.getByLabel("定期清掃のひな形の新しい項目の場所").selectOption(AREA.id);
    await tpl.getByRole("button", { name: "項目を足す" }).click();
    await page.getByText("項目を足しました").waitFor();
    const added = be.tItems.find((t) => t.name === "階段の手すり")!;
    expect(added).toMatchObject({ template_id: TPL, area_id: AREA.id, sort: 4 });
    // 使わない（項目）
    await tpl.getByTestId("template-item").filter({ hasText: "ゴミ置き場" }).getByRole("button", { name: "使わない" }).click();
    await expect.poll(() => be.tItems.find((t) => t.id === "t2")!.active).toBe(false);
    // 上へ：ゴミ置き場（2番目）を1番目に
    await tpl.getByRole("button", { name: "もう使わない" + "を上へ" }).waitFor();
    await tpl.getByRole("button", { name: "ゴミ置き場を上へ" }).click();
    await expect.poll(() => be.tItems.filter((t) => ["t1", "t2"].includes(String(t.id))).map((t) => `${t.id}:${t.sort}`).sort().join(",")).toBe("t1:2,t2:1");
    // 消す（項目）：使われていなければ消える
    await tpl.getByTestId("template-item").filter({ hasText: "もう使わない" }).getByRole("button", { name: "消す" }).click();
    await page.getByText("項目を消しました").waitFor();
    expect(be.rpcs.some((r) => r.name === "delete_template_item" && r.body.p_id === "t3")).toBe(true);
    // 消す（ひな形）：使われていれば、消さずに「使わない」と理由が出る
    await tpl.getByRole("button", { name: "消す", exact: true }).first().click();
    await page.getByText("消さずに「使わない」にしました").waitFor();
    expect(await page.getByText("作業が 3 件で使っています").count()).toBe(1);
    await ctx.close();
  });

  it("R-009-35 master.edit のないスタッフには、編集の操作を出さない（読むだけ）", async () => {
    const { ctx, page } = await setup("staff");
    await page.goto(`${origin}/reports/templates/`);
    await page.getByLabel("建物", { exact: true }).selectOption(B1);
    await page.getByRole("article", { name: "定期清掃のひな形" }).waitFor();
    expect(await page.getByRole("button", { name: "ひな形を作る" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "項目を足す" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "消す" }).count()).toBe(0);
    expect(await page.getByText("ひな形を直せるのは").count()).toBe(1);
    await ctx.close();
  });
});

describe("専用ページ", () => {
  it("R-009-36 外部の人の専用ページに、提出した報告書（日・項目と結果・メモ）と、その写真の区画が出る。写真は期限つきの URL で開く", async () => {
    const photo = { id: "ph3", tenant_id: TENANT_A, building_id: B1, work_id: W3, report_item_id: "i3a", kind: "after", taken_at: "2026-11-09T01:00:00Z", deleted_at: null };
    const { ctx, page } = await setup("external", { photos: [photo] });
    await page.goto(`${origin}/portal/`);
    const card = page.getByRole("article", { name: "テスト建物1" });
    await card.waitFor();
    const rep = card.getByLabel("清掃報告書", { exact: true });
    await rep.waitFor();
    await expect.poll(() => rep.innerText()).toContain("2026年11月9日");
    const text = await rep.innerText();
    expect(text).toContain("チェック 1 / 1");
    await rep.getByLabel(/の明細$/).waitFor();
    expect(await rep.innerText()).toContain("済 階段");
    expect(text).not.toContain("下書きのメモ"); // 提出していない報告書は出ない
    const photos = card.getByLabel("報告書の写真", { exact: true });
    await photos.getByRole("button", { name: /作業後/ }).waitFor();
    const popup = page.waitForEvent("popup");
    await photos.getByRole("button", { name: /作業後/ }).click();
    expect((await popup).url()).toContain("https://files.example.test/ph3/original.jpg");
    await ctx.close();
  });
});
