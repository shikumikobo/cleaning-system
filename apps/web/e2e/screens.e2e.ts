// 画面の流れ（Node 版 Playwright + Edge）。接続先（Supabase）は偽物に差し替える。書き出した画面（out/）を相手にする。
import type { Server } from "node:http";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TENANT_A,
  TENANT_B,
  launch,
  newPage,
  newState,
  serveOut,
  tenant,
  type FakeMember,
} from "./harness";

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

const admin = (over: Partial<FakeMember> = {}): FakeMember => ({
  id: "m-admin", tenant_id: TENANT_A, user_id: "u-me", status: "active", role: "admin", display_name: "管理 太郎", ...over,
});
const staff: FakeMember = { id: "m-staff", tenant_id: TENANT_A, user_id: "u-staff", status: "active", role: "staff", display_name: "現場 花子" };
const external: FakeMember = { id: "m-ext", tenant_id: TENANT_A, user_id: "u-ext", status: "active", role: "external", display_name: "外部 次郎" };

describe("ログイン", () => {
  it("R-001-13 メールアドレスだけを入れてリンクを受け取る。パスワード欄がなく、新しい利用者は作らない", async () => {
    const st = newState();
    const { ctx, page } = await newPage(browser, st, { signedIn: false });
    await page.goto(`${origin}/login/`);
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    await page.getByLabel("メールアドレス").fill("Owner@Example.com");
    await page.getByRole("button", { name: "ログインのリンクを送る" }).click();
    await page.getByText("メールを送りました").waitFor();
    const otp = st.log.find((l) => l.kind === "otp")!.body as Record<string, unknown>;
    expect(otp.email).toBe("owner@example.com");
    expect(otp.create_user).toBe(false);
    expect(JSON.stringify(otp)).not.toMatch(/password/i);
    await ctx.close();
  });

  it("R-001-23 ログインしていない人が会社の画面を開くと、ログインに移る", async () => {
    const { ctx, page } = await newPage(browser, newState(), { signedIn: false });
    await page.goto(`${origin}/settings/users/`);
    await page.waitForURL("**/login/");
    await ctx.close();
  });
});

describe("招待を受ける", () => {
  it("R-001-8 リンクを開いて表示名を入れると、招待の役割で会社に所属し、鍵は URL から消える", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, validToken: "good-token" });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/invite/?token=good-token`);
    await page.getByLabel("表示名").fill("山田 太郎");
    await page.getByRole("button", { name: "所属する" }).click();
    await page.getByRole("heading", { name: "A清掃" }).waitFor();
    const call = st.log.find((l) => l.name === "accept_invitation")!.body as Record<string, unknown>;
    expect(call).toEqual({ p_token: "good-token", p_display_name: "山田 太郎" });
    expect(page.url()).not.toContain("good-token");
    await ctx.close();
  });

  it("R-001-9 使えない招待は、理由を区別しない文言で断り、所属しない", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, validToken: "good-token" });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/invite/?token=expired-token`);
    await page.getByLabel("表示名").fill("山田 太郎");
    await page.getByRole("button", { name: "所属する" }).click();
    await page.getByRole("alert").filter({ hasText: "この招待は使えません" }).waitFor();
    expect(st.members).toHaveLength(0);
    await ctx.close();
  });
});

describe("利用者の管理", () => {
  const base = () => newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin(), staff] });

  it("R-001-7 メールアドレスと役割を入れて招待すると、招待中に出る。R-001-11 取り消すと消える", async () => {
    const st = base();
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/settings/users/`);
    await page.getByLabel("招待するメールアドレス").fill("new@example.com");
    await page.locator("form select").selectOption("member");
    await page.getByRole("button", { name: "招待する" }).click();
    await page.getByText("招待のメールを送りました").waitFor();
    const fn = st.log.find((l) => l.kind === "fn")!;
    expect(fn.name).toBe("invite-user");
    expect(fn.body).toMatchObject({ tenant_id: TENANT_A, email: "new@example.com", role_code: "member" });
    const list = page.getByRole("list", { name: "招待中の一覧" });
    await list.getByText("new@example.com").waitFor();
    await list.getByRole("button", { name: "取り消し" }).click();
    await page.getByText("の招待を取り消しました").waitFor();
    expect(await page.getByRole("list", { name: "招待中の一覧" }).count()).toBe(0);
    expect(st.invitations).toHaveLength(0);
    await ctx.close();
  });

  it("R-001-14 役割を変えると RPC が呼ばれ、R-001-15 止めると「止めています」と出る。戻せる", async () => {
    const st = base();
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/settings/users/`);
    await page.getByLabel("現場 花子 の役割").selectOption("member");
    await page.getByText("役割を 社員 にしました").waitFor();
    expect(st.members.find((m) => m.id === "m-staff")!.role).toBe("member");
    await page.getByRole("button", { name: "現場 花子 を止める" }).click();
    await page.getByText("止めています").waitFor();
    expect(st.members.find((m) => m.id === "m-staff")!.status).toBe("suspended");
    await page.getByRole("button", { name: "現場 花子 を戻す" }).click();
    await page.getByText("現場 花子 を戻しました").waitFor();
    await ctx.close();
  });

  it("R-001-16 有効な管理者が1人だけのとき、その人を止められない（理由が出る）", async () => {
    const st = base();
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/settings/users/`);
    await page.getByRole("button", { name: "管理 太郎 を止める" }).click();
    await page.getByRole("alert").filter({ hasText: "管理者が1人だけ" }).waitFor();
    expect(st.members.find((m) => m.id === "m-admin")!.status).toBe("active");
    await ctx.close();
  });

  it("R-001-18 外部の人が見られる建物を、ID の一覧で決める。形が正しくない ID は断る", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin(), external] });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/settings/users/`);
    await page.getByRole("button", { name: "外部 次郎 の建物を決める" }).click();
    await page.getByRole("textbox", { name: /見られる建物/ }).fill("not-an-id");
    await page.getByRole("button", { name: "建物を保存" }).click();
    await page.getByRole("alert").filter({ hasText: "形が正しくありません" }).waitFor();
    const b1 = "00000000-0000-4000-8000-0000000000b1";
    await page.getByRole("textbox", { name: /見られる建物/ }).fill(b1);
    await page.getByRole("button", { name: "建物を保存" }).click();
    await page.getByText("見られる建物を決めました").waitFor();
    expect(st.buildings).toEqual([{ membership_id: "m-ext", building_id: b1 }]);
    await ctx.close();
  });

  it("R-001-12 管理者でない人には、利用者の管理の画面を見せず、一覧も取りに行かない", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin({ role: "member" })] });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/settings/users/`);
    await page.getByRole("alert").filter({ hasText: "管理者だけ" }).waitFor();
    expect(await page.getByRole("button", { name: "招待する" }).count()).toBe(0);
    expect(st.log.some((l) => l.name === "invitations")).toBe(false);
    await ctx.close();
  });
});

describe("会社の情報と運営の閲覧", () => {
  const base = () => newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin()] });

  it("R-001-5 管理者が会社の情報を直して保存できる", async () => {
    const st = base();
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/settings/tenant/`);
    await expect.poll(() => page.getByLabel("会社の名前").inputValue()).toBe("A清掃");
    await page.getByLabel("会社の名前").fill("A清掃サービス");
    await page.getByLabel("電話").fill("06-1111-2222");
    await page.getByRole("button", { name: "保存" }).click();
    await page.getByText("会社の情報を保存しました").waitFor();
    expect(st.tenants[TENANT_A]).toMatchObject({ name: "A清掃サービス", phone: "06-1111-2222" });
    await ctx.close();
  });

  it("R-001-6 管理者でない人には、会社の情報の編集の画面を見せない", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin({ role: "staff" })] });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/settings/tenant/`);
    await page.getByRole("alert").filter({ hasText: "管理者だけ" }).waitFor();
    expect(await page.getByLabel("会社の名前").count()).toBe(0);
    await ctx.close();
  });

  it("R-001-3 運営の閲覧を期限つきで許し、R-001-4 取り消すと「取り消し済み」になる", async () => {
    const st = base();
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/settings/tenant/`);
    await page.getByLabel("理由").fill("請求書の表示の調査");
    const until = new Date(Date.now() + 3 * 864e5);
    const local = new Date(until.getTime() - until.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await page.getByLabel("許す期限").fill(local);
    await page.getByRole("button", { name: "許す", exact: true }).click();
    const grants = page.getByRole("list", { name: "許可の一覧" });
    await grants.getByText("許可中").waitFor();
    expect(st.log.find((l) => l.name === "grant_support_access")!.body).toMatchObject({ p_tenant: TENANT_A, p_reason: "請求書の表示の調査" });
    await grants.getByRole("button", { name: "取り消す" }).click();
    await grants.getByText("取り消し済み").waitFor();
    expect(st.grants[0].revoked_at).not.toBeNull();
    await ctx.close();
  });
});

describe("会社の切り替え", () => {
  it("R-001-17 2つの会社に入っている人は、ヘッダーで会社を切り替え、選んだ会社の分だけを見る", async () => {
    const st = newState({
      tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃"), [TENANT_B]: tenant(TENANT_B, "B美装") },
      members: [admin(), admin({ id: "m-admin-b", tenant_id: TENANT_B, display_name: "管理 太郎" }), { ...staff, tenant_id: TENANT_B, id: "m-staff-b", display_name: "B社の人" }],
    });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/`);
    await page.getByRole("heading", { name: "A清掃" }).waitFor();
    await page.getByLabel("会社を切り替える").selectOption({ label: "B美装" });
    await page.getByRole("heading", { name: "B美装" }).waitFor();
    await page.getByRole("link", { name: "利用者", exact: true }).click();
    await page.getByText("B社の人").waitFor();
    expect(await page.getByText("現場 花子").count()).toBe(0);
    const memberCalls = st.log.filter((l) => l.name === "memberships" && l.url?.includes("tenant_id="));
    expect(memberCalls.length).toBeGreaterThan(0);
    for (const c of memberCalls) expect(c.url).toContain(`tenant_id=eq.${TENANT_B}`);
    // 選んだ会社は、開き直しても残る
    await page.reload();
    await expect.poll(() => page.getByLabel("会社を切り替える").inputValue()).toBe("m-admin-b");
    await ctx.close();
  });
});

describe("画面の外枠と、今の会社", () => {
  it("R-015-16 ヘッダーの鈴に未読の件数が出て、押すとお知らせの一覧へ移る", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin()], unread: 3 });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/`);
    const bell = page.getByRole("banner").getByRole("link", { name: "お知らせ（未読 3 件）" });
    await bell.waitFor();
    await bell.click();
    await page.waitForURL("**/notifications/");
    await ctx.close();
  });

  it("入口のメニューに、波 0〜2 の機能のリンクが全部あり、重複も壊れもない（管理者は設定のリンクも）", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin()] });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/`);
    await page.getByRole("heading", { name: "A清掃" }).waitFor();
    const links = await page.locator("main a, section a").evaluateAll((as) => as.map((a) => [a.textContent?.trim(), a.getAttribute("href")]));
    const expected = [
      ["取引先", "/clients/"], ["建物", "/buildings/"], ["案件", "/requests/"], ["見積", "/quotes/"], ["ファイル", "/files/"],
      ["小口現金・レシート", "/cash/"], ["お知らせ", "/notifications/"], ["お知らせの受け取り", "/settings/notifications/"],
      ["利用者の管理（招待・役割・止める）", "/settings/users/"], ["会社の情報と、運営の閲覧の許可", "/settings/tenant/"],
    ];
    for (const e of expected) expect(links, `リンク ${e[0]}`).toContainEqual(e);
    const hrefs = links.map((l) => l[1]).filter((h) => expected.some((e) => e[1] === h));
    expect(new Set(hrefs).size).toBe(hrefs.length); // 重複なし
    expect(await page.locator("section > ul").count()).toBe(2); // 一覧が崩れず、通常と管理者の2つ
    await ctx.close();
  });

  it("R-001-17 取引先の画面も、ヘッダーで選んだ会社の分だけを読む（会社の選び方は1つ）", async () => {
    const st = newState({
      tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃"), [TENANT_B]: tenant(TENANT_B, "B美装") },
      members: [admin(), admin({ id: "m-admin-b", tenant_id: TENANT_B })],
      clients: [
        { id: "c-a", tenant_id: TENANT_A, kind: "owner", name: "A社の取引先" },
        { id: "c-b", tenant_id: TENANT_B, kind: "owner", name: "B社の取引先" },
      ],
    });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/clients/`);
    await page.getByText("A社の取引先").waitFor();
    expect(await page.getByText("B社の取引先").count()).toBe(0);
    await page.getByLabel("会社を切り替える").selectOption({ label: "B美装" });
    await page.getByText("B社の取引先").waitFor();
    expect(await page.getByText("A社の取引先").count()).toBe(0);
    await ctx.close();
  });
});

describe("送り直し", () => {
  it("R-001-32 送れていない記録の件数が出て、電波が戻ると自動で送られ、件数が消える。R-001-30 送るとき端末の ID を使う", async () => {
    const st = newState({ tenants: { [TENANT_A]: tenant(TENANT_A, "A清掃") }, members: [admin()], photosOnline: false });
    const { ctx, page } = await newPage(browser, st);
    await page.goto(`${origin}/`);
    await page.getByRole("heading", { name: "A清掃" }).waitFor();
    // 電波のない間に端末でためた記録（送り箱は IndexedDB）
    await page.evaluate(
      (tenantId) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("cleaning-outbox", 1);
          req.onsuccess = () => {
            const tx = req.result.transaction("items", "readwrite");
            tx.objectStore("items").add({
              id: "11111111-1111-4111-8111-111111111111", kind: "insert", target: "photos", tenantId, membershipId: "m-admin",
              payload: { note: "窓" }, clientCreatedAt: new Date().toISOString(), seq: Date.now() * 1000, attempts: 0,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        }),
      TENANT_A,
    );
    await page.reload();
    await page.getByRole("status").filter({ hasText: "送れていない記録：1 件" }).waitFor();
    st.photosOnline = true;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => page.getByRole("status").filter({ hasText: "送れていない記録" }).count()).toBe(0);
    expect(st.photosReceived).toHaveLength(1);
    expect(st.photosReceived[0]).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", tenant_id: TENANT_A });
    await ctx.close();
  });
});
