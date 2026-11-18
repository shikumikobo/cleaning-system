// 契約の画面の流れ（010）。共通の偽の接続先（harness.ts）の上に、契約まわりの表だけを自分で受ける（共通のファイルは変えない）。
import type { Server } from "node:http";
import type { Browser, BrowserContext } from "playwright";
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

type Row = Record<string, unknown>;
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const BUILDING = "00000000-0000-4000-8000-0000000000b1";
const C1 = "00000000-0000-4000-8000-0000000000d1";
const C2 = "00000000-0000-4000-8000-0000000000d2";
const QUOTE = "00000000-0000-4000-8000-0000000000a1";
const S_BASE = "00000000-0000-4000-8000-0000000000e1";
const S_OLD = "00000000-0000-4000-8000-0000000000e2";
const S_OPT = "00000000-0000-4000-8000-0000000000e3";

const contract = (over: Row): Row => ({
  tenant_id: TENANT_A, client_id: CLIENT, building_id: BUILDING, source: "quote", quote_id: QUOTE, kind: "recurring", start_date: "2026-11-01", end_date: null,
  status: "active", created_at: "2026-11-01T00:00:00Z", deleted_at: null, ...over,
});
const service = (over: Row): Row => ({
  tenant_id: TENANT_A, contract_id: C1, service_key: "k", service_kind: "base", name: "x", amount: 0, billing: "monthly", recurrence: "FREQ=WEEKLY;BYDAY=MO",
  start_time: null, end_time: null, valid_from: "2026-11-01", valid_to: null, deleted_at: null, ...over,
});
const work = (id: string, over: Row): Row => ({
  id, tenant_id: TENANT_A, building_id: BUILDING, contract_service_id: S_BASE, request_id: null, title: "定期清掃", scheduled_date: "2099-01-05", start_time: null, end_time: null,
  status: "scheduled", deleted_at: null, ...over,
});

async function installContracts(ctx: BrowserContext, opts: { perms: string[]; changeReason?: string }) {
  const contracts: Row[] = [
    contract({ id: C1 }),
    contract({ id: C2, kind: "one_time", source: "import", quote_id: null, start_date: "2026-01-01", end_date: "2026-01-02", status: "ended" }),
  ];
  const services: Row[] = [
    service({ id: S_BASE, service_key: "k1", name: "定期清掃", amount: 30000, recurrence: "FREQ=MONTHLY;BYDAY=2TU", start_time: "09:00:00", end_time: "11:00:00", valid_from: "2026-12-01" }),
    service({ id: S_OLD, service_key: "k1", name: "定期清掃", amount: 28000, recurrence: "FREQ=WEEKLY;BYDAY=MO", valid_from: "2026-11-01", valid_to: "2026-11-30" }),
    service({ id: S_OPT, service_key: "k2", service_kind: "option", name: "窓清掃", amount: 12000, billing: "per_visit", recurrence: "FREQ=DAILY;COUNT=1", valid_from: "2026-11-01" }),
  ];
  const works: Row[] = [
    work("w1", { scheduled_date: "2099-01-05", start_time: "09:00:00", end_time: "11:00:00" }),
    work("w2", { scheduled_date: "2099-01-12" }),
    work("w3", { scheduled_date: "2099-01-19", status: "cancelled" }),
  ];
  const quotes: Row[] = [
    { id: QUOTE, tenant_id: TENANT_A, number: "Q-2026-0007", client_id: CLIENT, building_id: BUILDING, kind: "recurring", total: 46200, issue_date: "2026-11-17", status: "approved", deleted_at: null },
    { id: "00000000-0000-4000-8000-0000000000a2", tenant_id: TENANT_A, number: "Q-2026-0008", client_id: CLIENT, building_id: BUILDING, kind: "request", total: 5500, issue_date: "2026-11-18", status: "approved", deleted_at: null },
  ];
  const rpcs: Array<{ name: string; body: Record<string, unknown> }> = [];
  const send = (route: import("playwright").Route, req: import("playwright").Request, rows: Row[]) => {
    const url = new URL(req.url());
    let out = rows;
    for (const [k, v] of url.searchParams) {
      if (k.includes(".")) continue;
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k]) === v.slice(3));
      else if (v === "is.null") out = out.filter((r) => r[k] === null || r[k] === undefined);
    }
    const single = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(single ? out[0] ?? null : out) });
  };
  const table = (name: string, rows: () => Row[]) =>
    ctx.route((u) => u.origin === SUPABASE && u.pathname === `/rest/v1/${name}`, (route, req) => (req.method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : send(route, req, rows())));
  await table("contracts", () => contracts);
  await table("contract_services", () => services);
  await table("works", () => works);
  await table("quotes", () => quotes.filter((q) => q.status === "approved"));
  await table("buildings", () => [{ id: BUILDING, tenant_id: TENANT_A, client_id: CLIENT, owner_client_id: null, name: "ひまわりマンション", address: "東京都1", lat: null, lng: null, deleted_at: null }]);
  await table("clients", () => [{ id: CLIENT, tenant_id: TENANT_A, kind: "management_company", name: "青空管理株式会社", deleted_at: null }]);
  await table("role_permissions", () => opts.perms.map((code) => ({ permissions: { code }, roles: { code: "admin" } })));
  await ctx.route((u) => u.origin === SUPABASE && u.pathname.startsWith("/functions/v1/"), (route, req) =>
    req.method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: "{}" }),
  );
  await ctx.route((u) => u.origin === SUPABASE && u.pathname.startsWith("/rest/v1/rpc/"), (route, req) => {
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.split("/").pop()!;
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    rpcs.push({ name, body });
    const ok = (o: unknown) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(o) });
    if (name === "create_contract_from_quote") return ok({ ok: true, id: C1, services: 2 });
    if (name === "change_contract_service") return ok(opts.changeReason ? { ok: false, reason: opts.changeReason } : { ok: true, id: "new", cancelled: 3 });
    if (name === "end_contract") return ok({ ok: true, end_date: body.p_end_date, cancelled: 2 });
    return route.fulfill({ status: 404, headers: CORS, body: JSON.stringify({ message: "no rpc" }) });
  });
  return { rpcs };
}

async function open(perms: string[], extra: { changeReason?: string } = {}) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin] });
  const { ctx, page } = await newPage(browser, st);
  const fake = await installContracts(ctx, { perms, ...extra });
  return { ctx, page, ...fake };
}

describe("契約の一覧", () => {
  it("R-010-26 取引先・建物・状況・種類・期間が出て、状況と言葉で絞り込める", async () => {
    const { ctx, page } = await open(["amount.read", "contract.edit"]);
    await page.goto(`${origin}/contracts/`);
    await page.getByText("定期 ／ 2026年11月1日〜期限なし").waitFor();
    expect(await page.getByText("単発 ／ 2026年1月1日〜2026年1月2日").count()).toBe(1);
    await page.getByLabel("状況").selectOption("ended");
    expect(await page.getByText("定期 ／ 2026年11月1日〜期限なし").count()).toBe(0);
    await page.getByLabel("状況").selectOption("");
    await page.getByLabel("取引先・建物で探す").fill("存在しない名前");
    await page.getByText("該当する契約はありません。").waitFor();
    expect(await page.getByRole("link", { name: "見積から契約を作る" }).count()).toBe(1);
    await ctx.close();
  });

  it("R-010-32 契約を直せない権限なら、「見積から契約を作る」を出さない", async () => {
    const { ctx, page } = await open(["amount.read"]);
    await page.goto(`${origin}/contracts/`);
    await page.getByText("定期 ／ 2026年11月1日〜期限なし").waitFor();
    expect(await page.getByRole("link", { name: "見積から契約を作る" }).count()).toBe(0);
    await ctx.close();
  });
});

describe("契約の詳細", () => {
  it("R-010-28 清掃の中身（金額・請求の仕方・頻度・時刻）が日本語で出て、過去の内容は区別され、これからの予定が出る", async () => {
    const { ctx, page } = await open(["amount.read", "contract.edit"]);
    await page.goto(`${origin}/contracts/detail/?id=${C1}`);
    const cur = page.getByLabel("中身 定期清掃").first();
    await cur.waitFor();
    const text = (await page.locator("section").innerText()).replace(/\s+/g, " ");
    for (const s of ["基本：定期清掃", "¥30,000（毎月）", "毎月 第2火曜", "09:00〜11:00", "オプション：窓清掃", "¥12,000（行った回ごと）", "1回だけ（単発）", "過去の内容", "¥28,000", "元の見積"]) {
      expect(text, s).toContain(s);
    }
    expect(text).toContain("2099年1月5日");
    expect(text).toContain("2099年1月12日");
    expect(text).not.toContain("2099年1月19日"); // 取り消した予定は出さない
    await ctx.close();
  });

  it("R-010-30 中身を変える：差分だけを RPC（change_contract_service）に渡し、取り消した件数を出す", async () => {
    const { ctx, page, rpcs } = await open(["amount.read", "contract.edit"]);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/contracts/detail/?id=${C1}`);
    await page.getByRole("button", { name: "この中身を変える" }).first().click();
    await page.getByLabel("金額", { exact: true }).fill("35000");
    await page.getByLabel("適用日").fill("2099-02-01");
    await page.getByRole("button", { name: "変える", exact: true }).click();
    await page.getByText("取り消した予定：3件").waitFor();
    const call = rpcs.find((r) => r.name === "change_contract_service")!;
    expect(call.body).toEqual({ p_service_id: S_BASE, p_effective: "2099-02-01", p_changes: { amount: 35000 } });
    await ctx.close();
  });

  it("R-010-30 何も変えていなければ、RPC を呼ばずに理由を出す", async () => {
    const { ctx, page, rpcs } = await open(["amount.read", "contract.edit"]);
    await page.goto(`${origin}/contracts/detail/?id=${C1}`);
    await page.getByRole("button", { name: "この中身を変える" }).first().click();
    await page.getByRole("button", { name: "変える", exact: true }).click();
    await page.getByText("変えるところがありません").waitFor();
    expect(rpcs.length).toBe(0);
    await ctx.close();
  });

  it("R-010-30 RPC が断ったら、日本語の理由を出す（請求書に載った月）", async () => {
    const { ctx, page } = await open(["amount.read", "contract.edit"], { changeReason: "invoiced" });
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/contracts/detail/?id=${C1}`);
    await page.getByRole("button", { name: "この中身を変える" }).first().click();
    await page.getByLabel("金額", { exact: true }).fill("35000");
    await page.getByRole("button", { name: "変える", exact: true }).click();
    await page.getByText("請求書に載っている月があるので").waitFor();
    await ctx.close();
  });

  it("R-010-30 契約を終える：終了日を RPC（end_contract）に渡す", async () => {
    const { ctx, page, rpcs } = await open(["amount.read", "contract.edit"]);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/contracts/detail/?id=${C1}`);
    await page.getByLabel("契約を終える").getByLabel("終了日").fill("2099-03-31");
    await page.getByRole("button", { name: "契約を終える" }).click();
    await page.getByText("契約を終えました（取り消した予定：2件）").waitFor();
    expect(rpcs.find((r) => r.name === "end_contract")!.body).toEqual({ p_id: C1, p_end_date: "2099-03-31" });
    await ctx.close();
  });

  it("R-010-30 終了した契約には、変更・終了の操作を出さない", async () => {
    const { ctx, page } = await open(["amount.read", "contract.edit"]);
    await page.goto(`${origin}/contracts/detail/?id=${C2}`);
    await page.getByText("終了", { exact: true }).first().waitFor();
    expect(await page.getByRole("button", { name: "契約を終える" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "この中身を変える" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-010-32 契約を直せない権限なら、変更・終了の操作を出さない", async () => {
    const { ctx, page } = await open(["amount.read"]);
    await page.goto(`${origin}/contracts/detail/?id=${C1}`);
    await page.getByLabel("中身 定期清掃").first().waitFor();
    expect(await page.getByRole("button", { name: "この中身を変える" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "契約を終える" }).count()).toBe(0);
    await ctx.close();
  });
});

describe("見積から契約を作る", () => {
  it("R-010-29 承認された見積を選び、開始日を入れて作る：RPC（create_contract_from_quote）を呼び、詳細へ移る", async () => {
    const { ctx, page, rpcs } = await open(["amount.read", "contract.edit"]);
    await page.goto(`${origin}/contracts/new/?quote=${QUOTE}`);
    await page.getByLabel("承認された見積").waitFor();
    await page.getByLabel("開始日").fill("2026-12-01");
    await page.getByRole("button", { name: "契約を作る" }).click();
    await page.getByText("契約の詳細").waitFor();
    const call = rpcs.find((r) => r.name === "create_contract_from_quote")!;
    expect(call.body).toEqual({ p_quote_id: QUOTE, p_start_date: "2026-12-01", p_end_date: null });
    expect(page.url()).toContain(`/contracts/detail/?id=${C1}`);
    await ctx.close();
  });

  it("R-010-29 見積が未選択、開始日が空、終了日が開始日より前なら、RPC を呼ばずに理由を出す", async () => {
    const { ctx, page, rpcs } = await open(["amount.read", "contract.edit"]);
    await page.goto(`${origin}/contracts/new/`);
    await page.getByLabel("承認された見積").waitFor();
    await page.getByRole("button", { name: "契約を作る" }).click();
    await page.getByText("見積を選んでください").waitFor();
    await page.getByLabel("承認された見積").selectOption("00000000-0000-4000-8000-0000000000a2"); // QUOTE はすでに契約があるので、選べない（一覧に出ない）
    await page.getByLabel("開始日").fill("2026-12-10");
    await page.getByLabel("終了日").fill("2026-12-01");
    await page.getByRole("button", { name: "契約を作る" }).click();
    await page.getByText("終了日は開始日より後にしてください").first().waitFor();
    expect(rpcs.length).toBe(0);
    expect(await page.getByLabel("承認された見積").locator("option", { hasText: "Q-2026-0007" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-010-32 契約を直せない権限なら、作る画面は権限がない旨だけを出す", async () => {
    const { ctx, page } = await open(["amount.read"]);
    await page.goto(`${origin}/contracts/new/`);
    await page.getByText("契約を作る権限がありません。").waitFor();
    expect(await page.getByRole("button", { name: "契約を作る" }).count()).toBe(0);
    await ctx.close();
  });
});

describe("予定の一覧", () => {
  it("R-010-31 日付の順に出て、取り消した予定は出さず、状況で取消を選ぶと出る", async () => {
    const { ctx, page } = await open(["amount.read", "work.assign"]);
    await page.goto(`${origin}/contracts/works/`);
    await page.getByText("2099年1月5日 09:00〜11:00").waitFor();
    expect(await page.getByText("2099年1月12日").count()).toBe(1);
    expect(await page.getByText("2099年1月19日").count()).toBe(0);
    await page.getByLabel("状況").selectOption("cancelled");
    await page.getByText("2099年1月19日").waitFor();
    expect(await page.getByText("2099年1月12日").count()).toBe(0);
    await ctx.close();
  });
});
