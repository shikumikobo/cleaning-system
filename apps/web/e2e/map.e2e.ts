// 地図の画面の流れ（013）。共通の偽の接続先（harness.ts）の上に、地図まわりの表・RPC・Edge Function だけを自分で受ける（共通のファイルは変えない）。
// 位置情報は、このテストが差し替える（呼ばれた回数も数える）。地図のタイルは、外へ出ないように止めて、URL だけを記録する。
import type { Server } from "node:http";
import type { Browser, BrowserContext, Page, Request, Route } from "playwright";
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

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-expose-headers": "*" };
const admin: FakeMember = { id: "m-admin", tenant_id: TENANT_A, user_id: "u-me", status: "active", role: "admin", display_name: "管理 太郎" };
const staffMember: FakeMember = { id: "m-staff", tenant_id: TENANT_A, user_id: "u-me", status: "active", role: "staff", display_name: "青木" };

type Row = Record<string, unknown>;
const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";
const B3 = "00000000-0000-4000-8000-0000000000b3";
const day = (offset: number) => new Date(Date.now() + 9 * 3600 * 1000 + offset * 86400 * 1000).toISOString().slice(0, 10);
const TODAY = day(0);
const SVC = "00000000-0000-4000-8000-0000000000e1";

const work = (id: string, over: Row = {}): Row => ({
  id, tenant_id: TENANT_A, building_id: B1, contract_service_id: SVC, request_id: null, service_key: "k", title: "定期清掃", scheduled_date: TODAY, start_time: null, end_time: null,
  status: "scheduled", version: 1, run_id: null, deleted_at: null, ...over,
});
const building = (id: string, name: string, address: string, lat: number | null, lng: number | null, over: Row = {}): Row => ({
  id, tenant_id: TENANT_A, client_id: "c", owner_client_id: null, name, address, lat, lng, location_fixed: false, deleted_at: null, ...over,
});

interface Fake {
  works: Row[];
  assignments: Row[];
  records: Row[];
  buildings: Row[];
  karte: Row[];
  /** true の間、開始・終了の RPC は電波がないふり */
  offline: boolean;
  /** 住所から求める入口の答え */
  geocode: { status: number; body: Row };
  rpcs: Array<{ name: string; body: Record<string, unknown> }>;
  patches: Array<{ table: string; id: string; body: Row }>;
  geocodeCalls: Array<Row>;
  tiles: string[];
}

async function install(ctx: BrowserContext, perms: string[], over: Partial<Fake> = {}): Promise<Fake> {
  const f: Fake = {
    works: [], assignments: [], records: [],
    buildings: [building(B1, "ひまわりマンション", "東京都千代田区1-1", 35.681236, 139.767125), building(B2, "さくらビル", "東京都港区2-2", 35.658, 139.745), building(B3, "位置なしハイツ", "東京都A区3-3", null, null)],
    karte: [{ id: "k1", tenant_id: TENANT_A, building_id: B1, entry: "正面の自動ドア", key_place: "管理室のキーボックス", parking: "敷地内に2台", garbage_days: "月・木", manager_contact: "管理人 090-0000-0000", cautions: "犬がいる", deleted_at: null }],
    offline: false, geocode: { status: 200, body: { found: true, lat: 35.0, lng: 139.0 } }, rpcs: [], patches: [], geocodeCalls: [], tiles: [], ...over,
  };
  const json = (route: Route, o: unknown, status = 200) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(o) });
  const filter = (req: Request, rows: Row[]) => {
    const url = new URL(req.url());
    let out = rows;
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(k) || k.includes(".")) continue;
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k]) === v.slice(3));
      else if (v === "is.null") out = out.filter((r) => r[k] === null || r[k] === undefined);
      else if (v.startsWith("in.(")) {
        const set = v.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
        out = out.filter((r) => set.includes(String(r[k])));
      } else if (v.startsWith("gte.")) out = out.filter((r) => String(r[k]) >= v.slice(4));
      else if (v.startsWith("lte.")) out = out.filter((r) => String(r[k]) <= v.slice(4));
    }
    return out;
  };
  const table = (name: string, rows: () => Row[]) =>
    ctx.route(
      (u) => u.origin === SUPABASE && u.pathname === `/rest/v1/${name}`,
      (route, req) => {
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
        const single = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
        if (req.method() === "PATCH") {
          const body = JSON.parse(req.postData() ?? "{}") as Row;
          const target = filter(req, rows());
          f.patches.push({ table: name, id: String(target[0]?.id ?? ""), body });
          for (const r of target) Object.assign(r, body);
          return json(route, single ? target[0] ?? null : target);
        }
        if (req.method() === "POST") return route.fulfill({ status: 201, headers: CORS, body: "" });
        const out = filter(req, rows());
        return json(route, single ? out[0] ?? null : out);
      },
    );
  void table("works", () => f.works);
  void table("work_assignments", () => f.assignments);
  void table("work_records", () => f.records);
  void table("work_overlaps", () => []);
  void table("buildings", () => f.buildings);
  void table("building_profiles", () => f.karte);
  void table("role_permissions", () => perms.map((code) => ({ permissions: { code }, roles: { code: "x" } })));
  await ctx.route((u) => u.origin === SUPABASE && u.pathname.startsWith("/rest/v1/rpc/"), (route, req) => {
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.split("/").pop()!;
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    if ((name === "start_work" || name === "finish_work") && f.offline) return route.abort("failed");
    f.rpcs.push({ name, body });
    if (name === "work_staff") return json(route, []);
    if (name === "assign_conflicts") return json(route, []);
    const w = f.works.find((x) => x.id === body.p_work_id);
    if (name === "start_work" && w) {
      w.status = "in_progress";
      f.records.push({ id: body.p_id, tenant_id: TENANT_A, work_id: w.id, membership_id: "m-staff", started_at: body.p_started_at, ended_at: null, deleted_at: null });
      return json(route, { ok: true, id: body.p_id });
    }
    if (name === "finish_work" && w) {
      w.status = "done";
      f.records = f.records.filter((r) => r.work_id !== w.id);
      return json(route, { ok: true, status: "done" });
    }
    return json(route, { ok: true, version: 2 });
  });
  await ctx.route((u) => u.origin === SUPABASE && u.pathname === "/functions/v1/geocode-buildings", (route, req) => {
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    f.geocodeCalls.push(JSON.parse(req.postData() ?? "{}"));
    return json(route, f.geocode.body, f.geocode.status);
  });
  // 地図のタイルは外へ出さない（URL だけ記録する）
  await ctx.route(/tile\.openstreetmap\.org|tiles\.example\.test/, (route, req) => {
    f.tiles.push(req.url());
    return route.abort("failed");
  });
  // 位置情報：呼ばれた回数を数え、返す値とエラーはテストが決める
  await ctx.addInitScript(() => {
    const w = window as unknown as { __geo: { get: number; watch: number }; __geoMode: string; __geoPos: { lat: number; lng: number } };
    w.__geo = { get: 0, watch: 0 };
    w.__geoMode = "ok";
    w.__geoPos = { lat: 35.682236, lng: 139.767125 }; // 建物 B1 から約 111 m
    const geo = {
      getCurrentPosition(ok: (p: unknown) => void, err: (e: { code: number }) => void) {
        w.__geo.get++;
        if (w.__geoMode === "denied") err({ code: 1 });
        else ok({ coords: { latitude: w.__geoPos.lat, longitude: w.__geoPos.lng } });
      },
      watchPosition() {
        w.__geo.watch++;
        return 0;
      },
      clearWatch() {},
    };
    Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
  });
  return f;
}

async function open(perms: string[], over: Partial<Fake> = {}, member: FakeMember = admin) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [member] });
  const { ctx, page } = await newPage(browser, st);
  const fake = await install(ctx, perms, over);
  return { ctx, page, fake, st };
}

const STAFF_PERMS = ["field.record"];
const MANAGER_PERMS = ["work.assign", "field.record", "master.edit", "amount.read"];
const mine = (...ids: string[]): Row[] => ids.map((id) => ({ id: `a-${id}`, tenant_id: TENANT_A, work_id: id, membership_id: "m-staff", deleted_at: null }));
const geoCalls = (page: Page) => page.evaluate(() => (window as unknown as { __geo: { get: number; watch: number } }).__geo);
const ready = (page: Page) => page.locator("[data-map-ready='true']").waitFor();
const markerIds = (page: Page) => page.locator("[data-marker-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-marker-id")));

describe("地図（建物）", () => {
  it("R-013-21 すべての建物：位置のある建物が印になり、位置のない建物は一覧に「位置なし」と出る。地図の帰属が出る", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, {}, staffMember);
    await page.goto(`${origin}/map/`);
    await ready(page);
    await page.getByRole("button", { name: "すべての建物" }).click();
    await page.locator("[data-building-row]").first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll("[data-marker-id]").length >= 2);
    expect((await markerIds(page)).sort()).toEqual([B1, B2].sort());
    const row3 = page.locator(`[data-building-row='${B3}']`);
    expect(await row3.innerText()).toContain("位置なし");
    expect(await page.locator(`[data-building-row='${B1}']`).innerText()).not.toContain("位置なし");
    const attr = page.getByRole("link", { name: "© OpenStreetMap contributors" });
    await attr.waitFor();
    expect(await attr.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    expect(fake.tiles.length).toBeGreaterThan(0);
    expect(fake.tiles[0]).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/); // R-013-29 既定のタイル
    await ctx.close();
  });

  it("R-013-22 その日の作業：作業のある建物だけに印が付き（作業の数つき）、時刻の順の一覧が出る。取消は出ない。日付を変えると変わる", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, {
      works: [
        work("w1", { title: "午後の清掃", start_time: "13:00:00", end_time: "15:00:00" }),
        work("w2", { title: "朝の清掃", start_time: "09:00:00", end_time: "11:00:00" }),
        work("w3", { title: "港の清掃", building_id: B2 }),
        work("w4", { title: "取り消した清掃", status: "cancelled" }),
        work("w5", { title: "明日の清掃", scheduled_date: day(1), building_id: B2 }),
        work("w6", { title: "位置なしの清掃", building_id: B3 }),
      ],
    });
    await page.goto(`${origin}/map/`);
    await ready(page);
    await page.getByText("朝の清掃").waitFor();
    await page.waitForFunction(() => document.querySelectorAll("[data-marker-id]").length >= 2);
    expect((await markerIds(page)).sort()).toEqual([B1, B2].sort()); // 位置なし（B3）は印にならない
    expect(await page.locator(`[data-marker-id='${B1}']`).innerText()).toBe("2"); // B1 の作業は 2 件
    const text = (await page.locator("section").innerText()).replace(/\s+/g, " ");
    expect(text.indexOf("朝の清掃")).toBeLessThan(text.indexOf("午後の清掃"));
    expect(text).not.toContain("取り消した清掃");
    expect(text).not.toContain("明日の清掃");
    expect(text).toContain("位置なしハイツ（位置なし）");
    // 日付を明日にすると、明日の作業だけ
    await page.getByLabel("日付").fill(day(1));
    await page.getByText("明日の清掃").waitFor();
    expect(await page.locator("section").innerText()).not.toContain("朝の清掃");
    await ctx.close();
  });

  it("R-013-22 印を押すと、その建物が選ばれる（カルテ・道案内の欄が出る）。一覧を押しても同じ", async () => {
    const { ctx, page } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" }), work("w2", { title: "港の清掃", building_id: B2 })], assignments: mine("w1", "w2") }, staffMember);
    await page.goto(`${origin}/map/`);
    await ready(page);
    await page.locator(`[data-marker-id='${B2}']`).waitFor();
    await page.locator(`[data-marker-id='${B2}']`).click();
    await page.locator(`[data-building='${B2}']`).waitFor();
    expect(await page.locator(`[data-building='${B2}']`).innerText()).toContain("さくらビル");
    await page.locator("[data-work='w1']").click();
    await page.locator(`[data-building='${B1}']`).waitFor();
    await ctx.close();
  });

  it("R-013-23・24 選んだ建物に、カルテと道案内・カルテへのリンクが出る。位置がなければ住所で道案内を作る", async () => {
    const { ctx, page } = await open(STAFF_PERMS, {}, staffMember);
    await page.goto(`${origin}/map/?building=${B1}`);
    await ready(page);
    const panel = page.locator(`[data-building='${B1}']`);
    await panel.waitFor();
    await panel.getByText("管理室のキーボックス").waitFor();
    const t = await panel.innerText();
    for (const v of ["正面の自動ドア", "管理室のキーボックス", "敷地内に2台", "月・木", "管理人 090-0000-0000", "犬がいる"]) expect(t).toContain(v);
    expect(await panel.getByRole("link", { name: "道案内を開く" }).getAttribute("href")).toBe("https://www.google.com/maps/dir/?api=1&destination=35.681236%2C139.767125");
    expect(await panel.getByRole("link", { name: "Apple マップで開く" }).getAttribute("href")).toContain("maps.apple.com");
    expect(await panel.getByRole("link", { name: "建物のカルテへ" }).getAttribute("href")).toBe(`/buildings/edit/?id=${B1}`);
    // 位置のない建物：住所で作る
    await page.goto(`${origin}/map/?building=${B3}`);
    const p3 = page.locator(`[data-building='${B3}']`);
    await p3.waitFor();
    expect(await p3.getByRole("link", { name: "道案内を開く" }).getAttribute("href")).toBe(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("東京都A区3-3")}`);
    expect(await p3.innerText()).toContain("位置なし");
    expect(await p3.innerText()).toContain("建物カルテはまだありません");
    await ctx.close();
  });
});

describe("位置を直す（master.edit）", () => {
  it("R-013-25 master.edit のないスタッフには、「位置を直す」が出ない", async () => {
    const { ctx, page } = await open(STAFF_PERMS, {}, staffMember);
    await page.goto(`${origin}/map/?building=${B1}`);
    await page.locator(`[data-building='${B1}']`).waitFor();
    expect(await page.getByRole("button", { name: "位置を直す" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-013-25 地図を押して新しい位置を決め、今の位置との違いを見て、「この位置で保存」で保存する（直した印つき）", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS);
    await page.goto(`${origin}/map/?building=${B1}`);
    await ready(page);
    await page.locator(`[data-building='${B1}']`).waitFor();
    await page.getByRole("button", { name: "位置を直す" }).click();
    const save = page.getByRole("button", { name: "この位置で保存" });
    expect(await save.isDisabled()).toBe(true); // まだ決めていない
    expect(await page.locator("[data-pick]").innerText()).toContain("まだ決めていません");
    await page.locator("[data-map='true']").scrollIntoViewIfNeeded(); // 下のボタンを押して、地図が画面の外に出ているので
    const box = (await page.locator("[data-map='true']").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40); // 地図を押す
    await page.locator("[data-pick='set']").waitFor();
    const text = await page.locator("[data-pick='set']").innerText();
    expect(text).toContain("今の位置：35.681236, 139.767125");
    expect(text).toMatch(/新しい位置：\d+\.\d{6}, \d+\.\d{6}/);
    expect(text).toMatch(/約 \d+ m動きます|約 [\d.]+ km動きます/);
    await save.click();
    await page.getByText("位置を保存しました").waitFor();
    expect(fake.patches).toHaveLength(1);
    const p = fake.patches[0];
    expect(p).toMatchObject({ table: "buildings", id: B1 });
    expect(p.body.location_fixed).toBe(true);
    expect(typeof p.body.lat).toBe("number");
    expect(typeof p.body.lng).toBe("number");
    expect(p.body.lat).not.toBe(35.681236);
    await ctx.close();
  });

  it("R-013-25・10 「住所から求める」：Edge Function の候補が地図に出る（保存は押すまでしない）", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS);
    await page.goto(`${origin}/map/?building=${B3}`);
    await ready(page);
    await page.locator(`[data-building='${B3}']`).waitFor();
    await page.getByRole("button", { name: "位置を直す" }).click();
    await page.getByRole("button", { name: "住所から求める" }).click();
    await page.locator("[data-pick='set']").waitFor();
    expect(await page.locator("[data-pick='set']").innerText()).toContain("新しい位置：35.000000, 139.000000");
    expect(fake.geocodeCalls).toEqual([{ building_id: B3 }]);
    expect(fake.patches).toHaveLength(0);
    await page.getByRole("button", { name: "この位置で保存" }).click();
    await page.getByText("位置を保存しました").waitFor();
    expect(fake.patches[0].body).toEqual({ lat: 35, lng: 139, location_fixed: true });
    await ctx.close();
  });

  it("R-013-10 位置を求める口が未設定のときは、そのことを出して、地図を押して決められる", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, { geocode: { status: 503, body: { error: "x", code: "geocoder_not_configured" } } });
    await page.goto(`${origin}/map/?building=${B3}`);
    await page.locator(`[data-building='${B3}']`).waitFor();
    await page.getByRole("button", { name: "位置を直す" }).click();
    await page.getByRole("button", { name: "住所から求める" }).click();
    await page.getByText("まだ選ばれていません").waitFor();
    expect(await page.locator("[data-pick='none']").count()).toBe(1);
    await ctx.close();
  });

  it("R-013-7 「住所から求め直す（自動に戻す）」：位置を空に、直した印を外す", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, { buildings: [building(B1, "ひまわりマンション", "東京都千代田区1-1", 35.681236, 139.767125, { location_fixed: true })] });
    await page.goto(`${origin}/map/?building=${B1}`);
    await page.locator(`[data-building='${B1}']`).getByText("（地図で直した位置）").waitFor();
    await page.getByRole("button", { name: "位置を直す" }).click();
    await page.getByRole("button", { name: "住所から求め直す（自動に戻す）" }).click();
    await page.getByText("位置を空に戻しました").waitFor();
    expect(fake.patches[0].body).toEqual({ lat: null, lng: null, location_fixed: false });
    await page.locator(`[data-building='${B1}']`).getByText("位置なし").first().waitFor();
    await ctx.close();
  });
});

describe("現場：自分の予定から地図・道案内・カルテへ（R-013-26）", () => {
  it("R-013-26 各作業から、地図・道案内・建物カルテへ行ける", async () => {
    const { ctx, page } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByText("朝の清掃").first().waitFor();
    expect(await page.getByRole("link", { name: "地図：朝の清掃" }).getAttribute("href")).toBe(`/map/?building=${B1}&date=${TODAY}`);
    expect(await page.getByRole("link", { name: "道案内：朝の清掃" }).getAttribute("href")).toBe("https://www.google.com/maps/dir/?api=1&destination=35.681236%2C139.767125");
    expect(await page.getByRole("link", { name: "建物カルテ：朝の清掃" }).getAttribute("href")).toBe(`/buildings/edit/?id=${B1}`);
    // 地図へ行くと、その建物が選ばれている
    await page.getByRole("link", { name: "地図：朝の清掃" }).click();
    await page.locator(`[data-building='${B1}']`).waitFor();
    await page.locator(`[data-building='${B1}']`).getByText("管理室のキーボックス").waitFor();
    await ctx.close();
  });
});

describe("開始・終了のときだけ位置を記録する（了承）", () => {
  it("R-013-27 開始を押すと、先に「位置を記録しますか」と尋ねる。何も選ぶまでは、送らず、位置も取らない", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    const dialog = page.getByRole("dialog", { name: "位置の記録" });
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("この 1 回だけ");
    expect(await dialog.innerText()).toContain("90 日で消えます");
    expect(fake.rpcs.filter((r) => r.name === "start_work")).toHaveLength(0);
    expect((await geoCalls(page)).get).toBe(0);
    await ctx.close();
  });

  it("R-013-27 「位置なしで開始」：位置の引数がなく、位置を取りに行かない", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    await page.getByRole("button", { name: "位置なしで開始" }).click();
    await page.getByText("開始を送りました").waitFor();
    const body = fake.rpcs.find((r) => r.name === "start_work")!.body;
    expect(Object.keys(body)).not.toContain("p_lat");
    expect(Object.keys(body)).not.toContain("p_lng");
    expect(await geoCalls(page)).toEqual({ get: 0, watch: 0 });
    await ctx.close();
  });

  it("R-013-27 「やめる」：何も送らず、位置も取らない。もう一度押すと、また尋ねる（了承は端末に残らない）", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    await page.getByRole("button", { name: "やめる" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    expect(fake.rpcs.filter((r) => r.name === "start_work")).toHaveLength(0);
    expect(await geoCalls(page)).toEqual({ get: 0, watch: 0 });
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    await page.getByRole("dialog", { name: "位置の記録" }).waitFor();
    await page.getByRole("button", { name: "位置を記録して開始" }).click();
    await page.getByText("開始を送りました").waitFor();
    // 次の「終了」も、また尋ねる
    await page.getByRole("button", { name: "終了：朝の清掃" }).click();
    await page.getByRole("dialog", { name: "位置の記録" }).waitFor();
    await ctx.close();
  });

  it("R-013-27・18 「位置を記録して開始・終了」：位置を 1 回ずつ取り、位置つきで送る。常時の追跡はしない", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    await page.getByRole("button", { name: "位置を記録して開始" }).click();
    await page.getByText("開始を送りました").waitFor();
    const start = fake.rpcs.find((r) => r.name === "start_work")!.body;
    expect(start).toMatchObject({ p_lat: 35.682236, p_lng: 139.767125 });
    expect(await geoCalls(page)).toEqual({ get: 1, watch: 0 });
    await page.getByRole("button", { name: "終了：朝の清掃" }).click();
    await page.getByRole("button", { name: "位置を記録して終了" }).click();
    await page.getByText("終了を送りました").waitFor();
    expect(fake.rpcs.find((r) => r.name === "finish_work")!.body).toMatchObject({ p_lat: 35.682236, p_lng: 139.767125 });
    expect(await geoCalls(page)).toEqual({ get: 2, watch: 0 });
    await ctx.close();
  });

  it("R-013-28 位置が許可されていなくても、位置なしで記録され、そのことが画面に出る", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.evaluate(() => ((window as unknown as { __geoMode: string }).__geoMode = "denied"));
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    await page.getByRole("button", { name: "位置を記録して開始" }).click();
    await page.getByText("位置の使用が許可されていないので、位置なしで記録しました").waitFor();
    const body = fake.rpcs.find((r) => r.name === "start_work")!.body;
    expect(Object.keys(body)).not.toContain("p_lat");
    expect(typeof body.p_id).toBe("string");
    await ctx.close();
  });

  it("R-013-28 電波がなくても、位置つきで端末にため、電波が戻ると、位置つきのまま 1 回だけ送る", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByRole("button", { name: "開始：朝の清掃" }).waitFor();
    fake.offline = true;
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    await page.getByRole("button", { name: "位置を記録して開始" }).click();
    await page.getByText("電波がないので、端末にためました").waitFor();
    await page.getByText("送信待ち（端末にためてあります）").waitFor();
    expect(fake.rpcs.filter((r) => r.name === "start_work")).toHaveLength(0);
    fake.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.getByText("送信待ち（端末にためてあります）").waitFor({ state: "detached", timeout: 20000 });
    const sent = fake.rpcs.filter((r) => r.name === "start_work");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ p_lat: 35.682236, p_lng: 139.767125 });
    await ctx.close();
  });
});

describe("位置を取りに行かない場面・地図の読み込み", () => {
  it("R-013-18 予定を見る・地図を見るだけでは、位置を取りに行かない（取得も、追跡も 0 回）", async () => {
    const { ctx, page } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByText("朝の清掃").first().waitFor();
    expect(await geoCalls(page)).toEqual({ get: 0, watch: 0 });
    await page.goto(`${origin}/map/?building=${B1}`);
    await ready(page);
    await page.locator(`[data-building='${B1}']`).waitFor();
    expect(await geoCalls(page)).toEqual({ get: 0, watch: 0 });
    await ctx.close();
  });

  it("R-013-29 地図の部品は、地図の画面を開いたときだけ読み込む（自分の予定の画面では読み込まない）", async () => {
    const { ctx, page } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByText("朝の清掃").first().waitFor();
    expect(await page.evaluate(() => typeof (window as unknown as { L?: unknown }).L)).toBe("undefined");
    await page.goto(`${origin}/map/`);
    await ready(page);
    expect(await page.evaluate(() => typeof (window as unknown as { L?: unknown }).L)).toBe("object");
    await ctx.close();
  });
});

describe("作業の画面：位置のずれ（R-013-15）", () => {
  it("R-013-15 実績に、建物からの距離が出る。離れていれば「離れています」と出る（位置の値そのものは出さない）", async () => {
    const rec = (id: string, d: number, warn: boolean): Row => ({
      id, tenant_id: TENANT_A, work_id: "w1", membership_id: "m-staff", started_at: new Date().toISOString(), ended_at: null, deleted_at: null,
      distance_m: d, distance_warning: warn, start_lat: null, start_lng: null,
    });
    const { ctx, page } = await open(MANAGER_PERMS, {
      works: [work("w1", { title: "朝の清掃" })],
      assignments: mine("w1"),
      records: [rec("r1", 1112, true)],
    });
    await page.goto(`${origin}/schedule/work/?id=w1`);
    await page.getByText("建物から約 1.1 km（離れています）").waitFor();
    expect(await page.locator("[data-distance='1112']").count()).toBe(1);
    await ctx.close();
  });
});
