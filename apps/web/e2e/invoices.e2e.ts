// 請求の画面の流れ（011）。共通の偽の接続先（harness.ts）の上に、請求まわりの表だけを自分で受ける（共通のファイルは変えない）。
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Request, Route } from "playwright";
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
const ID = {
  draft: "00000000-0000-4000-8000-0000000000f1",
  issued: "00000000-0000-4000-8000-0000000000f2",
  partial: "00000000-0000-4000-8000-0000000000f3",
  paid: "00000000-0000-4000-8000-0000000000f4",
  cancelled: "00000000-0000-4000-8000-0000000000f5",
  sent: "00000000-0000-4000-8000-0000000000f6",
};

const invoice = (over: Row): Row => ({
  tenant_id: TENANT_A, client_id: CLIENT, period: "2026-10-01", number: null, issue_date: null, due_date: null, tax_rate: 0.1, subtotal: 0, tax: 0, total: 0, status: "draft",
  previous_id: null, note: null, issued_at: null, sent_at: null, cancelled_at: null, cancel_reason: null, created_at: "2026-11-01T00:00:00Z", deleted_at: null, ...over,
});
const line = (id: string, invoice_id: string, over: Row): Row => ({
  id, tenant_id: TENANT_A, invoice_id, service_key: "k", service_month: "2026-10-01", work_id: null, request_id: null, name: "x", qty: 1, unit: "式", unit_price: 0, amount: 0, sort: 1,
  deleted_at: null, ...over,
});

async function installInvoices(ctx: BrowserContext, opts: { perms: string[]; noReg?: boolean }) {
  const invoices: Row[] = [
    invoice({ id: ID.draft, period: "2026-11-01", created_at: "2026-12-01T00:00:00Z" }),
    invoice({ id: ID.issued, number: "I-2026-0001", issue_date: "2026-11-01", due_date: "2099-11-30", subtotal: 40000, tax: 4000, total: 44000, status: "issued", issued_at: "2026-11-01T00:00:00Z" }),
    invoice({ id: ID.partial, period: "2026-09-01", number: "I-2026-0002", issue_date: "2026-10-01", due_date: "2099-10-31", subtotal: 20000, tax: 2000, total: 22000, status: "partial", issued_at: "2026-10-01T00:00:00Z", sent_at: "2026-10-02T00:00:00Z" }),
    invoice({ id: ID.paid, period: "2026-08-01", number: "I-2026-0003", issue_date: "2026-09-01", due_date: "2026-09-30", subtotal: 10000, tax: 1000, total: 11000, status: "paid", issued_at: "2026-09-01T00:00:00Z" }),
    invoice({ id: ID.cancelled, period: "2026-07-01", number: "I-2026-0004", issue_date: "2026-08-01", due_date: "2026-08-31", subtotal: 5000, tax: 500, total: 5500, status: "cancelled", issued_at: "2026-08-01T00:00:00Z", cancelled_at: "2026-08-05T00:00:00Z", cancel_reason: "二重に出した" }),
    invoice({ id: ID.sent, period: "2026-06-01", number: "I-2026-0005", issue_date: "2026-07-01", due_date: "2026-07-31", subtotal: 3000, tax: 300, total: 3300, status: "sent", issued_at: "2026-07-01T00:00:00Z", sent_at: "2026-07-02T00:00:00Z" }),
  ];
  const lines: Row[] = [
    line("l1", ID.draft, { name: "ひまわりマンション 定期清掃", unit: "月", unit_price: 30000, amount: 30000, sort: 1 }),
    line("l2", ID.draft, { name: "ひまわりマンション 窓清掃（11/5）", qty: 2.5, unit: "回", unit_price: 1000, amount: 2500, sort: 2, service_key: null, service_month: null, work_id: "w1" }),
    line("l3", ID.issued, { name: "ひまわりマンション 定期清掃", unit: "月", unit_price: 30000, amount: 30000, sort: 1 }),
    line("l4", ID.issued, { name: "ひまわりマンション 窓清掃", qty: 2, unit: "回", unit_price: 5000, amount: 10000, sort: 2, service_key: null, service_month: null, work_id: "w2" }),
    line("l5", ID.partial, { name: "さくらハイツ 定期清掃", unit: "月", unit_price: 20000, amount: 20000, sort: 1 }),
    line("l6", ID.paid, { name: "さくらハイツ 清掃", unit: "式", unit_price: 10000, amount: 10000, sort: 1 }),
    line("l7", ID.sent, { name: "あおぞら 清掃", unit: "式", unit_price: 3000, amount: 3000, sort: 1 }),
  ];
  const payments: Row[] = [
    { id: "p1", tenant_id: TENANT_A, invoice_id: ID.partial, paid_on: "2026-10-20", amount: 10000, note: "内金", deleted_at: null },
    { id: "p2", tenant_id: TENANT_A, invoice_id: ID.paid, paid_on: "2026-09-25", amount: 11000, note: null, deleted_at: null },
  ];
  const patches: Array<{ table: string; id: string | null; body: Row }> = [];
  const rpcs: Array<{ name: string; body: Record<string, unknown> }> = [];
  const filtered = (req: Request, rows: Row[]) => {
    const url = new URL(req.url());
    let out = rows;
    for (const [k, v] of url.searchParams) {
      if (k === "select" || k === "order" || k.includes(".")) continue;
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k]) === v.slice(3));
      else if (v === "is.null") out = out.filter((r) => r[k] === null || r[k] === undefined);
      else if (v.startsWith("in.(")) {
        const set = v.slice(4, -1).split(",");
        out = out.filter((r) => set.includes(String(r[k])));
      }
    }
    return out;
  };
  const reply = (route: Route, req: Request, out: Row[]) => {
    const single = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(single ? (out[0] ?? null) : out) });
  };
  const table = (name: string, rows: () => Row[]) =>
    ctx.route((u) => u.origin === SUPABASE && u.pathname === `/rest/v1/${name}`, (route, req) => {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const out = filtered(req, rows());
      if (req.method() === "PATCH") {
        const body = JSON.parse(req.postData() ?? "{}") as Row;
        patches.push({ table: name, id: new URL(req.url()).searchParams.get("id")?.replace("eq.", "") ?? null, body });
        for (const r of out) Object.assign(r, body);
        return reply(route, req, out);
      }
      return reply(route, req, out);
    });
  await table("invoices", () => invoices.filter((i) => !i.deleted_at));
  await table("invoice_lines", () => lines);
  await table("payments", () => payments);
  await table("invoice_balances", () =>
    invoices.map((i) => {
      const paid = payments.filter((p) => p.invoice_id === i.id && !p.deleted_at).reduce((a, p) => a + Number(p.amount), 0);
      return { invoice_id: i.id, tenant_id: TENANT_A, total: i.total, paid, balance: Number(i.total) - paid };
    }),
  );
  await table("clients", () => [{ id: CLIENT, tenant_id: TENANT_A, kind: "management_company", name: "青空管理株式会社", deleted_at: null }]);
  await table("tenants", () => [{ ...tenant(TENANT_A, "A清掃"), invoice_reg_no: opts.noReg ? null : "T1234567890123" }]);
  await table("role_permissions", () => opts.perms.map((code) => ({ permissions: { code }, roles: { code: "admin" } })));
  await ctx.route((u) => u.origin === SUPABASE && u.pathname.startsWith("/rest/v1/rpc/"), (route, req) => {
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.split("/").pop()!;
    const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : {};
    rpcs.push({ name, body });
    const ok = (o: unknown) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(o) });
    const target = invoices.find((i) => i.id === body.p_id || i.id === body.p_invoice_id);
    if (name === "create_invoice_drafts") return ok({ ok: true, period: body.p_period, created: 2, added: 5, locked: 1, ids: [] });
    if (name === "issue_invoice") {
      Object.assign(target!, { status: "issued", number: "I-2026-0009", issue_date: "2026-12-05", due_date: "2026-12-31", subtotal: 32500, tax: 3250, total: 35750, issued_at: "2026-12-05T00:00:00Z" });
      return ok({ ok: true, number: "I-2026-0009", total: 35750 });
    }
    if (name === "mark_invoice_sent") {
      Object.assign(target!, { status: "sent", sent_at: "2026-12-05T00:00:00Z" });
      return ok({ ok: true });
    }
    if (name === "cancel_invoice") {
      Object.assign(target!, { status: "cancelled", cancelled_at: "2026-12-05T00:00:00Z", cancel_reason: body.p_reason ?? null });
      return ok({ ok: true });
    }
    if (name === "delete_invoice") {
      Object.assign(target!, { deleted_at: "2026-12-05T00:00:00Z" });
      return ok({ ok: true });
    }
    if (name === "record_payment") {
      payments.push({ id: "pn", tenant_id: TENANT_A, invoice_id: body.p_invoice_id, paid_on: body.p_paid_on, amount: body.p_amount, note: body.p_note, deleted_at: null });
      const paid = payments.filter((p) => p.invoice_id === target!.id && !p.deleted_at).reduce((a, p) => a + Number(p.amount), 0);
      Object.assign(target!, { status: paid >= Number(target!.total) ? "paid" : "partial" });
      return ok({ ok: true, id: "pn", status: target!.status });
    }
    if (name === "delete_payment") {
      const p = payments.find((x) => x.id === body.p_id)!;
      p.deleted_at = "2026-12-05T00:00:00Z";
      return ok({ ok: true, status: "issued" });
    }
    return route.fulfill({ status: 404, headers: CORS, body: JSON.stringify({ message: "no rpc" }) });
  });
  return { invoices, lines, payments, patches, rpcs };
}

async function open(perms: string[], extra: { noReg?: boolean } = {}) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin] });
  const { ctx, page } = await newPage(browser, st);
  const fake = await installInvoices(ctx, { perms, ...extra });
  return { ctx, page, ...fake };
}
const EDIT = ["amount.read", "invoice.edit"];

describe("請求の一覧", () => {
  it("R-011-35・36 番号・取引先・請求月・合計・状況・入金額と残高が出て、期日を過ぎた未入金は「期日超過」と分かる", async () => {
    const { ctx, page } = await open(EDIT);
    await page.goto(`${origin}/invoices/`);
    await page.getByText("I-2026-0001 ／ 青空管理株式会社").waitFor();
    const text = (await page.locator("section").innerText()).replace(/\s+/g, " ");
    for (const s of ["I-2026-0001", "2026年10月分", "¥44,000", "入金 ¥0／残高 ¥44,000", "入金 ¥10,000／残高 ¥12,000", "（下書き）", "合計は発行のときに決まります", "一部入金", "入金済み", "取消"]) {
      expect(text, s).toContain(s);
    }
    // 期日 2026-07-31 を過ぎた送付（残高あり）だけが期日超過。期日が 2099 年のものは、まだ
    expect(await page.locator(".q-status", { hasText: "期日超過" }).count()).toBe(1);
    await ctx.close();
  });

  it("R-011-35 状況・月・言葉で絞り込める", async () => {
    const { ctx, page } = await open(EDIT);
    await page.goto(`${origin}/invoices/`);
    await page.getByText("I-2026-0001 ／ 青空管理株式会社").waitFor();
    await page.getByLabel("状況").selectOption("paid");
    await page.getByText("I-2026-0003").waitFor();
    expect(await page.getByText("I-2026-0001").count()).toBe(0);
    await page.getByLabel("状況").selectOption("");
    await page.getByLabel("請求月").fill("2026-09");
    await page.getByText("I-2026-0002").waitFor();
    expect(await page.getByText("I-2026-0003").count()).toBe(0);
    await page.getByLabel("請求月").fill("");
    await page.getByLabel("番号・取引先で探す").fill("存在しない名前");
    await page.getByText("該当する請求書はありません。").waitFor();
    await ctx.close();
  });

  it("R-011-36 下書きを作る：月を RPC（create_invoice_drafts）に渡し、結果を日本語で出す", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    await page.goto(`${origin}/invoices/`);
    await page.getByText("I-2026-0001 ／ 青空管理株式会社").waitFor();
    const form = page.locator('form[aria-label="下書きを作る"]');
    await form.waitFor();
    await form.getByLabel("請求する月").fill("2026-09");
    await form.getByRole("button", { name: "下書きを作る" }).click();
    await page.getByText("下書きを 2 枚作りました。明細を 5 件入れました。発行済みの請求書がある取引先 1 件は、飛ばしました").waitFor();
    expect(rpcs.find((r) => r.name === "create_invoice_drafts")!.body).toEqual({ p_tenant: TENANT_A, p_period: "2026-09-01", p_client_id: null });
    await ctx.close();
  });

  it("R-011-36 月が空ならば、RPC を呼ばずに理由を出す", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    await page.goto(`${origin}/invoices/`);
    const form = page.locator('form[aria-label="下書きを作る"]');
    await form.getByLabel("請求する月").fill("");
    await form.getByRole("button", { name: "下書きを作る" }).click();
    await page.getByText("請求する月を選んでください（例：2026-10）").waitFor();
    expect(rpcs.length).toBe(0);
    await ctx.close();
  });

  it("R-011-36 請求を直せない権限なら、下書きを作る操作を出さない", async () => {
    const { ctx, page } = await open(["amount.read"]);
    await page.goto(`${origin}/invoices/`);
    await page.getByText("I-2026-0001 ／ 青空管理株式会社").waitFor();
    expect(await page.locator('form[aria-label="下書きを作る"]').count()).toBe(0);
    await ctx.close();
  });

  it("R-011-34 会計ソフトの CSV：絞り込みのうち発行・送付・入金のものだけを、BOM つき・番号の順で出す", async () => {
    const { ctx, page } = await open(EDIT);
    await page.goto(`${origin}/invoices/`);
    await page.getByText("I-2026-0001 ／ 青空管理株式会社").waitFor();
    const [dl1] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "請求書の CSV（会計ソフト用）" }).click()]);
    expect(dl1.suggestedFilename()).toBe("invoices-all.csv");
    const raw = readFileSync((await dl1.path())!);
    expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = raw.toString("utf8").replace(/^\uFEFF/, "").split("\r\n");
    expect(rows[0]).toBe("請求書番号,発行日,支払期日,取引先,請求月,税率,小計,消費税,合計,入金額,残高,状況");
    expect(rows.slice(1, -1).map((r) => r.split(",")[0])).toEqual(["I-2026-0001", "I-2026-0002", "I-2026-0003", "I-2026-0005"]); // 下書き・取消は含めない
    expect(rows[2]).toBe("I-2026-0002,2026-10-01,2099-10-31,青空管理株式会社,2026-09,10%,20000,2000,22000,10000,12000,一部入金");
    const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "明細の CSV" }).click()]);
    expect(dl2.suggestedFilename()).toBe("invoice-lines-all.csv");
    const lrows = readFileSync((await dl2.path())!, "utf8").replace(/^\uFEFF/, "").split("\r\n");
    expect(lrows[0]).toBe("請求書番号,請求月,取引先,品名,数量,単位,単価,金額,税率");
    expect(lrows).toContain("I-2026-0001,2026-10,青空管理株式会社,ひまわりマンション 窓清掃,2,回,5000,10000,10%");
    expect(lrows.join("\n")).not.toContain("窓清掃（11/5）"); // 下書きの明細は含めない
    await ctx.close();
  });
});

describe("請求書（下書き）", () => {
  it("R-011-36 下書きの明細と、画面で計算した合計（税は1回）が出る。発行のときに確定する旨を添える", async () => {
    const { ctx, page } = await open(EDIT);
    await page.goto(`${origin}/invoices/edit/?id=${ID.draft}`);
    await page.getByText("ひまわりマンション 定期清掃").waitFor();
    const total = (await page.getByLabel("合計").innerText()).replace(/\s+/g, " ");
    expect(total).toContain("小計 ¥32,500");
    expect(total).toContain("消費税（10%） ¥3,250");
    expect(total).toContain("合計 ¥35,750");
    expect(total).toContain("発行すると確定します");
    await ctx.close();
  });

  it("R-011-36 明細の品名・数量・単位を直す：変えた列だけを送る（単価・金額は送らない）", async () => {
    const { ctx, page, patches } = await open(EDIT);
    await page.goto(`${origin}/invoices/edit/?id=${ID.draft}`);
    await page.getByRole("button", { name: "直す ひまわりマンション 定期清掃" }).click();
    const form = page.locator('form[aria-label="明細を直す"]');
    await form.getByLabel("数量").fill("0.5");
    await form.getByRole("button", { name: "保存する" }).click();
    await page.getByText("¥15,000").first().waitFor();
    const p = patches.find((x) => x.table === "invoice_lines")!;
    expect(p.body).toEqual({ name: "ひまわりマンション 定期清掃", qty: 0.5, unit: "月" });
    await ctx.close();
  });

  it("R-011-36 数量が 0 以下ならば、送らずに理由を出す", async () => {
    const { ctx, page, patches } = await open(EDIT);
    await page.goto(`${origin}/invoices/edit/?id=${ID.draft}`);
    await page.getByRole("button", { name: "直す ひまわりマンション 定期清掃" }).click();
    const form = page.locator('form[aria-label="明細を直す"]');
    await form.getByLabel("数量").fill("0");
    await form.getByRole("button", { name: "保存する" }).click();
    await page.getByText("数量は 0 より大きくしてください").waitFor();
    expect(patches.length).toBe(0);
    await ctx.close();
  });

  it("R-011-36 明細を外す：論理削除（deleted_at）だけを送る", async () => {
    const { ctx, page, patches } = await open(EDIT);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/invoices/edit/?id=${ID.draft}`);
    await page.getByRole("button", { name: "外す ひまわりマンション 窓清掃（11/5）" }).click();
    await page.getByText("ひまわりマンション 窓清掃（11/5）").waitFor({ state: "detached" });
    const p = patches.find((x) => x.table === "invoice_lines")!;
    expect(Object.keys(p.body)).toEqual(["deleted_at"]);
    await ctx.close();
  });

  it("R-011-36 下書きの税率・期日・備考を保存する。税率が数でなければ送らない", async () => {
    const { ctx, page, patches } = await open(EDIT);
    await page.goto(`${origin}/invoices/edit/?id=${ID.draft}`);
    const form = page.locator('form[aria-label="下書きの設定"]');
    await form.waitFor();
    await form.getByLabel("税率（%）").fill("abc");
    await form.getByRole("button", { name: "保存する" }).click();
    await page.getByText("税率は 0〜100 の数（%）で入れてください").waitFor();
    expect(patches.length).toBe(0);
    await form.getByLabel("税率（%）").fill("8");
    await form.getByLabel("支払期日").fill("2026-12-25");
    await form.getByLabel("備考").fill("振込手数料は先方負担");
    await form.getByRole("button", { name: "保存する" }).click();
    await page.getByText("保存しました").waitFor();
    expect(patches.find((x) => x.table === "invoices")!.body).toEqual({ tax_rate: 0.08, due_date: "2026-12-25", note: "振込手数料は先方負担" });
    await ctx.close();
  });

  it("R-011-36 発行する：確認のうえで RPC（issue_invoice）を呼び、番号と合計が固定されて、編集の操作が消える", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/invoices/edit/?id=${ID.draft}`);
    await page.getByLabel("発行日").fill("2026-12-05");
    await page.getByRole("button", { name: "発行する" }).click();
    await page.getByText("発行しました").waitFor();
    expect(rpcs.find((r) => r.name === "issue_invoice")!.body).toEqual({ p_id: ID.draft, p_issue_date: "2026-12-05" });
    await page.getByText("I-2026-0009").first().waitFor();
    expect(await page.getByRole("button", { name: "発行する" }).count()).toBe(0);
    expect(await page.locator('form[aria-label="下書きの設定"]').count()).toBe(0);
    expect(await page.getByRole("button", { name: "送付を記録する" }).count()).toBe(1);
    await ctx.close();
  });

  it("R-011-36 下書きを消す：RPC（delete_invoice）を呼び、一覧へ戻る", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/invoices/edit/?id=${ID.draft}`);
    await page.getByRole("button", { name: "この下書きを消す" }).click();
    await page.getByText("該当する請求書はありません。", { exact: false }).or(page.getByText("I-2026-0001 ／ 青空管理株式会社")).first().waitFor();
    expect(rpcs.find((r) => r.name === "delete_invoice")!.body).toEqual({ p_id: ID.draft });
    expect(page.url()).toContain("/invoices/");
    expect(page.url()).not.toContain("edit");
    await ctx.close();
  });
});

describe("請求書（発行したあと）", () => {
  it("R-011-36 発行した請求書は、編集の操作を出さず、送付の記録と取消を出す。送付を記録する", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/invoices/edit/?id=${ID.issued}`);
    await page.getByText("I-2026-0001").first().waitFor();
    expect(await page.locator('form[aria-label="下書きの設定"]').count()).toBe(0);
    expect(await page.getByRole("button", { name: "発行する" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /^直す / }).count()).toBe(0);
    await page.getByRole("button", { name: "送付を記録する" }).click();
    await page.getByText("送付で記録しました").waitFor();
    expect(rpcs.find((r) => r.name === "mark_invoice_sent")!.body).toEqual({ p_id: ID.issued });
    expect(await page.getByRole("button", { name: "送付を記録する" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-011-36 取り消す：理由を RPC（cancel_invoice）に渡し、取消の表示になる", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    page.on("dialog", (d) => void (d.type() === "prompt" ? d.accept("二重に出した") : d.accept()));
    await page.goto(`${origin}/invoices/edit/?id=${ID.issued}`);
    await page.getByRole("button", { name: "取り消す" }).click();
    await page.getByText("理由：二重に出した").waitFor();
    expect(rpcs.find((r) => r.name === "cancel_invoice")!.body).toEqual({ p_id: ID.issued, p_reason: "二重に出した" });
    expect(await page.getByRole("button", { name: "取り消す" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-011-36 入金のある請求書には、取り消す操作を出さない（先に入金を消す）", async () => {
    const { ctx, page } = await open(EDIT);
    await page.goto(`${origin}/invoices/edit/?id=${ID.partial}`);
    await page.getByText("I-2026-0002").first().waitFor();
    expect(await page.getByRole("button", { name: "取り消す" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "送付を記録する" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-011-36 請求を直せない権限なら、発行・送付・取消・入金の操作を出さない", async () => {
    const { ctx, page } = await open(["amount.read"]);
    await page.goto(`${origin}/invoices/edit/?id=${ID.partial}`);
    await page.getByText("I-2026-0002").first().waitFor();
    for (const n of ["送付を記録する", "取り消す", "発行する", "入金を記録する"]) expect(await page.getByRole("button", { name: n }).count(), n).toBe(0);
    expect(await page.getByRole("button", { name: /^入金を直す / }).count()).toBe(0);
    await ctx.close();
  });
});

describe("入金", () => {
  it("R-011-36 入金額と残高、入金の一覧（日付・金額・メモ）が出る", async () => {
    const { ctx, page } = await open(EDIT);
    await page.goto(`${origin}/invoices/edit/?id=${ID.partial}`);
    await page.getByText("内金").waitFor();
    const text = (await page.locator("section").innerText()).replace(/\s+/g, " ");
    expect(text).toContain("入金 ¥10,000 ／ 残高 ¥12,000");
    expect(text).toContain("2026年10月20日");
    await ctx.close();
  });

  it("R-011-36 入金を記録する：日付と金額（初めは残高）を RPC（record_payment）に渡し、入金済みになる", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    await page.goto(`${origin}/invoices/edit/?id=${ID.partial}`);
    await page.getByRole("button", { name: "入金を記録する" }).click();
    const form = page.locator('form[aria-label="入金を記録する"]');
    expect(await form.getByLabel("金額（円）").inputValue()).toBe("12000");
    await form.getByLabel("入金日").fill("2026-12-01");
    await form.getByLabel("メモ").fill("残りの入金");
    await form.getByRole("button", { name: "保存する" }).click();
    await page.getByText("入金を記録しました。入金済みになりました").waitFor();
    expect(rpcs.find((r) => r.name === "record_payment")!.body).toEqual({ p_invoice_id: ID.partial, p_paid_on: "2026-12-01", p_amount: 12000, p_note: "残りの入金" });
    await page.getByText("入金 ¥22,000 ／ 残高 ¥0").waitFor();
    expect(await page.getByRole("button", { name: "入金を記録する" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-011-36 残高を超える入金・日付なし・金額 0 は、RPC を呼ばずに理由を出す", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    await page.goto(`${origin}/invoices/edit/?id=${ID.partial}`);
    await page.getByRole("button", { name: "入金を記録する" }).click();
    const form = page.locator('form[aria-label="入金を記録する"]');
    await form.getByLabel("金額（円）").fill("12001");
    await form.getByRole("button", { name: "保存する" }).click();
    await page.getByText("請求の残高（12,000円）を超える入金は記録できません").waitFor();
    await form.getByLabel("金額（円）").fill("0");
    await form.getByLabel("入金日").fill("");
    await form.getByRole("button", { name: "保存する" }).click();
    await page.getByText("入金日を入れてください").waitFor();
    await page.getByText("金額は 0 より大きくしてください").waitFor();
    expect(rpcs.length).toBe(0);
    await ctx.close();
  });

  it("R-011-36 入金を消す：確認のうえで RPC（delete_payment）を呼ぶ", async () => {
    const { ctx, page, rpcs } = await open(EDIT);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/invoices/edit/?id=${ID.partial}`);
    await page.getByRole("button", { name: "入金を消す 2026-10-20" }).click();
    await page.getByText("入金を消しました").waitFor();
    expect(rpcs.find((r) => r.name === "delete_payment")!.body).toEqual({ p_id: "p1" });
    await page.getByText("入金 ¥0 ／ 残高 ¥22,000").waitFor();
    await ctx.close();
  });
});

describe("請求書の印刷", () => {
  it("R-011-33 インボイスの書き方：番号・発行日・取引の月・支払期日・宛先・明細・税率ごとの対象額と消費税・合計・会社・登録番号", async () => {
    const { ctx, page } = await open(EDIT);
    await page.goto(`${origin}/invoices/print/?id=${ID.issued}`);
    const paper = page.getByLabel("請求書", { exact: true });
    await paper.waitFor();
    const text = (await paper.innerText()).replace(/\s+/g, " ");
    for (const s of [
      "請求書", "青空管理株式会社 御中", "請求書番号：I-2026-0001", "発行日：2026年11月1日", "取引の月：2026年10月分", "支払期日：2099年11月30日",
      "ご請求金額（税込） ¥44,000", "ひまわりマンション 窓清掃", "10%対象 ¥40,000", "消費税（10%） ¥4,000", "合計 ¥44,000", "A清掃", "登録番号 T1234567890123",
    ]) {
      expect(text, s).toContain(s);
    }
    expect(await paper.locator(".qp-draft").count()).toBe(0);
    await ctx.close();
  });

  it("R-011-33 下書きは「下書き」、取消は「取消」の印。登録番号が未登録ならその行を出さない", async () => {
    const { ctx, page } = await open(EDIT, { noReg: true });
    await page.goto(`${origin}/invoices/print/?id=${ID.draft}`);
    await page.locator(".qp-draft", { hasText: "下書き" }).waitFor();
    const text = (await page.getByLabel("請求書", { exact: true }).innerText()).replace(/\s+/g, " ");
    expect(text).toContain("合計 ¥35,750"); // 下書きは画面で計算
    expect(text).not.toContain("登録番号");
    await page.goto(`${origin}/invoices/print/?id=${ID.cancelled}`);
    await page.locator(".qp-draft", { hasText: "取消" }).waitFor();
    await ctx.close();
  });
});
