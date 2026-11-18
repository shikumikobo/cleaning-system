// ユーザー向けマニュアルの画面キャプチャを撮る（デモ環境の画面から）。
// 使い方：node tools/demo/capture-manual.mjs   （先にデモ環境を起動。playwright は products/cleaning-demo に入れてある）
// 出力：docs/user-manual/manual-images/*.png （架空の会社のデータだけが映る）
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../../cleaning-demo/package.json"));
const { chromium } = require("playwright");
const OUT = join(here, "../../docs/user-manual/manual-images");
mkdirSync(OUT, { recursive: true });
const APP = "http://127.0.0.1:3000";
const GO = "http://127.0.0.1:3001/go/";

function sql(q) {
  return execFileSync("docker", ["exec", "cleaning-demo-db-1", "psql", "-U", "postgres", "-d", "postgres", "-h", "localhost", "-At", "-c", q], { encoding: "utf8" }).trim();
}
const jstToday = "(now() at time zone 'Asia/Tokyo')::date";
const ID = {
  quote5: sql("select id from quotes where number='Q-2026-0005'"),
  contract1: sql("select c.id from contracts c join buildings b on b.id=c.building_id where b.name='グリーンハイツ南青山'"),
  client1: sql("select id from clients where name='東都ビルマネジメント'"),
  bld1: sql("select id from buildings where name='グリーンハイツ南青山'"),
  inv1: sql("select id from invoices where number='INV-2026-0003'"),
  req1: sql("select id from requests where title='エントランスのガラスの汚れ'"),
  workFuture: sql("select w.id from works w join buildings b on b.id=w.building_id where b.name='サンライズタワー渋谷' and scheduled_date>" + jstToday + " order by scheduled_date limit 1"),
  workToday: sql("select w.id from works w join work_assignments a on a.work_id=w.id join memberships m on m.id=a.membership_id join auth.users u on u.id=m.user_id where u.email='demo-staff1@example.test' and scheduled_date=" + jstToday + " order by w.start_time limit 1"),
  reportChecked: sql("select r.id from reports r where r.status='checked' limit 1"),
};
console.log(ID);

const browser = await chromium.launch({ channel: "msedge", headless: true });

async function settle(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => !document.body.innerText.includes("読み込み中"), null, { timeout: 30000 }).catch(() => {});
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function session(role, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  if (role) {
    await page.goto(GO + role, { waitUntil: "domcontentloaded" });
    await page.waitForURL(APP + "/**", { timeout: 30000 });
    await settle(page);
  }
  return { ctx, page };
}

const PC = { viewport: { width: 1180, height: 740 }, deviceScaleFactor: 1, locale: "ja-JP", timezoneId: "Asia/Tokyo", colorScheme: "light" };
const PHONE = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP", timezoneId: "Asia/Tokyo", colorScheme: "light" };

async function shoot(page, name, path, after) {
  await page.goto(APP + path, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (after) await after(page);
  await page.screenshot({ path: join(OUT, name + ".png") });
  console.log("撮った", name);
}

// ---- ログイン前 ----
{
  const { ctx, page } = await session(null, PC);
  await shoot(page, "01_login", "/login/");
  await ctx.close();
}

// ---- 管理者（PC） ----
{
  const { ctx, page } = await session("admin", PC);
  await shoot(page, "02_home", "/");
  await shoot(page, "03_menu", "/", async (p) => { await p.locator("summary", { hasText: "メニュー" }).click(); await p.waitForTimeout(500); });
  await shoot(page, "10_requests", "/requests/");
  await shoot(page, "11_request_new", "/requests/new/");
  await shoot(page, "12_request_detail", "/requests/detail/?id=" + ID.req1);
  await shoot(page, "20_quotes", "/quotes/");
  await shoot(page, "21_quote_edit", "/quotes/edit/?id=" + ID.quote5);
  await shoot(page, "22_quote_items", "/quotes/items/");
  await shoot(page, "30_contracts", "/contracts/");
  await shoot(page, "31_contract_detail", "/contracts/detail/?id=" + ID.contract1);
  await shoot(page, "32_contract_new", "/contracts/new/");
  await shoot(page, "40_schedule", "/schedule/");
  await shoot(page, "41_work_detail", "/schedule/work/?id=" + ID.workFuture);
  await shoot(page, "42_work_new", "/schedule/new/");
  await shoot(page, "43_review", "/schedule/review/");
  await shoot(page, "50_reports", "/reports/");
  await shoot(page, "51_report_review", "/reports/review/?id=" + ID.reportChecked);
  await shoot(page, "52_templates", "/reports/templates/");
  await shoot(page, "60_invoices", "/invoices/");
  await shoot(page, "61_invoice_edit", "/invoices/edit/?id=" + ID.inv1);
  await shoot(page, "62_profit", "/profit/");
  await shoot(page, "63_costs", "/profit/costs/");
  await shoot(page, "64_cash_manage", "/cash/manage/");
  await shoot(page, "70_clients", "/clients/");
  await shoot(page, "71_client_edit", "/clients/edit/?id=" + ID.client1);
  await shoot(page, "72_building_edit", "/buildings/edit/?id=" + ID.bld1);
  await shoot(page, "73_import", "/import/");
  await shoot(page, "74_files", "/files/");
  await shoot(page, "75_map", "/map/", async (p) => { await p.waitForTimeout(2500); });
  await shoot(page, "80_users", "/settings/users/");
  await shoot(page, "81_tenant", "/settings/tenant/");
  await shoot(page, "82_notifications", "/notifications/");
  await shoot(page, "83_notif_settings", "/settings/notifications/");
  await ctx.close();
}

// ---- スタッフ（スマホ） ----
{
  const { ctx, page } = await session("staff1", PHONE);
  await shoot(page, "S1_home", "/");
  await shoot(page, "S2_mine", "/schedule/mine/");
  await shoot(page, "S3_report_edit", "/reports/edit/?work=" + ID.workToday);
  await shoot(page, "S4_reports", "/reports/");
  await shoot(page, "S5_photo_new", "/photos/new/");
  await shoot(page, "S6_request_new", "/requests/new/");
  await shoot(page, "S7_cash", "/cash/");
  await shoot(page, "S8_map", "/map/", async (p) => { await p.waitForTimeout(2500); });
  await ctx.close();
}

// ---- 外部（取引先） ----
{
  const { ctx, page } = await session("external", PC);
  await page.goto(APP + "/portal/", { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.screenshot({ path: join(OUT, "X1_portal.png") });
  console.log("撮った X1_portal");
  await ctx.close();
}

await browser.close();
