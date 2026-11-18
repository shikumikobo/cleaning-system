// 売上と粗利の画面の流れ（016）。共通の偽の接続先（harness.ts）の上に、売上と粗利まわりの表だけを自分で受ける（共通のファイルは変えない）。
import type { Server } from "node:http";
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
const ID = {
  c1: "00000000-0000-4000-8000-0000000000c1", c2: "00000000-0000-4000-8000-0000000000c2",
  b1: "00000000-0000-4000-8000-0000000000b1", b2: "00000000-0000-4000-8000-0000000000b2", b3: "00000000-0000-4000-8000-0000000000b3",
  k1: "00000000-0000-4000-8000-0000000000d1", k2: "00000000-0000-4000-8000-0000000000d2",
  cost1: "00000000-0000-4000-8000-0000000000e1", cost2: "00000000-0000-4000-8000-0000000000e2",
};

const prow = (over: Row): Row => ({
  tenant_id: TENANT_A, month: "2028-05-01", client_id: null, building_id: null, contract_id: null,
  revenue: 0, draft_revenue: 0, petty: 0, outsourcing: 0, material: 0, other_cost: 0, gross: 0, ...over,
});
// DB のテスト（24_profit.sql）の 2028 年 5 月と同じ行。前の月（2028-04）と前の年（2027-05）を足す
const PROFIT: Row[] = [
  prow({ client_id: ID.c1, building_id: ID.b1, contract_id: ID.k1, revenue: 40000, petty: 1500, gross: 38500 }),
  prow({ client_id: ID.c1, building_id: ID.b1, petty: 3000, outsourcing: 12000, gross: -15000 }),
  prow({ client_id: ID.c2, building_id: ID.b2, contract_id: ID.k2, revenue: 20000, material: 4000, gross: 16000 }),
  prow({ client_id: ID.c1, building_id: ID.b3, revenue: 8000, gross: 8000 }),
  prow({ client_id: ID.c2, building_id: ID.b2, draft_revenue: 6000 }),
  prow({ petty: 2000, other_cost: 1000, gross: -3000 }),
  prow({ month: "2028-04-01", client_id: ID.c1, building_id: ID.b1, contract_id: ID.k1, revenue: 30000, petty: 400, material: 2500, gross: 27100 }),
  prow({ month: "2027-05-01", client_id: ID.c1, building_id: ID.b1, contract_id: ID.k1, revenue: 25000, outsourcing: 5000, gross: 20000 }),
];

async function install(ctx: BrowserContext, opts: { perms: string[] }) {
  const costs: Row[] = [
    { id: ID.cost1, tenant_id: TENANT_A, month: "2028-05-01", building_id: ID.b1, contract_id: null, kind: "outsourcing", amount: 12000, note: "窓清掃の外注", created_at: "2028-06-01T00:00:00Z", deleted_at: null },
    { id: ID.cost2, tenant_id: TENANT_A, month: "2028-05-01", building_id: null, contract_id: null, kind: "other", amount: 1000, note: null, created_at: "2028-06-02T00:00:00Z", deleted_at: null },
  ];
  const requests: Array<{ table: string; method: string; query: string; body: Row | null }> = [];
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
  const table = (name: string, rows: () => Row[], store: Row[] | null = null) =>
    ctx.route((u) => u.origin === SUPABASE && u.pathname === `/rest/v1/${name}`, (route, req) => {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const body = req.postData() ? (JSON.parse(req.postData()!) as Row) : null;
      requests.push({ table: name, method: req.method(), query: new URL(req.url()).search, body });
      if (store && req.method() === "POST") {
        const row = { id: "new-cost", created_at: "2028-06-03T00:00:00Z", deleted_at: null, note: null, ...body! };
        store.push(row);
        return reply(route, req, [row]);
      }
      const out = filtered(req, rows());
      if (store && req.method() === "PATCH") {
        for (const r of out) Object.assign(r, body);
        return reply(route, req, out);
      }
      return reply(route, req, out);
    });
  await table("profit_monthly", () => PROFIT);
  await table("costs", () => costs.filter((c) => !c.deleted_at), costs);
  await table("clients", () => [
    { id: ID.c1, tenant_id: TENANT_A, kind: "management_company", name: "青空管理株式会社", deleted_at: null },
    { id: ID.c2, tenant_id: TENANT_A, kind: "management_company", name: "さくら不動産", deleted_at: null },
  ]);
  await table("buildings", () => [
    { id: ID.b1, tenant_id: TENANT_A, client_id: ID.c1, name: "ひまわりマンション", address: "東京都1", deleted_at: null },
    { id: ID.b2, tenant_id: TENANT_A, client_id: ID.c2, name: "さくらハイツ", address: "東京都2", deleted_at: null },
    { id: ID.b3, tenant_id: TENANT_A, client_id: ID.c1, name: "あおぞらビル", address: "東京都3", deleted_at: null },
  ]);
  await table("contracts", () => [
    { id: ID.k1, tenant_id: TENANT_A, client_id: ID.c1, building_id: ID.b1, source: "import", quote_id: null, kind: "recurring", start_date: "2028-01-01", end_date: null, status: "active", created_at: "2028-01-01T00:00:00Z", deleted_at: null },
    { id: ID.k2, tenant_id: TENANT_A, client_id: ID.c2, building_id: ID.b2, source: "import", quote_id: null, kind: "recurring", start_date: "2028-01-01", end_date: null, status: "active", created_at: "2028-01-01T00:00:00Z", deleted_at: null },
  ]);
  await table("tenants", () => [tenant(TENANT_A, "A清掃")]);
  await table("role_permissions", () => opts.perms.map((code) => ({ permissions: { code }, roles: { code: "admin" } })));
  return { costs, requests };
}

async function open(perms: string[]) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin] });
  const { ctx, page } = await newPage(browser, st);
  const fake = await install(ctx, { perms });
  return { ctx, page, ...fake };
}
const READ = ["amount.read"];
const EDIT = ["amount.read", "invoice.edit"];
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("売上と粗利", () => {
  it("R-016-21 月の売上・費用・粗利と、前の月・前の年との比べが出る（下書きは売上に入れない旨も）", async () => {
    const { ctx, page } = await open(READ);
    await page.goto(`${origin}/profit/`);
    await page.getByLabel("月", { exact: true }).fill("2028-05");
    const card = page.getByRole("group", { name: "月の合計" });
    await card.waitFor();
    const t = flat(await card.innerText());
    expect(t).toContain("2028年5月の合計");
    expect(t).toContain("売上 ¥68,000 ／ 費用 ¥23,500 ／ 粗利 ¥44,500（粗利率 65.4%）");
    expect(t).toContain("小口 ¥6,500 ／ 外注 ¥12,000 ／ 材料 ¥4,000 ／ その他 ¥1,000");
    expect(t).toContain("下書きの分 ¥6,000 は、売上に入れていません");
    const prev = flat(await page.getByRole("group", { name: "前の月（2028年4月）との比べ" }).innerText());
    expect(prev).toContain("売上 +¥38,000（+126.7%）");
    expect(prev).toContain("費用 +¥20,600（+710.3%）");
    expect(prev).toContain("粗利 +¥17,400（+64.2%）");
    const year = flat(await page.getByRole("group", { name: "前の年の同じ月（2027年5月）との比べ" }).innerText());
    expect(year).toContain("売上 +¥43,000（+172%）");
    expect(year).toContain("粗利 +¥24,500（+122.5%）");
    await ctx.close();
  });

  it("R-016-21 画面は、会社と3つの月（今・前の月・前の年）で絞って読む", async () => {
    const { ctx, page, requests } = await open(READ);
    await page.goto(`${origin}/profit/`);
    await page.getByLabel("月", { exact: true }).fill("2028-05");
    await page.getByRole("group", { name: "月の合計" }).waitFor();
    const q = decodeURIComponent(requests.filter((r) => r.table === "profit_monthly").at(-1)!.query);
    expect(q).toContain(`tenant_id=eq.${TENANT_A}`);
    expect(q).toContain("month=in.(2028-05-01,2028-04-01,2027-05-01)");
    await ctx.close();
  });

  it("R-016-7・21 建物ごと・契約ごと・取引先ごとに切り替えられ、「なし」の行も出る", async () => {
    const { ctx, page } = await open(READ);
    await page.goto(`${origin}/profit/`);
    await page.getByLabel("月", { exact: true }).fill("2028-05");
    await page.getByRole("group", { name: "月の合計" }).waitFor();
    // 建物ごと（初めの切り方）：売上の多い順
    const b1 = flat(await page.getByRole("group", { name: "ひまわりマンション" }).innerText());
    expect(b1).toContain("売上 ¥40,000 ／ 費用 ¥16,500 ／ 粗利 ¥23,500（58.8%）");
    expect(await page.getByRole("group", { name: "建物なし（共通）" }).count()).toBe(1);
    await page.getByLabel("集め方").selectOption("contract");
    const none = flat(await page.getByRole("group", { name: "契約なし" }).innerText());
    expect(none).toContain("売上 ¥8,000");
    expect(await page.getByRole("group", { name: "ひまわりマンション 定期（2028-01-01〜）" }).count()).toBe(1);
    await page.getByLabel("集め方").selectOption("client");
    const c1 = flat(await page.getByRole("group", { name: "青空管理株式会社" }).innerText());
    expect(c1).toContain("売上 ¥48,000");
    expect(await page.getByRole("group", { name: "取引先なし（共通）" }).count()).toBe(1);
    await ctx.close();
  });

  it("R-016-21 売上のない月は、そう出る（0 で割らない）", async () => {
    const { ctx, page } = await open(READ);
    await page.goto(`${origin}/profit/`);
    await page.getByLabel("月", { exact: true }).fill("2030-01");
    await page.getByText("この月の売上と費用はありません。").waitFor();
    const t = flat(await page.getByRole("group", { name: "月の合計" }).innerText());
    expect(t).toContain("売上 ¥0 ／ 費用 ¥0 ／ 粗利 ¥0（粗利率 ―）");
    await ctx.close();
  });

  it("R-016-14・21 amount.read を持たない人には、数字を出さず、DB も読まない", async () => {
    const { ctx, page, requests } = await open([]);
    await page.goto(`${origin}/profit/`);
    await page.getByText("売上と粗利を見る権限がありません").waitFor();
    expect(await page.getByRole("group", { name: "月の合計" }).count()).toBe(0);
    expect(requests.filter((r) => r.table === "profit_monthly").length).toBe(0);
    await ctx.close();
  });
});

describe("費用", () => {
  it("R-016-21 月の費用の一覧と合計が出る", async () => {
    const { ctx, page } = await open(EDIT);
    await page.goto(`${origin}/profit/costs/`);
    await page.getByLabel("見る月").fill("2028-05");
    await page.getByText("2028年5月の費用 2 件・合計 ¥13,000").waitFor();
    const t = flat(await page.getByRole("group", { name: "費用 外注 ¥12,000" }).innerText());
    expect(t).toContain("ひまわりマンション");
    expect(t).toContain("窓清掃の外注");
    expect(flat(await page.getByRole("group", { name: "費用 その他 ¥1,000" }).innerText())).toContain("建物を決めない");
    await ctx.close();
  });

  it("R-016-20 費用を入れる：検査が通れば、月・種類・金額・建物を送る（会社を付けて）", async () => {
    const { ctx, page, requests } = await open(EDIT);
    await page.goto(`${origin}/profit/costs/`);
    await page.getByLabel("見る月").fill("2028-05");
    await page.getByText("2028年5月の費用 2 件").waitFor();
    const form = page.locator('form[aria-label="費用を入れる"]');
    await form.getByLabel("種類").selectOption("material");
    await form.getByLabel("金額").fill("4,500");
    await form.getByLabel("建物").selectOption(ID.b2);
    await form.getByLabel("メモ").fill("洗剤");
    await form.getByRole("button", { name: "費用を入れる" }).click();
    await page.getByText("費用を入れました").waitFor();
    const post = requests.find((r) => r.table === "costs" && r.method === "POST")!;
    expect(post.body).toEqual({ tenant_id: TENANT_A, month: "2028-05-01", kind: "material", amount: 4500, building_id: ID.b2, contract_id: null, note: "洗剤" });
    await page.getByText("2028年5月の費用 3 件・合計 ¥17,500").waitFor();
    await ctx.close();
  });

  it("R-016-20 金額が正しくなければ、送らずに理由を出す。建物と合わない契約も止める", async () => {
    const { ctx, page, requests } = await open(EDIT);
    await page.goto(`${origin}/profit/costs/`);
    const form = page.locator('form[aria-label="費用を入れる"]');
    await form.waitFor();
    await form.getByLabel("費用の月").fill("2028-05");
    await form.getByLabel("金額").fill("0");
    await form.getByRole("button", { name: "費用を入れる" }).click();
    await page.getByText("金額は 1 円以上にしてください").waitFor();
    await form.getByLabel("金額").fill("abc");
    await form.getByRole("button", { name: "費用を入れる" }).click();
    await page.getByText("金額は、円の整数で入れてください").waitFor();
    await form.getByLabel("費用の月").fill("");
    await form.getByLabel("金額").fill("100");
    await form.getByRole("button", { name: "費用を入れる" }).click();
    await page.getByText("月を選んでください").first().waitFor();
    expect(requests.filter((r) => r.table === "costs" && r.method === "POST").length).toBe(0);
    // 建物を選ぶと、その建物の契約だけが選べる
    await form.getByLabel("建物").selectOption(ID.b1);
    const options = await form.getByLabel("契約").locator("option").allInnerTexts();
    expect(options.join("|")).toContain("ひまわりマンション");
    expect(options.join("|")).not.toContain("さくらハイツ");
    await ctx.close();
  });

  it("R-016-20 DB が断ったら、日本語の理由を出す", async () => {
    const { ctx, page } = await open(EDIT);
    await ctx.route((u) => u.origin === SUPABASE && u.pathname === "/rest/v1/costs", (route, req) => {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (req.method() === "POST") return route.fulfill({ status: 403, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ code: "42501", message: "new row violates row-level security policy" }) });
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: "[]" });
    });
    await page.goto(`${origin}/profit/costs/`);
    const form = page.locator('form[aria-label="費用を入れる"]');
    await form.getByLabel("費用の月").fill("2028-05");
    await form.getByLabel("金額").fill("100");
    await form.getByRole("button", { name: "費用を入れる" }).click();
    await page.getByText("費用を入れる権限がないか、建物と契約が合っていません").waitFor();
    await ctx.close();
  });

  it("R-016-9 費用を直す：直した列を送り、一覧に反映する", async () => {
    const { ctx, page, requests } = await open(EDIT);
    await page.goto(`${origin}/profit/costs/`);
    await page.getByLabel("見る月").fill("2028-05");
    await page.getByRole("button", { name: "直す 外注 ¥12,000" }).click();
    const form = page.locator('form[aria-label="費用を直す"]');
    await form.getByLabel("金額").fill("15000");
    await form.getByRole("button", { name: "直す", exact: true }).click();
    await page.getByText("費用を直しました").waitFor();
    const patch = requests.find((r) => r.table === "costs" && r.method === "PATCH")!;
    expect(decodeURIComponent(patch.query)).toContain(`id=eq.${ID.cost1}`);
    expect(patch.body).toMatchObject({ amount: 15000, kind: "outsourcing", building_id: ID.b1 });
    await page.getByText("2028年5月の費用 2 件・合計 ¥16,000").waitFor();
    await ctx.close();
  });

  it("R-016-9 費用を消す：確かめてから、deleted_at を入れて一覧から外す", async () => {
    const { ctx, page, requests } = await open(EDIT);
    await page.goto(`${origin}/profit/costs/`);
    await page.getByLabel("見る月").fill("2028-05");
    await page.getByRole("button", { name: "消す 外注 ¥12,000" }).click();
    expect(requests.filter((r) => r.method === "PATCH").length).toBe(0); // 確かめるまでは消さない
    await page.getByRole("button", { name: /^消す（この費用を一覧から外します）/ }).click();
    await page.getByText("費用を消しました").waitFor();
    const patch = requests.find((r) => r.table === "costs" && r.method === "PATCH")!;
    expect(Object.keys(patch.body!)).toEqual(["deleted_at"]);
    await page.getByText("2028年5月の費用 1 件・合計 ¥1,000").waitFor();
    await ctx.close();
  });

  it("R-016-21 費用を直せない権限（amount.read だけ）なら、入れる・直す・消す操作を出さない", async () => {
    const { ctx, page } = await open(READ);
    await page.goto(`${origin}/profit/costs/`);
    await page.getByLabel("見る月").fill("2028-05");
    await page.getByText("2028年5月の費用 2 件").waitFor();
    expect(await page.locator("form").count()).toBe(0);
    expect(await page.getByRole("button", { name: /^直す/ }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /^消す/ }).count()).toBe(0);
    await ctx.close();
  });

  it("R-016-14・21 amount.read を持たない人には、費用も出さない", async () => {
    const { ctx, page, requests } = await open([]);
    await page.goto(`${origin}/profit/costs/`);
    await page.getByText("売上と粗利を見る権限がありません").waitFor();
    expect(requests.filter((r) => r.table === "costs").length).toBe(0);
    await ctx.close();
  });
});
