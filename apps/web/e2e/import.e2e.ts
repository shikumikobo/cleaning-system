// データの取り込みの画面の流れ（014）。共通の偽の接続先（harness.ts）の上に、取り込みまわりの表と RPC だけを自分で受ける（共通のファイルは変えない）。
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { Browser, BrowserContext, Request, Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templateCsv, templateXlsx } from "../src/lib/import/template";
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

interface Opts {
  perms: string[];
  /** RPC が全体を断る理由 */
  failReason?: string;
  /** RPC が返す、サーバーで取り込めなかった行 */
  serverDetails?: Array<{ row: number; status: "error" | "duplicate"; messages: string[]; by: string }>;
}

async function installImport(ctx: BrowserContext, opts: Opts) {
  const clients: Row[] = [{ id: "c1", tenant_id: TENANT_A, name: "登録済みの管理会社", deleted_at: null }];
  const jobs: Row[] = [
    { id: "j1", tenant_id: TENANT_A, kind: "clients", file_name: "前の取引先.csv", status: "partial", total_rows: 5, created_count: 3, skipped_count: 1, error_rows: 1, created_at: "2026-11-10T01:30:00Z", deleted_at: null },
  ];
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const send = (route: Route, req: Request, rows: Row[]) => {
    const url = new URL(req.url());
    let out = rows;
    for (const [k, v] of url.searchParams) {
      if (k.includes(".") || k === "order" || k === "limit" || k === "select") continue;
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k]) === v.slice(3));
      else if (v === "is.null") out = out.filter((r) => r[k] === null || r[k] === undefined);
    }
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(out) });
  };
  const table = (name: string, rows: () => Row[]) =>
    ctx.route((u) => u.origin === SUPABASE && u.pathname === `/rest/v1/${name}`, (route, req) => {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      calls.push({ name: `GET ${name}`, body: {} });
      return send(route, req, rows());
    });
  await table("clients", () => clients);
  await table("buildings", () => []);
  await table("rooms", () => []);
  await table("contracts", () => []);
  await table("contract_services", () => []);
  await table("import_jobs", () => jobs);
  await table("role_permissions", () => opts.perms.map((code) => ({ permissions: { code }, roles: { code: "admin" } })));
  await ctx.route((u) => u.origin === SUPABASE && u.pathname.startsWith("/rest/v1/rpc/"), (route, req) => {
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.split("/").pop()!;
    const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : {};
    calls.push({ name, body });
    const ok = (o: unknown) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(o) });
    if (name === "import_rows") {
      if (opts.failReason) return ok({ ok: false, reason: opts.failReason });
      const rows = body.p_rows as Row[];
      const excl = body.p_excluded as Array<{ row: number; status: "error" | "duplicate"; messages: string[] }>;
      const server = opts.serverDetails ?? [];
      const details = [...excl.map((x) => ({ ...x, by: "client" })), ...server];
      const created = rows.length - server.length;
      jobs.unshift({
        id: "j2", tenant_id: TENANT_A, kind: body.p_kind, file_name: body.p_file_name, status: "done", total_rows: body.p_total_rows, created_count: created,
        skipped_count: details.filter((d) => d.status === "duplicate").length, error_rows: details.filter((d) => d.status === "error").length, created_at: "2026-11-20T02:00:00Z", deleted_at: null,
      });
      return ok({
        ok: true, job_id: "j2", status: "done", created, skipped: details.filter((d) => d.status === "duplicate").length,
        errors: details.filter((d) => d.status === "error").length, details,
      });
    }
    return route.fulfill({ status: 404, headers: CORS, body: JSON.stringify({ message: "no rpc" }) });
  });
  return { calls };
}

async function open(opts: Opts) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin] });
  const { ctx, page } = await newPage(browser, st);
  const fake = await installImport(ctx, opts);
  await page.goto(`${origin}/import/`);
  await page.getByLabel("取り込むもの").waitFor();
  return { ctx, page, ...fake };
}
const all = ["master.edit", "contract.edit", "amount.read"];
const csv = (s: string) => ({ name: "取引先.csv", mimeType: "text/csv", buffer: Buffer.from("﻿" + s, "utf8") });
const CLIENTS_CSV = "名前,種類,住所,電話,メール,締め日,支払い条件\r\n新しい商事,オーナー,東京都,,,25,\r\n,,,,,,\r\n登録済みの管理会社,,,,,,\r\n名前だけ,テナント,,,,,\r\nメール不正,,,,bad,,\r\n";

describe("確かめ", () => {
  it("R-014-10 ファイルを選ぶと、取り込める件数・重なり・エラーの行と一覧が出る。この時点では書かない（import_rows を呼ばない）", async () => {
    const { ctx, page, calls } = await open({ perms: all });
    await page.getByLabel("ファイルを選ぶ").setInputFiles(csv(CLIENTS_CSV));
    const sec = page.getByRole("region", { name: "取り込む前の確かめ" });
    await sec.getByText("取り込める：1件").waitFor();
    const text = (await sec.innerText()).replace(/\s+/g, " ");
    for (const s of ["ファイルの行：4", "重なり：1件", "エラーの行：2", "新しい商事"]) expect(text, s).toContain(s);
    const errs = (await sec.getByRole("table", { name: "エラーの行" }).innerText()).replace(/\s+/g, " ");
    expect(errs).toContain("5行目 種類");
    expect(errs).toContain("6行目 メール");
    const dups = (await sec.getByRole("table", { name: "重なりの行" }).innerText()).replace(/\s+/g, " ");
    expect(dups).toContain("4行目");
    expect(calls.filter((c) => c.name === "import_rows").length).toBe(0);
    await ctx.close();
  });

  it("R-014-10 必須の見出しが足りなければ、足りない見出しを出して確かめに進まない", async () => {
    const { ctx, page } = await open({ perms: all });
    await page.getByLabel("取り込むもの").selectOption("buildings");
    await page.getByLabel("ファイルを選ぶ").setInputFiles(csv("取引先名,建物名\r\nA,B\r\n"));
    await page.getByText("ファイルの見出しが足りません：住所").waitFor();
    expect(await page.getByRole("region", { name: "取り込む前の確かめ" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-014-10 Excel（.xlsx）のひな形も読める", async () => {
    const { ctx, page } = await open({ perms: all });
    await page.getByLabel("ファイルを選ぶ").setInputFiles({
      name: "ひな形.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(templateXlsx("clients")),
    });
    await page.getByRole("region", { name: "取り込む前の確かめ" }).getByText("取り込める：2件").waitFor();
    await ctx.close();
  });
});

describe("取り込み", () => {
  it("R-014-11 OK を押すと、取り込める行だけを RPC（import_rows）に渡す。エラーと重なりの行は記録として渡す", async () => {
    const { ctx, page, calls } = await open({ perms: all });
    await page.getByLabel("ファイルを選ぶ").setInputFiles(csv(CLIENTS_CSV));
    await page.getByText("取り込める：1件").waitFor();
    await page.getByRole("button", { name: "この内容で取り込む" }).click();
    await page.getByRole("region", { name: "取り込みの結果" }).waitFor();
    const call = calls.find((c) => c.name === "import_rows")!;
    expect(call.body.p_tenant).toBe(TENANT_A);
    expect(call.body.p_kind).toBe("clients");
    expect(call.body.p_file_name).toBe("取引先.csv");
    expect(call.body.p_total_rows).toBe(4);
    expect((call.body.p_rows as Row[]).map((r) => r.name)).toEqual(["新しい商事"]);
    expect((call.body.p_excluded as Array<{ row: number; status: string }>).map((x) => [x.row, x.status])).toEqual([[4, "duplicate"], [5, "error"], [6, "error"]]);
    expect(calls.filter((c) => c.name === "import_rows").length).toBe(1);
    await ctx.close();
  });

  it("R-014-17 結果に、取り込んだ数・重なりで飛ばした数・エラーの行と、取り込まなかった行の一覧（理由は日本語）が出る。履歴にも載る", async () => {
    const { ctx, page } = await open({
      perms: all,
      serverDetails: [{ row: 2, status: "error", messages: ["invalid_closing_day"], by: "server" }],
    });
    await page.getByLabel("ファイルを選ぶ").setInputFiles(csv("名前\r\n甲\r\n乙\r\n丙\r\n"));
    await page.getByText("取り込める：3件").waitFor();
    await page.getByRole("button", { name: "この内容で取り込む" }).click();
    const res = page.getByRole("region", { name: "取り込みの結果" });
    await res.getByText("取り込んだ数：2件").waitFor();
    const text = (await res.innerText()).replace(/\s+/g, " ");
    expect(text).toContain("エラーの行：1");
    expect(text).toContain("重なりで飛ばした数：0");
    expect(text).toContain("2行目 エラー 締め日は 1〜31 の整数にしてください");
    // 確かめの画面は消え、履歴に今回の取り込みが載る
    expect(await page.getByRole("region", { name: "取り込む前の確かめ" }).count()).toBe(0);
    await page.getByRole("region", { name: "取り込みの履歴" }).getByText("取引先：取引先.csv").waitFor();
    await ctx.close();
  });

  it("R-014-17 RPC が全体を断ったら、日本語の理由を出し、結果は出さない", async () => {
    const { ctx, page } = await open({ perms: all, failReason: "invalid_rows" });
    await page.getByLabel("ファイルを選ぶ").setInputFiles(csv("名前\r\n甲\r\n"));
    await page.getByRole("button", { name: "この内容で取り込む" }).click();
    await page.getByText("取り込む行の形が正しくありません").waitFor();
    expect(await page.getByRole("region", { name: "取り込みの結果" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-014-11 取り込めるものが0なら、取り込むボタンを押せない", async () => {
    const { ctx, page, calls } = await open({ perms: all });
    await page.getByLabel("ファイルを選ぶ").setInputFiles(csv("名前\r\n登録済みの管理会社\r\n"));
    await page.getByText("取り込める：0件").waitFor();
    expect(await page.getByRole("button", { name: "この内容で取り込む" }).isDisabled()).toBe(true);
    expect(calls.filter((c) => c.name === "import_rows").length).toBe(0);
    await ctx.close();
  });

  it("R-014-11 ファイルを選び直すと、確かめからやり直す（前の確かめは消える）", async () => {
    const { ctx, page } = await open({ perms: all });
    await page.getByLabel("ファイルを選ぶ").setInputFiles(csv(CLIENTS_CSV));
    await page.getByText("取り込める：1件").waitFor();
    await page.getByLabel("ファイルを選ぶ").setInputFiles(csv("名前\r\n甲\r\n乙\r\n"));
    await page.getByText("取り込める：2件").waitFor();
    expect(await page.getByRole("table", { name: "エラーの行" }).count()).toBe(0);
    await ctx.close();
  });
});

describe("ひな形・権限・履歴", () => {
  it("R-014-1 ひな形（CSV）をダウンロードできる。中身は、ひな形のとおり", async () => {
    const { ctx, page } = await open({ perms: all });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "ひな形（CSV）" }).click()]);
    expect(dl.suggestedFilename()).toBe("ひな形_取引先.csv");
    const path = await dl.path();
    expect(readFileSync(path!, "utf8")).toBe(templateCsv("clients"));
    const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "ひな形（Excel）" }).click()]);
    expect(dl2.suggestedFilename()).toBe("ひな形_取引先.xlsx");
    await ctx.close();
  });

  it("R-014-18 取り込みの権限（master.edit）がなければ、ファイルを上げる操作を出さない", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin] });
    const { ctx, page } = await newPage(browser, st);
    await installImport(ctx, { perms: ["amount.read"] });
    await page.goto(`${origin}/import/`);
    await page.getByText("取り込みをする権限がありません。").waitFor();
    expect(await page.getByLabel("ファイルを選ぶ").count()).toBe(0);
    await ctx.close();
  });

  it("R-014-18 契約の権限（contract.edit）がなければ、契約は選べない。あれば選べる", async () => {
    const a = await open({ perms: ["master.edit"] });
    expect(await a.page.getByLabel("取り込むもの").locator("option").allInnerTexts()).toEqual(["取引先", "建物", "部屋"]);
    await a.ctx.close();
    const b = await open({ perms: all });
    expect(await b.page.getByLabel("取り込むもの").locator("option").allInnerTexts()).toEqual(["取引先", "建物", "部屋", "契約"]);
    await b.ctx.close();
  });

  it("R-014-19 取り込みの履歴に、日時・種類・ファイル名・件数が出る", async () => {
    const { ctx, page } = await open({ perms: all });
    const hist = page.getByRole("region", { name: "取り込みの履歴" });
    await hist.getByText("取引先：前の取引先.csv").waitFor();
    const text = (await hist.innerText()).replace(/\s+/g, " ");
    expect(text).toContain("2026年11月10日 10:30");
    expect(text).toContain("取り込み 3 ／ 重なり 1 ／ エラー 1");
    expect(text).toContain("エラーの行あり");
    await ctx.close();
  });
});
