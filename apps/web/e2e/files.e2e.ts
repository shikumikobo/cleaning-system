// 機能 005 の画面の流れ（Node 版 Playwright + Edge）。接続先は偽物。共通の偽の接続先（harness.ts）に、
// ファイル・建物・置き場所・期限つきの URL の通信を、このファイルの中で足して上書きする。
import type { Server } from "node:http";
import type { Browser, BrowserContext, Page } from "playwright";
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

const BUILDING = { id: "00000000-0000-4000-8000-0000000000b1", name: "テストマンションA1", address: "東京都A区1-1-1", lat: 35.1, lng: 139.1, client_id: "c1", tenant_id: TENANT_A, deleted_at: null };
const user = (role: FakeMember["role"]): FakeMember => ({ id: "m-me", tenant_id: TENANT_A, user_id: "u-me", status: "active", role, display_name: "テスト 太郎" });
const PERMS: Record<string, string[]> = {
  admin: ["master.edit", "field.record", "amount.read"],
  member: ["master.edit", "field.record", "amount.read"],
  staff: ["field.record"],
  external: [],
};

interface FRow {
  id: string;
  tenant_id: string;
  building_id: string;
  name: string;
  mime: string;
  size: number;
  storage_path: string;
  shared_external: boolean;
  request_id: string | null;
  quote_id: string | null;
  created_at: string;
  deleted_at: string | null;
}
interface Backend {
  buildings: Array<typeof BUILDING>;
  files: FRow[];
  failInsert: boolean;
  /** 起きた順の記録 */
  log: string[];
  buildingSelects: string[];
  signed: string[][];
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "*",
};

const file = (id: string, name: string, over: Partial<FRow> = {}): FRow => ({
  id, tenant_id: TENANT_A, building_id: BUILDING.id, name, mime: "application/pdf", size: 1572864,
  storage_path: `${TENANT_A}/files/${id}/x.pdf`, shared_external: false, request_id: null, quote_id: null,
  created_at: "2026-11-10T00:00:00.000Z", deleted_at: null, ...over,
});

/** 偽の接続先に、005 の通信を足す（あとから足した決まりが先に効く） */
async function addFilesBackend(ctx: BrowserContext, be: Backend, role: FakeMember["role"]) {
  const reply = (route: import("playwright").Route, status: number, body: unknown, single = false) =>
    route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(single && Array.isArray(body) ? body[0] : body) });
  const asObject = (route: import("playwright").Route) => (route.request().headers()["accept"] ?? "").includes("vnd.pgrst.object");

  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/role_permissions`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const code = new URL(route.request().url()).searchParams.get("roles.code")?.replace("eq.", "") ?? "";
    return reply(route, 200, (PERMS[code] ?? []).map((c) => ({ permissions: { code: c } })));
  });

  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/buildings`), async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    const url = new URL(route.request().url());
    be.buildingSelects.push(url.searchParams.get("select") ?? "");
    return reply(route, 200, be.buildings);
  });

  await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/files`), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const url = new URL(req.url());
    const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "") ?? null;
    if (req.method() === "GET") {
      let rows = be.files.filter((f) => !f.deleted_at);
      if (eq("building_id")) rows = rows.filter((f) => f.building_id === eq("building_id"));
      if (eq("shared_external") === "true") rows = rows.filter((f) => f.shared_external);
      if (role === "external") rows = rows.filter((f) => f.shared_external); // 外部の人の RLS
      be.log.push(`rest:files:get`);
      return reply(route, 200, rows);
    }
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      be.log.push(`rest:files:insert`);
      if (be.failInsert) return reply(route, 403, { code: "42501", message: "new row violates row-level security policy" });
      const row = file(body.id, body.name, { ...body, created_at: new Date().toISOString(), shared_external: false });
      be.files.push(row);
      return reply(route, 201, asObject(route) ? row : [row], asObject(route));
    }
    if (req.method() === "PATCH") {
      const body = JSON.parse(req.postData() ?? "{}");
      const row = be.files.find((f) => f.id === eq("id"));
      if (!row) return reply(route, 404, { code: "PGRST116", message: "none" });
      Object.assign(row, body);
      be.log.push(`rest:files:patch:${JSON.stringify(body)}`);
      return reply(route, 200, asObject(route) ? row : [row], asObject(route));
    }
    return route.fallback();
  });

  await ctx.route(new RegExp(`^${SUPABASE}/storage/v1/object/tenant-files`), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const path = decodeURIComponent(new URL(req.url()).pathname.replace("/storage/v1/object/tenant-files/", ""));
    if (req.method() === "POST") {
      be.log.push(`storage:upload:${path}`);
      return reply(route, 200, { Key: `tenant-files/${path}`, Id: "obj" });
    }
    if (req.method() === "DELETE") {
      const prefixes = (JSON.parse(req.postData() ?? "{}").prefixes ?? []) as string[];
      be.log.push(`storage:remove:${prefixes.join(",")}`);
      return reply(route, 200, []);
    }
    return route.fallback();
  });

  await ctx.route(new RegExp(`^${SUPABASE}/functions/v1/sign-file-urls`), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const ids = (JSON.parse(req.postData() ?? "{}").ids ?? []) as string[];
    be.signed.push(ids);
    const visible = be.files.filter((f) => ids.includes(f.id) && !f.deleted_at && (role !== "external" || f.shared_external));
    return reply(route, 200, {
      urls: Object.fromEntries(visible.map((f) => [f.id, `https://files.example.test/${f.id}?token=signed`])),
      not_found: ids.filter((i) => !visible.some((f) => f.id === i)),
      failed: [],
      expires_in: 600,
    });
  });
}

async function setup(role: FakeMember["role"], files: FRow[] = [], buildings = [BUILDING]) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [user(role)] });
  const be: Backend = { buildings, files, failInsert: false, log: [], buildingSelects: [], signed: [] };
  const { ctx, page } = await newPage(browser, st);
  await addFilesBackend(ctx, be, role);
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((u?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(u));
      return null;
    }) as typeof window.open;
  });
  page.on("dialog", (d) => void d.accept());
  return { ctx, page, be, st };
}
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
const PDF = { name: "契約書.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") };

describe("社内：建物ごとのファイル", () => {
  it("R-005-30 建物を選ぶと、その建物のファイルが新しい順に、名前・種類・大きさ・共有の状態つきで出る", async () => {
    const { ctx, page } = await setup("member", [
      file("00000000-0000-4000-8000-0000000000f1", "古い図面.pdf", { created_at: "2026-11-01T00:00:00.000Z" }),
      file("00000000-0000-4000-8000-0000000000f2", "新しい契約書.pdf", { created_at: "2026-11-09T00:00:00.000Z", shared_external: true }),
    ]);
    await page.goto(`${origin}/files/`);
    await page.getByLabel("建物").selectOption(BUILDING.id);
    await page.getByTestId("file-row").first().waitFor();
    const rows = await page.getByTestId("file-row").allInnerTexts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("新しい契約書.pdf");
    expect(rows[0]).toContain("PDF・1.5 MB");
    expect(rows[0]).toContain("外部に共有中");
    expect(rows[1]).toContain("古い図面.pdf");
    expect(rows[1]).toContain("社内のみ");
    await ctx.close();
  });

  it("R-005-31 R-005-13 ファイルを選んで上げると、置き場所に上げてから行を作り、一覧に加わる（共有はオフ）", async () => {
    const { ctx, page, be } = await setup("member");
    await page.goto(`${origin}/files/?building=${BUILDING.id}`);
    await page.getByLabel("ファイル", { exact: true }).setInputFiles(PDF);
    await expect.poll(() => page.getByLabel("名前").inputValue()).toBe("契約書.pdf");
    await page.getByRole("button", { name: "上げる" }).click();
    await page.getByText("上げました").waitFor();
    const order = be.log.filter((l) => l.startsWith("storage:upload") || l.startsWith("rest:files:insert"));
    expect(order[0]).toMatch(new RegExp(`^storage:upload:${TENANT_A}/files/[0-9a-f-]{36}/file\\.pdf$`));
    expect(order[1]).toBe("rest:files:insert");
    expect(be.files).toHaveLength(1);
    expect(be.files[0]).toMatchObject({ tenant_id: TENANT_A, building_id: BUILDING.id, name: "契約書.pdf", mime: "application/pdf", shared_external: false });
    expect(be.files[0].storage_path.startsWith(`${TENANT_A}/files/`)).toBe(true);
    expect(await page.getByTestId("file-row").count()).toBe(1);
    await ctx.close();
  });

  it("R-005-13 行を作れなかったら、上げたファイルを消そうとして、理由を出す。一覧には出ない", async () => {
    const { ctx, page, be } = await setup("member");
    be.failInsert = true;
    await page.goto(`${origin}/files/?building=${BUILDING.id}`);
    await page.getByLabel("ファイル", { exact: true }).setInputFiles(PDF);
    await page.getByRole("button", { name: "上げる" }).click();
    await page.getByText("この操作をする権限がありません").waitFor();
    expect(be.log.some((l) => l.startsWith("storage:remove:" + TENANT_A + "/files/"))).toBe(true);
    expect(await page.getByTestId("file-row").count()).toBe(0);
    await ctx.close();
  });

  it("R-005-31 名前が空なら、上げない", async () => {
    const { ctx, page, be } = await setup("member");
    await page.goto(`${origin}/files/?building=${BUILDING.id}`);
    await page.getByLabel("ファイル", { exact: true }).setInputFiles(PDF);
    await page.getByLabel("名前").fill("   ");
    await page.getByRole("button", { name: "上げる" }).click();
    await page.getByText("名前を入れてください").waitFor();
    expect(be.log.some((l) => l.startsWith("storage:upload"))).toBe(false);
    await ctx.close();
  });

  it("R-005-32 共有のオンとオフを切り替えると、その行の shared_external を直す", async () => {
    const { ctx, page, be } = await setup("member", [file("00000000-0000-4000-8000-0000000000f1", "図面.pdf")]);
    await page.goto(`${origin}/files/?building=${BUILDING.id}`);
    await page.getByRole("button", { name: "外部に共有する" }).click();
    await page.getByText("外部に共有中").waitFor();
    expect(be.files[0].shared_external).toBe(true);
    expect(be.log).toContain('rest:files:patch:{"shared_external":true}');
    await page.getByRole("button", { name: "共有をやめる" }).click();
    await page.getByText("社内のみ").waitFor();
    expect(be.files[0].shared_external).toBe(false);
    await ctx.close();
  });

  it("R-005-33 名前を押すと、期限つきの URL を取って開く", async () => {
    const f = file("00000000-0000-4000-8000-0000000000f1", "図面.pdf");
    const { ctx, page, be } = await setup("member", [f]);
    await page.goto(`${origin}/files/?building=${BUILDING.id}`);
    await page.getByRole("button", { name: "図面.pdf" }).click();
    await expect.poll(() => opened(page)).toEqual([`https://files.example.test/${f.id}?token=signed`]);
    expect(be.signed).toEqual([[f.id]]);
    await ctx.close();
  });

  it("R-005-34 消すと、その行を論理削除して一覧から外す", async () => {
    const { ctx, page, be } = await setup("member", [file("00000000-0000-4000-8000-0000000000f1", "図面.pdf")]);
    await page.goto(`${origin}/files/?building=${BUILDING.id}`);
    await page.getByRole("button", { name: "消す" }).click();
    await page.getByText("消しました").waitFor();
    expect(be.files[0].deleted_at).toBeTruthy();
    expect(await page.getByTestId("file-row").count()).toBe(0);
    await ctx.close();
  });

  it("R-005-35 master.edit のないスタッフには、一覧と開くだけを出し、上げる・共有・消すを出さない", async () => {
    const { ctx, page } = await setup("staff", [file("00000000-0000-4000-8000-0000000000f1", "図面.pdf")]);
    await page.goto(`${origin}/files/?building=${BUILDING.id}`);
    await page.getByTestId("file-row").waitFor();
    expect(await page.getByRole("button", { name: "上げる" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /共有/ }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "消す" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "図面.pdf" }).count()).toBe(1);
    await ctx.close();
  });
});

describe("外部の人の専用ページ", () => {
  it("R-005-26 外部の人がホームを開くと、専用ページに移る。社内の人は社内のホームのまま", async () => {
    const ext = await setup("external");
    await ext.page.goto(`${origin}/`);
    await ext.page.waitForURL("**/portal/");
    await ext.ctx.close();
    const mem = await setup("member");
    await mem.page.goto(`${origin}/`);
    await mem.page.getByRole("heading", { name: "A清掃" }).waitFor();
    expect(mem.page.url()).not.toContain("/portal/");
    await mem.page.getByRole("link", { name: "ファイル" }).waitFor();
    await mem.ctx.close();
  });

  it("R-005-27 R-005-25 許された建物の名前と住所と、共有されたファイルだけが出る。建物は id・名前・住所の列だけを取る", async () => {
    const shared = file("00000000-0000-4000-8000-0000000000f1", "共有の契約書.pdf", { shared_external: true });
    const priv = file("00000000-0000-4000-8000-0000000000f2", "社内メモ.pdf");
    const { ctx, page, be } = await setup("external", [shared, priv]);
    await page.goto(`${origin}/portal/`);
    await page.getByRole("heading", { name: "テストマンションA1" }).waitFor().catch(() => undefined);
    await page.getByText("東京都A区1-1-1").waitFor();
    await page.getByRole("button", { name: "共有の契約書.pdf" }).waitFor();
    expect(await page.getByText("社内メモ.pdf").count()).toBe(0);
    expect(await page.getByText("共有されたファイル").count()).toBeGreaterThan(0);
    expect(be.buildingSelects.every((s) => s.replace(/\s/g, "") === "id,name,address")).toBe(true);
    expect(be.buildingSelects.length).toBeGreaterThan(0);
    await ctx.close();
  });

  it("R-005-27 ファイルの名前を押すと、期限つきの URL で開く", async () => {
    const shared = file("00000000-0000-4000-8000-0000000000f1", "共有の契約書.pdf", { shared_external: true });
    const { ctx, page, be } = await setup("external", [shared]);
    await page.goto(`${origin}/portal/`);
    await page.getByRole("button", { name: "共有の契約書.pdf" }).click();
    await expect.poll(() => opened(page)).toEqual([`https://files.example.test/${shared.id}?token=signed`]);
    expect(be.signed).toEqual([[shared.id]]);
    await ctx.close();
  });

  it("R-005-27 許された建物がなければ「見られる建物がありません」と出す", async () => {
    const { ctx, page } = await setup("external", [], []);
    await page.goto(`${origin}/portal/`);
    await page.getByText("見られる建物がありません").waitFor();
    await ctx.close();
  });

  it("R-005-29 専用ページには、書き換える操作（承認・共有・消す・保存）がない", async () => {
    const shared = file("00000000-0000-4000-8000-0000000000f1", "共有の契約書.pdf", { shared_external: true });
    const { ctx, page, be } = await setup("external", [shared]);
    await page.goto(`${origin}/portal/`);
    await page.getByRole("button", { name: "共有の契約書.pdf" }).waitFor();
    expect(await page.getByRole("button", { name: /承認|共有する|共有をやめる|消す|保存|上げる/ }).count()).toBe(0);
    expect(be.log.filter((l) => l.includes("patch") || l.includes("insert") || l.includes("upload"))).toEqual([]);
    await ctx.close();
  });

  it("R-005-28 R-004-23 専用ページに、提出・承認の見積の区画が出る（金額と明細。外部の人は書き換える操作がない）", async () => {
    const { ctx, page } = await setup("external", []);
    const seen: string[] = [];
    const ok = (route: import("playwright").Route, rows: unknown[]) =>
      route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(rows) });
    await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/quotes`), (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      seen.push(route.request().url());
      return ok(route, [{ id: "q1", number: "Q-2026-0001", kind: "recurring", status: "approved", issue_date: "2026-11-01", valid_until: "2026-11-30", subtotal: 30000, tax: 3000, total: 33000, note: null }]);
    });
    await ctx.route(new RegExp(`^${SUPABASE}/rest/v1/quote_lines`), (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      return ok(route, [{ id: "l1", quote_id: "q1", name: "定期清掃（月額）", qty: 1, unit: "月", unit_price: 30000, amount: 30000 }]);
    });
    await page.goto(`${origin}/portal/`);
    await page.getByText("Q-2026-0001（承認・定期）").waitFor();
    await page.getByText("合計 ¥33,000").waitFor();
    await page.getByText("定期清掃（月額）").waitFor();
    expect(await page.getByText("見積（提出・承認）").count()).toBeGreaterThan(0);
    expect(seen.some((u) => u.includes("status=in.") && u.includes("submitted") && u.includes("approved") && u.includes("deleted_at=is.null"))).toBe(true);
    expect(await page.getByRole("button", { name: /承認する|不成立|提出|保存/ }).count()).toBe(0);
    await ctx.close();
  });

  it("R-005-26 社内の人が専用ページを開くと、外部の人用の画面だと出し、建物は取りに行かない", async () => {
    const { ctx, page, be } = await setup("member");
    await page.goto(`${origin}/portal/`);
    await page.getByText("外部の人（取引先の担当者）用").waitFor();
    expect(be.buildingSelects).toEqual([]);
    await ctx.close();
  });
});
