// 予定と実績の画面の流れ（012）。共通の偽の接続先（harness.ts）の上に、作業まわりの表と RPC だけを自分で受ける（共通のファイルは変えない）。
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
const staffMember: FakeMember = { id: "m-staff", tenant_id: TENANT_A, user_id: "u-me", status: "active", role: "staff", display_name: "青木" };

type Row = Record<string, unknown>;
const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";
const day = (offset: number) => new Date(Date.now() + 9 * 3600 * 1000 + offset * 86400 * 1000).toISOString().slice(0, 10);
const TODAY = day(0);
const SVC = "00000000-0000-4000-8000-0000000000e1";
const REQ = "00000000-0000-4000-8000-0000000000f1";

const work = (id: string, over: Row = {}): Row => ({
  id, tenant_id: TENANT_A, building_id: B1, contract_service_id: SVC, request_id: null, service_key: "k", title: "定期清掃", scheduled_date: TODAY, start_time: null, end_time: null,
  status: "scheduled", version: 1, run_id: null, deleted_at: null, ...over,
});

interface Fake {
  works: Row[];
  assignments: Row[];
  openRecords: Row[];
  overlaps: Row[];
  plan: Row[];
  monthly: Row[];
  staff: Row[];
  conflicts: Row[];
  /** true の間、開始・終了の RPC は電波がないふり（通信が切れる） */
  offline: boolean;
  /** RPC が断る理由（RPC 名 → reason） */
  refuse: Record<string, string>;
  rpcs: Array<{ name: string; body: Record<string, unknown> }>;
  posts: Array<{ table: string; body: unknown }>;
}

async function install(ctx: BrowserContext, perms: string[], over: Partial<Fake> = {}): Promise<Fake> {
  const f: Fake = {
    works: [], assignments: [], openRecords: [], overlaps: [], plan: [], monthly: [], staff: [
      { membership_id: "m-staff", display_name: "青木", role_code: "staff" },
      { membership_id: "m-staff2", display_name: "石田", role_code: "staff" },
    ], conflicts: [], offline: false, refuse: {}, rpcs: [], posts: [], ...over,
  };
  const json = (route: Route, o: unknown) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(o) });
  const filter = (req: Request, rows: Row[]) => {
    const url = new URL(req.url());
    let out = rows;
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(k) || k.includes(".")) continue;
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith("neq.")) out = out.filter((r) => String(r[k]) !== v.slice(4));
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
        if (req.method() === "POST") {
          const body = JSON.parse(req.postData() ?? "{}");
          f.posts.push({ table: name, body });
          return route.fulfill({ status: 201, headers: CORS, body: "" });
        }
        if (req.method() === "PATCH") {
          f.posts.push({ table: name, body: JSON.parse(req.postData() ?? "{}") });
          return route.fulfill({ status: 204, headers: CORS });
        }
        const out = filter(req, rows());
        const single = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
        return json(route, single ? out[0] ?? null : out);
      },
    );
  void table("works", () => f.works);
  void table("work_assignments", () => f.assignments);
  void table("work_records", () => f.openRecords);
  void table("work_overlaps", () => f.overlaps);
  void table("work_plan_actual", () => f.plan);
  void table("work_monthly", () => f.monthly);
  void table("contracts", () => [{ id: "c1", building_id: B1, tenant_id: TENANT_A, status: "active", deleted_at: null }]);
  void table("contract_services", () => [{ id: SVC, name: "定期清掃", contract_id: "c1", tenant_id: TENANT_A, valid_to: null, deleted_at: null }]);
  void table("requests", () => [{ id: REQ, title: "臨時の窓清掃", building_id: B2, status: "new", tenant_id: TENANT_A, deleted_at: null }]);
  void table("buildings", () => [
    { id: B1, tenant_id: TENANT_A, client_id: "c", owner_client_id: null, name: "ひまわりマンション", address: "東京都1", lat: null, lng: null, location_fixed: false, deleted_at: null },
    { id: B2, tenant_id: TENANT_A, client_id: "c", owner_client_id: null, name: "さくらビル", address: "東京都2", lat: null, lng: null, location_fixed: false, deleted_at: null },
  ]);
  void table("role_permissions", () => perms.map((code) => ({ permissions: { code }, roles: { code: "x" } })));
  await ctx.route((u) => u.origin === SUPABASE && u.pathname.startsWith("/rest/v1/rpc/"), (route, req) => {
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.split("/").pop()!;
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    if ((name === "start_work" || name === "finish_work") && f.offline) return route.abort("failed");
    f.rpcs.push({ name, body });
    const w = f.works.find((x) => x.id === body.p_work_id);
    if (name === "work_staff") return json(route, f.staff);
    if (name === "assign_conflicts") return json(route, f.conflicts);
    if (f.refuse[name]) return json(route, { ok: false, reason: f.refuse[name] });
    if (name === "start_work" && w) {
      w.status = "in_progress";
      f.openRecords.push({ id: body.p_id, tenant_id: TENANT_A, work_id: w.id, membership_id: "m-staff", started_at: body.p_started_at, ended_at: null, deleted_at: null });
      return json(route, { ok: true, id: body.p_id });
    }
    if (name === "finish_work" && w) {
      w.status = "done";
      f.openRecords = f.openRecords.filter((r) => r.work_id !== w.id);
      return json(route, { ok: true, status: "done" });
    }
    if (name === "create_work") return json(route, { ok: true, id: body.p_id });
    return json(route, { ok: true, version: 2 });
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
const MANAGER_PERMS = ["work.assign", "field.record", "amount.read"];
const mine = (...ids: string[]): Row[] => ids.map((id) => ({ id: `a-${id}`, tenant_id: TENANT_A, work_id: id, membership_id: "m-staff", deleted_at: null }));

describe("自分の予定（スマホ）", () => {
  it("R-012-27 自分が担当の、取消でない作業が、今日・これからに分かれて出る", async () => {
    const { ctx, page } = await open(STAFF_PERMS, {
      works: [
        work("w1", { start_time: "13:00:00", end_time: "15:00:00", title: "午後の清掃" }),
        work("w2", { start_time: "09:00:00", end_time: "11:00:00", title: "朝の清掃" }),
        work("w3", { scheduled_date: day(3), title: "三日後の清掃", building_id: B2 }),
        work("w4", { title: "取り消した清掃", status: "cancelled" }),
        work("w5", { title: "ほかの人の清掃" }),
      ],
      assignments: mine("w1", "w2", "w3", "w4"),
    }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByText("朝の清掃").waitFor();
    const text = (await page.locator("section").innerText()).replace(/\s+/g, " ");
    expect(text.indexOf("朝の清掃")).toBeLessThan(text.indexOf("午後の清掃"));
    expect(text.indexOf("午後の清掃")).toBeLessThan(text.indexOf("三日後の清掃"));
    expect(text).toContain("さくらビル");
    expect(text).not.toContain("取り消した清掃");
    expect(text).not.toContain("ほかの人の清掃");
    expect(await page.getByRole("link", { name: "予定表" }).count()).toBe(0);
    await ctx.close();
  });

  it("R-012-28・29 「開始」を押すと、端末の uuid つきで start_work を送り、「終了」に変わる。行った項目は報告書の画面へ", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    await page.getByRole("button", { name: "位置なしで開始" }).click(); // 013：位置の了承（位置なしで押す）
    await page.getByText("開始を送りました").waitFor();
    await page.getByRole("button", { name: "終了：朝の清掃" }).waitFor();
    const start = fake.rpcs.find((r) => r.name === "start_work")!;
    expect(start.body).toMatchObject({ p_work_id: "w1" });
    expect(typeof start.body.p_id).toBe("string");
    expect(typeof start.body.p_started_at).toBe("string");
    expect(await page.getByText("作業中").count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "終了：朝の清掃" }).click();
    await page.getByRole("button", { name: "位置なしで終了" }).click(); // 013：位置の了承（位置なしで押す）
    await page.getByText("終了を送りました").waitFor();
    const fin = fake.rpcs.find((r) => r.name === "finish_work")!;
    expect(fin.body).toMatchObject({ p_work_id: "w1" });
    expect(fin.body.p_id).not.toBe(start.body.p_id);
    await page.getByRole("button", { name: /^(開始|終了)：/ }).waitFor({ state: "detached" }); // 完了：ボタンは出ない
    expect(await page.getByRole("link", { name: "行った項目（報告書）" }).getAttribute("href")).toBe("/reports/edit/?work=w1");
    await ctx.close();
  });

  it("R-012-28 電波がなくても押せる：端末にため（送信待ち）、電波が戻ると自動で1回だけ送る", async () => {
    const { ctx, page, fake } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/mine/`);
    await page.getByRole("button", { name: "開始：朝の清掃" }).waitFor();
    fake.offline = true;
    await page.getByRole("button", { name: "開始：朝の清掃" }).click();
    await page.getByRole("button", { name: "位置なしで開始" }).click(); // 013：位置の了承（位置なしで押す）
    await page.getByText("電波がないので、端末にためました").waitFor();
    await page.getByText("送信待ち（端末にためてあります）").waitFor();
    await page.getByRole("button", { name: "終了：朝の清掃" }).waitFor(); // 開始が送信待ちなら、先に「終了」を出す
    expect(fake.rpcs.filter((r) => r.name === "start_work").length).toBe(0);
    // 電波が戻る
    fake.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.getByText("送信待ち（端末にためてあります）").waitFor({ state: "detached", timeout: 20000 });
    expect(fake.rpcs.filter((r) => r.name === "start_work").length).toBe(1);
    await ctx.close();
  });
});

describe("予定表（社員）", () => {
  const overlapping = () => ({
    works: [
      work("w1", { title: "午前の清掃", start_time: "09:00:00", end_time: "11:00:00" }),
      work("w2", { title: "重なる臨時作業", start_time: "10:00:00", end_time: "12:00:00", building_id: B2 }),
      work("w3", { title: "担当なしの作業", start_time: "13:00:00", end_time: "14:00:00" }),
      work("w4", { title: "取消の作業", status: "cancelled" }),
    ],
    assignments: [
      { id: "a1", tenant_id: TENANT_A, work_id: "w1", membership_id: "m-staff", deleted_at: null },
      { id: "a2", tenant_id: TENANT_A, work_id: "w2", membership_id: "m-staff", deleted_at: null },
    ],
    overlaps: [
      { tenant_id: TENANT_A, membership_id: "m-staff", work_id: "w1", other_work_id: "w2", scheduled_date: TODAY },
      { tenant_id: TENANT_A, membership_id: "m-staff", work_id: "w2", other_work_id: "w1", scheduled_date: TODAY },
    ],
  });

  it("R-012-30 週の予定表：スタッフごとにまとまり、担当なしは別、取消は出ず、重なりは警告が出る", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, overlapping());
    await page.goto(`${origin}/schedule/`);
    await page.getByLabel("週の予定表").waitFor();
    const table = (await page.getByLabel("週の予定表").innerText()).replace(/\s+/g, " ");
    expect(table).toContain("青木");
    expect(table).toContain("担当なし");
    expect(table).toContain("午前の清掃");
    expect(table).toContain("担当なしの作業");
    expect(table).not.toContain("取消の作業");
    expect(await page.getByRole("alert").filter({ hasText: "時刻が重なっています" }).count()).toBeGreaterThanOrEqual(2);
    expect(await page.getByText("同じ人の時刻が重なっている作業が 2 件あります").count()).toBe(1);
    await ctx.close();
  });

  it("R-012-30 建物ごと・日・月に切り替えられ、前後へ動かせる", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, overlapping());
    await page.goto(`${origin}/schedule/`);
    await page.getByLabel("週の予定表").waitFor();
    await page.getByLabel("まとめ方").selectOption("building");
    await page.locator('[data-group="' + B2 + '"]').waitFor();
    expect((await page.getByLabel("週の予定表").innerText()).replace(/\s+/g, " ")).toContain("さくらビル");
    await page.getByRole("button", { name: "日", exact: true }).click();
    await page.getByRole("heading", { level: 2 }).filter({ hasText: /^\d{4}年\d{1,2}月\d{1,2}日$/ }).waitFor();
    expect(await page.getByLabel("週の予定表").count()).toBe(0);
    await page.getByRole("button", { name: "月", exact: true }).click();
    await page.getByRole("heading", { level: 2 }).filter({ hasText: /^\d{4}年\d{1,2}月$/ }).waitFor();
    const before = await page.getByRole("heading", { level: 2 }).filter({ hasText: /^\d{4}年\d{1,2}月$/ }).innerText();
    await page.getByRole("button", { name: "次へ" }).click();
    await page.waitForFunction((b) => ![...document.querySelectorAll("h2")].some((h) => h.textContent === b), before);
    await ctx.close();
  });

  it("R-012-34 work.assign がなければ、予定表・作業を足す・予実は出さず、自分の予定へ移る", async () => {
    const { ctx, page } = await open(STAFF_PERMS, { works: [work("w1", { title: "朝の清掃" })], assignments: mine("w1") }, staffMember);
    await page.goto(`${origin}/schedule/`);
    await page.getByText("朝の清掃").waitFor();
    expect(page.url()).toContain("/schedule/mine/");
    for (const name of ["予定表", "作業を足す", "予実"]) expect(await page.getByRole("link", { name, exact: true }).count(), name).toBe(0);
    await page.goto(`${origin}/schedule/new/`);
    await page.waitForURL(/\/schedule\/mine\//);
    await page.goto(`${origin}/schedule/review/`);
    await page.waitForURL(/\/schedule\/mine\//);
    await ctx.close();
  });
});

describe("作業の画面（社員）", () => {
  const base = () => ({
    works: [work("w1", { title: "午前の清掃", start_time: "09:00:00", end_time: "11:00:00", version: 3 })],
    assignments: [{ id: "a1", tenant_id: TENANT_A, work_id: "w1", membership_id: "m-staff", deleted_at: null }],
  });

  it("R-012-31 担当を付ける：時刻が重なる別の作業があれば警告して確かめ、了承すれば付ける", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, {
      ...base(),
      conflicts: [{ work_id: "w9", title: "別の作業", building_id: B1, scheduled_date: TODAY, start_time: "10:00:00", end_time: "12:00:00" }],
    });
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await page.goto(`${origin}/schedule/work/?id=w1`);
    await page.getByLabel("担当に付ける人").selectOption("m-staff2");
    await page.getByRole("button", { name: "担当に付ける" }).click();
    await page.getByText("担当に付けました").waitFor();
    expect(dialogs[0]).toContain("時刻が重なる別の作業があります");
    expect(dialogs[0]).toContain("別の作業");
    expect(fake.posts.find((p) => p.table === "work_assignments")!.body).toMatchObject({ work_id: "w1", membership_id: "m-staff2" });
    await ctx.close();
  });

  it("R-012-31 担当を付けるのを、警告で取りやめられる", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, {
      ...base(),
      conflicts: [{ work_id: "w9", title: "別の作業", building_id: B1, scheduled_date: TODAY, start_time: "10:00:00", end_time: "12:00:00" }],
    });
    page.on("dialog", (d) => void d.dismiss());
    await page.goto(`${origin}/schedule/work/?id=w1`);
    await page.getByLabel("担当に付ける人").selectOption("m-staff2");
    await page.getByRole("button", { name: "担当に付ける" }).click();
    await page.waitForTimeout(500);
    expect(fake.posts.filter((p) => p.table === "work_assignments").length).toBe(0);
    await ctx.close();
  });

  it("R-012-31 担当の入れ替え：swap_assignment に、外す人・付ける人を渡す。断られた理由は日本語で出る", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, { ...base(), refuse: { swap_assignment: "has_record" } });
    await page.goto(`${origin}/schedule/work/?id=w1`);
    await page.getByLabel("入れ替える人（今の担当）").selectOption("m-staff");
    await page.getByLabel("入れ替え先").selectOption("m-staff2");
    await page.getByRole("button", { name: "入れ替える" }).click();
    await page.getByText("すでに開始・終了を記録しているので、入れ替えられません").waitFor();
    expect(fake.rpcs.find((r) => r.name === "swap_assignment")!.body).toEqual({ p_work_id: "w1", p_from: "m-staff", p_to: "m-staff2" });
    await ctx.close();
  });

  it("R-012-31 日付・時刻の変更：版つきで reschedule_work を呼ぶ。入力が正しくなければ呼ばない", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, base());
    await page.goto(`${origin}/schedule/work/?id=w1`);
    await page.getByLabel("日付", { exact: true }).waitFor();
    await page.getByLabel("開始の時刻").fill("15:00");
    await page.getByLabel("終了の時刻").fill("14:00");
    await page.getByRole("button", { name: "日付と時刻を変える" }).click();
    await page.getByText("終了の時刻は、開始より後にしてください").waitFor();
    expect(fake.rpcs.filter((r) => r.name === "reschedule_work").length).toBe(0);
    await page.getByLabel("日付", { exact: true }).fill(day(5));
    await page.getByLabel("終了の時刻").fill("16:00");
    await page.getByRole("button", { name: "日付と時刻を変える" }).click();
    await page.getByText("日付と時刻を変えました").waitFor();
    expect(fake.rpcs.find((r) => r.name === "reschedule_work")!.body).toEqual({ p_work_id: "w1", p_version: 3, p_date: day(5), p_start: "15:00", p_end: "16:00" });
    await ctx.close();
  });

  it("R-012-31 版が食い違ったら「ほかの人が直しています」と出して、読み込み直す", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, { ...base(), refuse: { reschedule_work: "conflict" } });
    await page.goto(`${origin}/schedule/work/?id=w1`);
    await page.getByLabel("日付", { exact: true }).waitFor();
    await page.getByLabel("日付", { exact: true }).fill(day(2));
    await page.getByRole("button", { name: "日付と時刻を変える" }).click();
    await page.getByText("ほかの人が直しています").waitFor();
    await ctx.close();
  });

  it("R-012-31 取消は、確認のうえで cancel_work を呼ぶ（取りやめれば呼ばない）。行わずも同じ", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, base());
    let accept = false;
    page.on("dialog", (d) => void (accept ? d.accept() : d.dismiss()));
    await page.goto(`${origin}/schedule/work/?id=w1`);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForTimeout(300);
    expect(fake.rpcs.filter((r) => r.name === "cancel_work").length).toBe(0);
    accept = true;
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByText("取り消しました").waitFor();
    expect(fake.rpcs.find((r) => r.name === "cancel_work")!.body).toEqual({ p_work_id: "w1", p_version: 3 });
    await page.getByRole("button", { name: "行わず", exact: true }).click();
    await page.getByText("「行わず」にしました").waitFor();
    expect(fake.rpcs.find((r) => r.name === "skip_work")!.body).toEqual({ p_work_id: "w1", p_version: 3 });
    await ctx.close();
  });

  it("R-012-31 請求書に載っていて取り消せなければ、日本語の理由を出す", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, { ...base(), refuse: { cancel_work: "invoiced" } });
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/schedule/work/?id=w1`);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByText("請求書に載っている金額があるので、取り消せません").waitFor();
    await ctx.close();
  });
});

describe("作業を足す（社員）", () => {
  it("R-012-32 選んでいない・日付がない・終了が開始より前なら、RPC を呼ばずに理由を出す", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS);
    await page.goto(`${origin}/schedule/new/`);
    await page.getByLabel("契約の中身").waitFor();
    await page.getByRole("button", { name: "作業を足す", exact: true }).click();
    await page.getByText("契約の中身を選んでください").waitFor();
    await page.getByLabel("契約の中身").selectOption(SVC);
    await page.getByLabel("日付").fill("");
    await page.getByRole("button", { name: "作業を足す", exact: true }).click();
    await page.getByText("日付を入れてください").waitFor();
    await page.getByLabel("日付").fill(day(4));
    await page.getByLabel("開始の時刻").fill("10:00");
    await page.getByLabel("終了の時刻").fill("09:00");
    await page.getByRole("button", { name: "作業を足す", exact: true }).click();
    await page.getByText("終了の時刻は、開始より後にしてください").waitFor();
    expect(fake.rpcs.filter((r) => r.name === "create_work").length).toBe(0);
    await ctx.close();
  });

  it("R-012-32 契約の中身を選び、日付・時刻・担当を入れて作る：create_work を呼び、作業の画面へ移る", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, { works: [work("w-new", { title: "臨時" })] });
    await page.goto(`${origin}/schedule/new/`);
    await page.getByLabel("契約の中身").waitFor();
    await page.getByLabel("契約の中身").selectOption(SVC);
    await page.getByLabel("日付").fill(day(4));
    await page.getByLabel("開始の時刻").fill("09:00");
    await page.getByLabel("終了の時刻").fill("10:30");
    await page.getByLabel("担当：石田").check();
    await page.getByRole("button", { name: "作業を足す", exact: true }).click();
    await page.waitForURL(/\/schedule\/work\/\?id=/);
    const body = fake.rpcs.find((r) => r.name === "create_work")!.body;
    expect(body).toMatchObject({ p_date: day(4), p_start: "09:00", p_end: "10:30", p_contract_service_id: SVC, p_request_id: null, p_title: null, p_members: ["m-staff2"] });
    expect(typeof body.p_id).toBe("string");
    expect(page.url()).toContain(`id=${body.p_id}`);
    await ctx.close();
  });

  it("R-012-32 案件を選んで作ることもできる。断られた理由は日本語で出る", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, { refuse: { create_work: "request_closed" } });
    await page.goto(`${origin}/schedule/new/`);
    await page.getByLabel("元").selectOption("request");
    await page.getByLabel("案件").selectOption(REQ);
    await page.getByRole("button", { name: "作業を足す", exact: true }).click();
    await page.getByText("完了・取消の案件には、作業を足せません").waitFor();
    expect(fake.rpcs.find((r) => r.name === "create_work")!.body).toMatchObject({ p_request_id: REQ, p_contract_service_id: null });
    await ctx.close();
  });
});

describe("予実（社員）", () => {
  const row = (id: string, over: Row): Row => ({
    tenant_id: TENANT_A, work_id: id, building_id: B1, title: "清掃 " + id, scheduled_date: TODAY.slice(0, 8) + "05", start_time: null, end_time: null, status: "done",
    first_started_at: null, last_ended_at: null, open_records: null, actual_minutes: 0, start_gap_min: null, end_gap_min: null, report_id: null, report_status: "submitted",
    items_total: 0, items_skipped: 0, not_done: false, unfinished: false, report_missing: false, ...over,
  });
  const data = () => ({
    plan: [
      row("p1", { status: "scheduled", not_done: true, report_status: "none" }),
      row("p2", { start_gap_min: 45, end_gap_min: -5, start_time: "09:00:00", end_time: "11:00:00" }),
      row("p3", { items_total: 3, items_skipped: 2, report_status: "draft", report_missing: true }),
      row("p4", {}),
    ],
    monthly: [
      { tenant_id: TENANT_A, month: TODAY.slice(0, 8) + "01", building_id: B1, planned: 4, done: 3, skipped: 0, cancelled: 1, not_done: 1, report_missing: 1, planned_minutes: 120, actual_minutes: 150 },
      { tenant_id: TENANT_A, month: TODAY.slice(0, 8) + "01", building_id: B2, planned: 2, done: 2, skipped: 0, cancelled: 0, not_done: 0, report_missing: 0, planned_minutes: 60, actual_minutes: 30 },
    ],
  });

  it("R-012-33 種類ごとの件数が出て、種類で絞れ、ずれは 30 分以上。月ごとの集計に建物ごとと全体が出る", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, data());
    await page.goto(`${origin}/schedule/review/`);
    await page.getByLabel("月ごとの集計").waitFor();
    const sum = (await page.getByLabel("月ごとの集計").innerText()).replace(/\s+/g, " ");
    expect(sum).toContain("ひまわりマンション");
    expect(sum).toContain("さくらビル");
    const total = (await page.locator('tr[data-total="1"]').innerText()).replace(/\s+/g, " ");
    expect(total).toBe("全体 6 5 0 1 1 1 3時間 3時間");
    await page.getByRole("button", { name: "行っていない作業（1）" }).waitFor();
    await page.getByRole("button", { name: "時刻のずれ（1）" }).click();
    await page.getByText("開始が45分遅れ").waitFor();
    expect(await page.locator("[data-work]").count()).toBe(1);
    await page.getByRole("button", { name: "行わなかった項目（1）" }).click();
    await page.getByText("行わなかった項目：2 / 3").waitFor();
    await page.getByRole("button", { name: "出ていない報告書（1）" }).click();
    await page.locator('[data-work="p3"]').waitFor();
    await page.getByRole("button", { name: "すべて" }).click();
    expect(await page.locator("[data-work]").count()).toBe(3); // 印のある3件（p4 は印なし）
    await ctx.close();
  });
});
