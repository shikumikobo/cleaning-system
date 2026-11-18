// 見積の画面の流れ（004）。共通の偽の接続先（harness.ts）の上に、見積の表だけを自分で受ける（共通のファイルは変えない）。
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
const QID = { sub: "00000000-0000-4000-8000-0000000000a1", draft: "00000000-0000-4000-8000-0000000000a2", empty: "00000000-0000-4000-8000-0000000000a3" };
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const BUILDING = "00000000-0000-4000-8000-0000000000b1";

function quote(over: Row): Row {
  return {
    tenant_id: TENANT_A, client_id: CLIENT, building_id: BUILDING, request_id: null, kind: "request", number: null, issue_date: null, valid_until: null,
    tax_rate: 0.1, subtotal: 0, tax: 0, total: 0, status: "draft", previous_id: null, note: null, submitted_at: null, decided_at: null, decided_by: null,
    decision_note: null, created_at: "2026-11-17T00:00:00Z", deleted_at: null, ...over,
  };
}
function line(id: string, quote_id: string, over: Row): Row {
  return { id, tenant_id: TENANT_A, quote_id, item_id: null, line_kind: "one_time", name: "x", qty: 1, unit: "式", unit_price: 0, amount: 0, recurrence: null, sort: 1, deleted_at: null, ...over };
}

/** 見積まわりの表と、権限を受ける。戻りは受けた RPC の記録と、状況を切り替える手 */
async function installQuotes(ctx: BrowserContext, opts: { perms: string[] }) {
  const quotes: Row[] = [
    quote({ id: QID.sub, number: "Q-2026-0007", status: "submitted", kind: "recurring", issue_date: "2026-11-17", valid_until: "2026-12-17", subtotal: 42000, tax: 4200, total: 46200, note: "駐車場は先方で手配", submitted_at: "2026-11-17T00:00:00Z" }),
    quote({ id: QID.draft, kind: "request" }),
    quote({ id: QID.empty, kind: "request", created_at: "2026-11-16T00:00:00Z" }),
  ];
  const lines: Row[] = [
    line("l1", QID.sub, { line_kind: "base", name: "定期清掃", unit: "月", unit_price: 30000, amount: 30000, recurrence: "FREQ=MONTHLY;BYDAY=2TU", sort: 1 }),
    line("l2", QID.sub, { line_kind: "option", name: "窓清掃", unit: "回", unit_price: 12000, amount: 12000, recurrence: "FREQ=MONTHLY;INTERVAL=3", sort: 2 }),
    line("l3", QID.draft, { name: "共用部の清掃", qty: 2.5, unit: "回", unit_price: 1000, amount: 2500, sort: 1 }),
    line("l4", QID.draft, { name: "窓清掃", qty: 1, unit: "回", unit_price: 12000, amount: 12000, sort: 2 }),
  ];
  const rpcs: Array<{ name: string; body: unknown }> = [];
  const send = (route: import("playwright").Route, req: import("playwright").Request, rows: Row[]) => {
    const url = new URL(req.url());
    let out = rows;
    for (const [k, v] of url.searchParams) {
      if (k.includes(".")) continue; // 埋め込み先の条件（roles.code など）は、ここでは見ない
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k]) === v.slice(3));
      else if (v === "is.null") out = out.filter((r) => r[k] === null || r[k] === undefined);
    }
    const single = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(single ? out[0] ?? null : out) });
  };
  const table = (name: string, rows: () => Row[]) =>
    ctx.route((u) => u.origin === SUPABASE && u.pathname === `/rest/v1/${name}`, (route, req) => (req.method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : send(route, req, rows())));
  await table("quotes", () => quotes);
  await table("quote_lines", () => lines);
  await table("items", () => []);
  await table("buildings", () => [{ id: BUILDING, tenant_id: TENANT_A, client_id: CLIENT, owner_client_id: null, name: "ひまわりマンション", address: "東京都1", lat: null, lng: null, deleted_at: null }]);
  await table("clients", () => [{ id: CLIENT, tenant_id: TENANT_A, kind: "management_company", name: "青空管理株式会社", deleted_at: null }]);
  await table("tenants", () => [{ id: TENANT_A, name: "テスト清掃サービス", address: "東京都A区1-2-3", phone: "03-0000-0000", invoice_reg_no: "T1234567890123" }]);
  await table("role_permissions", () => opts.perms.map((code) => ({ permissions: { code }, roles: { code: "admin" } })));
  await ctx.route((u) => u.origin === SUPABASE && u.pathname.startsWith("/rest/v1/rpc/"), (route, req) => {
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.split("/").pop()!;
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    rpcs.push({ name, body });
    if (name === "submit_quote") {
      const q = quotes.find((x) => x.id === body.p_id)!;
      Object.assign(q, { status: "submitted", number: "Q-2026-0008", issue_date: "2026-11-17", valid_until: "2026-12-17", subtotal: 14500, tax: 1450, total: 15950, submitted_at: "2026-11-17T00:00:00Z" });
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ ok: true, number: "Q-2026-0008" }) });
    }
    return route.fulfill({ status: 404, headers: CORS, body: JSON.stringify({ message: "no rpc" }) });
  });
  return { rpcs, quotes };
}

async function open(perms: string[]) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin] });
  const { ctx, page } = await newPage(browser, st);
  const fake = await installQuotes(ctx, { perms });
  return { ctx, page, ...fake };
}

describe("見積の一覧", () => {
  it("R-004-31 番号・取引先・建物・状況・合計が出て、状況と言葉で絞り込める", async () => {
    const { ctx, page } = await open(["amount.read", "quote.edit"]);
    await page.goto(`${origin}/quotes/`);
    await page.getByText("Q-2026-0007").waitFor();
    expect(await page.getByText("合計 ¥46,200").count()).toBe(1);
    expect(await page.getByText("（番号なし）").count()).toBe(2);
    await page.getByLabel("状況").selectOption("draft");
    expect(await page.getByText("Q-2026-0007").count()).toBe(0);
    await page.getByLabel("状況").selectOption("");
    await page.getByLabel("番号・取引先・建物で探す").fill("0007");
    expect(await page.getByText("（番号なし）").count()).toBe(0);
    expect(await page.getByRole("link", { name: "見積を作る" }).count()).toBe(1);
    await ctx.close();
  });

  it("R-004-31 見積を直せない権限なら、「見積を作る」を出さない", async () => {
    const { ctx, page } = await open(["amount.read"]);
    await page.goto(`${origin}/quotes/`);
    await page.getByText("Q-2026-0007").waitFor();
    expect(await page.getByRole("link", { name: "見積を作る" }).count()).toBe(0);
    await ctx.close();
  });
});

describe("見積の編集・提出", () => {
  it("R-004-29・31 下書きの合計は画面で計算して出し、頻度は日本語で出る", async () => {
    const { ctx, page } = await open(["amount.read", "quote.edit"]);
    await page.goto(`${origin}/quotes/edit/?id=${QID.draft}`);
    const total = page.getByLabel("合計");
    await total.waitFor();
    const t = (await total.innerText()).replace(/\s+/g, " ");
    expect(t).toContain("¥14,500"); // 2.5×1000 + 12000
    expect(t).toContain("¥1,450");
    expect(t).toContain("¥15,950");
    await page.goto(`${origin}/quotes/edit/?id=${QID.sub}`);
    await page.getByText("毎月 第2火曜").waitFor();
    expect(await page.getByText("3か月に1回").count()).toBe(1);
    expect(await page.getByRole("button", { name: "承認で記録する" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "直した版を作る" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "提出する" }).count()).toBe(0); // 提出済みは、もう提出できない
    await ctx.close();
  });

  it("R-004-11・31 明細がないと、提出の前に日本語の理由が出て、RPC は呼ばない", async () => {
    const { ctx, page, rpcs } = await open(["amount.read", "quote.edit"]);
    await page.goto(`${origin}/quotes/edit/?id=${QID.empty}`);
    await page.getByRole("button", { name: "提出する" }).click();
    await page.getByText("明細が1つもありません").waitFor();
    expect(rpcs.length).toBe(0);
    await ctx.close();
  });

  it("R-004-8 下書きを提出すると、RPC（submit_quote）を呼び、番号が付いた表示になる", async () => {
    const { ctx, page, rpcs } = await open(["amount.read", "quote.edit"]);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/quotes/edit/?id=${QID.draft}`);
    await page.getByRole("button", { name: "提出する" }).click();
    await page.getByText("提出しました").waitFor();
    expect(rpcs.map((r) => r.name)).toEqual(["submit_quote"]);
    expect(rpcs[0].body).toEqual({ p_id: QID.draft });
    await page.getByText("Q-2026-0008").first().waitFor();
    expect(await page.getByRole("button", { name: "提出する" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-004-21・31 見積を直せない権限なら、提出・承認の操作を出さない", async () => {
    const { ctx, page } = await open(["amount.read"]);
    await page.goto(`${origin}/quotes/edit/?id=${QID.sub}`);
    await page.getByText("Q-2026-0007").first().waitFor();
    expect(await page.getByRole("button", { name: "承認で記録する" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "直した版を作る" }).count()).toBe(0);
    await ctx.close();
  });
});

describe("見積書の印刷（A4）", () => {
  it("R-004-30 番号・日付・宛先・明細（頻度つき）・税・合計・会社・インボイスの登録番号が載る。操作は印刷に出ない", async () => {
    const { ctx, page } = await open(["amount.read", "quote.edit"]);
    await page.goto(`${origin}/quotes/print/?id=${QID.sub}`);
    const paper = page.getByLabel("見積書");
    await paper.waitFor();
    const text = (await paper.innerText()).replace(/\s+/g, " ");
    for (const s of ["御見積書", "Q-2026-0007", "2026年11月17日", "2026年12月17日", "青空管理株式会社 御中", "ひまわりマンション", "定期清掃", "毎月 第2火曜", "3か月に1回", "¥30,000", "¥42,000", "消費税（10%）", "¥4,200", "¥46,200", "テスト清掃サービス", "東京都A区1-2-3", "03-0000-0000", "登録番号 T1234567890123", "駐車場は先方で手配"]) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toContain("下書き");
    // 印刷の見た目：ヘッダーと操作を隠し、用紙は A4。金額の表は BIZ UDGothic
    await page.emulateMedia({ media: "print" });
    expect(await page.locator(".app-header").evaluate((e) => getComputedStyle(e).display)).toBe("none");
    expect(await page.getByRole("button", { name: /印刷する/ }).isVisible()).toBe(false);
    expect(await page.locator(".qp-table").evaluate((e) => getComputedStyle(e).fontFamily)).toContain("BIZ UDGothic");
    expect(await page.locator(".qp-paper").evaluate((e) => getComputedStyle(e).fontFamily)).toContain("BIZ UDPGothic");
    await ctx.close();
  });

  it("R-004-30 下書きは「下書き」の印が付き、合計は明細から計算して出る", async () => {
    const { ctx, page } = await open(["amount.read", "quote.edit"]);
    await page.goto(`${origin}/quotes/print/?id=${QID.draft}`);
    const paper = page.getByLabel("見積書");
    await paper.waitFor();
    const text = (await paper.innerText()).replace(/\s+/g, " ");
    expect(text).toContain("下書き");
    expect(text).toContain("（番号は提出のときに付きます）");
    expect(text).toContain("¥15,950");
    await ctx.close();
  });
});
