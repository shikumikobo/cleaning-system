// お知らせの画面の流れ（015）：許可 → 登録 → 設定の切り替え → 一覧 → 既読 → 鈴。
// 共通の偽の接続先（harness.ts）の上に、お知らせまわりの表と RPC だけを自分で受ける（共通のファイルは変えない）。
// 通知の許可・端末の登録（Push API）は、ブラウザの口を偽物に差し替えて確かめる（実機の通知は、鍵と送り手が決まってから）。
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

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,HEAD,OPTIONS", "access-control-expose-headers": "*" };
const manager: FakeMember = { id: "m-admin", tenant_id: TENANT_A, user_id: "u-me", status: "active", role: "admin", display_name: "管理 太郎" };
const staffMember: FakeMember = { id: "m-staff", tenant_id: TENANT_A, user_id: "u-me", status: "active", role: "staff", display_name: "青木" };
const MANAGER_PERMS = ["work.assign", "field.record", "amount.read"];
const STAFF_PERMS = ["field.record"];

type Row = Record<string, unknown>;
const KINDS: Row[] = [
  { code: "work_changed", name: "予定の変更", default_push: true, default_email: false, required_perm: null, sort: 10 },
  { code: "work_tomorrow", name: "明日の作業", default_push: true, default_email: false, required_perm: null, sort: 20 },
  { code: "request_due", name: "期限の近い案件", default_push: true, default_email: false, required_perm: null, sort: 30 },
  { code: "report_missing", name: "出ていない報告書", default_push: true, default_email: false, required_perm: null, sort: 40 },
  { code: "quote_approved", name: "見積の承認", default_push: true, default_email: true, required_perm: "amount.read", sort: 50 },
  { code: "invoice_overdue", name: "請求の入金の遅れ", default_push: true, default_email: true, required_perm: "amount.read", sort: 60 },
];
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const note = (id: string, title: string, over: Row = {}): Row => ({
  id, kind: "work_tomorrow", title, body: `${title}の本文`, link: null, created_at: ago(10), read_at: null, membership_id: "m-admin", channel: "app", ...over,
});

interface Fake {
  notifications: Row[];
  settings: Row[];
  /** 端末の登録（register_push_subscription に届いた中身） */
  registered: Array<Record<string, unknown>>;
  /** 取り外した端末の送り先 */
  removed: string[];
  /** 設定の保存（upsert）の本文 */
  saved: Array<Record<string, unknown>>;
  /** 既読にする通信（PATCH）の本文と、絞り込みの文字列 */
  patches: Array<{ body: Record<string, unknown>; url: string }>;
}

async function install(ctx: BrowserContext, perms: string[], over: Partial<Fake> = {}): Promise<Fake> {
  const f: Fake = { notifications: [], settings: [], registered: [], removed: [], saved: [], patches: [], ...over };
  const json = (route: Route, o: unknown, extra: Record<string, string> = {}) =>
    route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json", ...extra }, body: JSON.stringify(o) });
  const query = (req: Request, rows: Row[]) => {
    const url = new URL(req.url());
    let out = rows;
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(k)) continue;
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k]) === v.slice(3));
      else if (v === "is.null") out = out.filter((r) => r[k] === null || r[k] === undefined);
      else if (v.startsWith("in.(")) {
        const set = v.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
        out = out.filter((r) => set.includes(String(r[k])));
      }
    }
    return out;
  };
  const rest = (name: string, handler: (route: Route, req: Request) => void) =>
    ctx.route((u) => u.origin === SUPABASE && u.pathname === `/rest/v1/${name}`, (route, req) => {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      handler(route, req);
    });

  void rest("role_permissions", (route) => json(route, perms.map((code) => ({ permissions: { code }, roles: { code: "x" } }))));
  void rest("notification_kinds", (route) => json(route, KINDS));
  void rest("notification_settings", (route, req) => {
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}") as Row;
      f.saved.push(body);
      f.settings = f.settings.filter((s) => !(s.kind === body.kind && s.channel === body.channel));
      f.settings.push({ kind: body.kind, channel: body.channel, enabled: body.enabled, membership_id: body.membership_id, deleted_at: null });
      return route.fulfill({ status: 201, headers: CORS, body: "" });
    }
    return json(route, query(req, f.settings));
  });
  void rest("notifications", (route, req) => {
    if (req.method() === "PATCH") {
      const body = JSON.parse(req.postData() ?? "{}") as Row;
      f.patches.push({ body, url: req.url() });
      for (const r of query(req, f.notifications)) if (r.read_at == null) r.read_at = body.read_at;
      return route.fulfill({ status: 204, headers: CORS });
    }
    const rows = query(req, f.notifications).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (req.method() === "HEAD") {
      return route.fulfill({ status: 200, headers: { ...CORS, "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" } });
    }
    return json(route, rows, { "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" });
  });
  void rest("push_subscriptions", (route, req) => {
    if (req.method() === "PATCH") {
      const url = new URL(req.url());
      f.removed.push(url.searchParams.get("endpoint")?.replace(/^eq\./, "") ?? "");
      return route.fulfill({ status: 204, headers: CORS });
    }
    return json(route, []);
  });
  await ctx.route((u) => u.origin === SUPABASE && u.pathname === "/rest/v1/rpc/register_push_subscription", (route, req) => {
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    f.registered.push(JSON.parse(req.postData() ?? "{}"));
    return json(route, "sub-1");
  });
  return f;
}

async function open(perms: string[], member: FakeMember, over: Partial<Fake> = {}) {
  const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [member] });
  const { ctx, page } = await newPage(browser, st);
  const fake = await install(ctx, perms, over);
  return { ctx, page, fake };
}

/** 通知の許可・端末の登録（Push API）を偽物にする。permission は許可を求める前の値、answer は求めたときの答え */
async function fakePush(page: Page, opts: { permission: "default" | "denied" | "granted"; answer: "granted" | "denied" }) {
  await page.addInitScript((o) => {
    const state = { sub: null as null | { endpoint: string; toJSON(): unknown; unsubscribe(): Promise<boolean> } };
    const N = { permission: o.permission as string, requestPermission: async () => ((N.permission = o.answer), o.answer) };
    Object.defineProperty(window, "Notification", { value: N, configurable: true });
    Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
    const reg = {
      pushManager: {
        getSubscription: async () => state.sub,
        subscribe: async () => {
          state.sub = {
            endpoint: "https://push.example.test/e2e-device",
            toJSON: () => ({ endpoint: "https://push.example.test/e2e-device", keys: { p256dh: "e2e-p256dh", auth: "e2e-auth" } }),
            unsubscribe: async () => ((state.sub = null), true),
          };
          return state.sub;
        },
      },
    };
    Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve(reg), register: async () => reg }, configurable: true });
  }, opts);
}

describe("通知の設定の画面", () => {
  it("R-015-41 波6の6種類が、種類ごと・手段ごとに出る。初めの値は、通知は入、メールは見積の承認と入金の遅れだけ入", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, manager);
    await page.goto(`${origin}/settings/notifications/`);
    await page.getByLabel("予定の変更の通知").waitFor();
    for (const name of ["予定の変更", "明日の作業", "期限の近い案件", "出ていない報告書", "見積の承認", "請求の入金の遅れ"]) {
      expect(await page.getByLabel(`${name}の通知`).isChecked(), `${name}の通知`).toBe(true);
    }
    expect(await page.getByLabel("予定の変更のメール").isChecked()).toBe(false);
    expect(await page.getByLabel("明日の作業のメール").isChecked()).toBe(false);
    expect(await page.getByLabel("見積の承認のメール").isChecked()).toBe(true);
    expect(await page.getByLabel("請求の入金の遅れのメール").isChecked()).toBe(true);
    await ctx.close();
  });

  it("R-015-27・41 自分の権限で受け取れない種類（金額を見る権限が要るもの）は、スタッフには出ない", async () => {
    const { ctx, page } = await open(STAFF_PERMS, staffMember);
    await page.goto(`${origin}/settings/notifications/`);
    await page.getByLabel("明日の作業の通知").waitFor();
    expect(await page.getByLabel("予定の変更の通知").count()).toBe(1);
    expect(await page.getByLabel("出ていない報告書の通知").count()).toBe(1);
    expect(await page.getByLabel("見積の承認の通知").count()).toBe(0);
    expect(await page.getByLabel("請求の入金の遅れのメール").count()).toBe(0);
    await ctx.close();
  });

  it("R-015-3・41 切り替えると、本人の設定として保存され、開き直しても残る。選んでいない種類は初めの値のまま", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, manager);
    await page.goto(`${origin}/settings/notifications/`);
    await page.getByLabel("明日の作業のメール").waitFor();
    await page.getByLabel("明日の作業のメール").check();
    await page.getByLabel("予定の変更の通知").uncheck();
    await expect.poll(() => fake.saved.length).toBe(2);
    expect(fake.saved[0]).toMatchObject({ tenant_id: TENANT_A, membership_id: "m-admin", kind: "work_tomorrow", channel: "email", enabled: true });
    expect(fake.saved[1]).toMatchObject({ kind: "work_changed", channel: "push", enabled: false });
    await page.reload();
    await page.getByLabel("明日の作業のメール").waitFor();
    expect(await page.getByLabel("明日の作業のメール").isChecked()).toBe(true);
    expect(await page.getByLabel("予定の変更の通知").isChecked()).toBe(false);
    expect(await page.getByLabel("明日の作業の通知").isChecked()).toBe(true); // 選んでいない
    await ctx.close();
  });

  it("R-015-26 許可されたら、端末を登録し、「切る」に変わる。切ると登録を外す", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, manager);
    await fakePush(page, { permission: "default", answer: "granted" });
    await page.goto(`${origin}/settings/notifications/`);
    await page.getByText("この端末の通知は、まだ入っていません。").waitFor();
    await page.getByRole("button", { name: "通知を入れる" }).click();
    await page.getByText("この端末の通知は入っています。").waitFor();
    expect(fake.registered).toHaveLength(1);
    expect(fake.registered[0]).toMatchObject({ p_tenant: TENANT_A, p_endpoint: "https://push.example.test/e2e-device", p_p256dh: "e2e-p256dh", p_auth: "e2e-auth" });
    await page.getByRole("button", { name: "この端末の通知を切る" }).click();
    await page.getByText("この端末の通知は、まだ入っていません。").waitFor();
    expect(fake.removed).toEqual(["https://push.example.test/e2e-device"]);
    await ctx.close();
  });

  it("R-015-26 許可されなかったときは、理由を出して、登録しない", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, manager);
    await fakePush(page, { permission: "default", answer: "denied" });
    await page.goto(`${origin}/settings/notifications/`);
    await page.getByRole("button", { name: "通知を入れる" }).click();
    await page.getByRole("alert").filter({ hasText: "ブロックされています" }).waitFor();
    expect(fake.registered).toHaveLength(0);
    await ctx.close();
  });

  it("R-015-26 通知に対応していない端末では、その理由を出す（登録の操作は出さない）", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, manager);
    await page.addInitScript(() => {
      // 通知の口がない端末（Push API がない）にする
      delete (window as unknown as Record<string, unknown>).PushManager;
      delete (window as unknown as Record<string, unknown>).Notification;
    });
    await page.goto(`${origin}/settings/notifications/`);
    await page.getByText("通知に対応していません").waitFor();
    expect(await page.getByRole("button", { name: "通知を入れる" }).count()).toBe(0);
    expect(fake.registered).toHaveLength(0);
    await ctx.close();
  });
});

describe("お知らせの一覧と鈴", () => {
  const items = () => [
    note("n1", "明日の作業：2件", { created_at: ago(5), link: "/schedule/mine/" }),
    note("n2", "予定が変わりました：定期清掃", { kind: "work_changed", created_at: ago(30) }),
    note("n3", "入金が遅れています：I-0001", { kind: "invoice_overdue", created_at: ago(90), read_at: ago(60) }),
    note("nx", "ほかの人のお知らせ", { membership_id: "m-other", created_at: ago(1) }),
  ];

  it("R-015-16・42 新しい順に、本人の分だけ出る。未読の印と件数。鈴にも未読の件数が出る", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, manager, { notifications: items() });
    await page.goto(`${origin}/notifications/`);
    await page.getByText("明日の作業：2件", { exact: true }).waitFor();
    const text = (await page.locator("ul.notification-list").innerText()).replace(/\s+/g, " ");
    expect(text.indexOf("明日の作業：2件")).toBeLessThan(text.indexOf("予定が変わりました"));
    expect(text.indexOf("予定が変わりました")).toBeLessThan(text.indexOf("入金が遅れています"));
    expect(text).not.toContain("ほかの人のお知らせ");
    await page.getByText("未読 2 件").waitFor();
    expect(await page.locator("li.notification.unread").count()).toBe(2);
    expect(await page.locator("li.notification.read").count()).toBe(1);
    await page.getByRole("link", { name: "お知らせ（未読 2 件）" }).waitFor();
    await ctx.close();
  });

  it("R-015-16・42 「既読にする」で既読の時刻を保存し、未読が減り、鈴の件数もすぐ減る", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, manager, { notifications: items() });
    await page.goto(`${origin}/notifications/`);
    await page.getByText("未読 2 件").waitFor();
    await page.locator("li.notification.unread").first().getByRole("button", { name: "既読にする" }).click();
    await page.getByText("未読 1 件").waitFor();
    await page.getByRole("link", { name: "お知らせ（未読 1 件）" }).waitFor();
    expect(fake.patches).toHaveLength(1);
    expect(Object.keys(fake.patches[0].body)).toEqual(["read_at"]); // 既読の時刻だけを送る（R-015-17）
    expect(fake.patches[0].url).toContain("id=in.");
    await ctx.close();
  });

  it("R-015-42 「すべて既読にする」で、未読が0になり、ボタンは消え、鈴の件数もなくなる", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, manager, { notifications: items() });
    await page.goto(`${origin}/notifications/`);
    await page.getByText("未読 2 件").waitFor();
    await page.getByRole("button", { name: "すべて既読にする" }).click();
    await page.getByText("未読 0 件").waitFor();
    expect(await page.getByRole("button", { name: "すべて既読にする" }).count()).toBe(0);
    await page.getByRole("link", { name: "お知らせ", exact: true }).waitFor();
    expect(await page.locator("li.notification.unread").count()).toBe(0);
    expect(fake.patches).toHaveLength(1);
    expect(fake.patches[0].url).toContain("membership_id=eq.m-admin"); // 自分の分だけ
    await ctx.close();
  });

  it("R-015-42 リンクを開くと、既読を送り終えてから、リンクの先（アプリの中）へ移る", async () => {
    const { ctx, page, fake } = await open(MANAGER_PERMS, manager, { notifications: items() });
    await page.goto(`${origin}/notifications/`);
    await page.getByText("明日の作業：2件", { exact: true }).waitFor();
    await page.locator("li.notification", { hasText: "明日の作業：2件" }).getByRole("link", { name: "開く" }).click();
    await page.waitForURL("**/schedule/mine/");
    expect(fake.patches).toHaveLength(1);
    expect(fake.notifications.find((n) => n.id === "n1")!.read_at).not.toBeNull();
    await ctx.close();
  });

  it("R-015-16 お知らせがないときは、そう出る", async () => {
    const { ctx, page } = await open(MANAGER_PERMS, manager, { notifications: [] });
    await page.goto(`${origin}/notifications/`);
    await page.getByText("お知らせはまだありません。").waitFor();
    await ctx.close();
  });
});
