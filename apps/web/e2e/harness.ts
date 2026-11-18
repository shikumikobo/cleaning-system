// 画面のテスト（Playwright）の道具：書き出した画面（out/）を配る小さなサーバーと、Supabase の代わりの偽の接続先。
// 本物の Supabase は Docker が要るので、ここでは通信（auth・rest・rpc・functions）を差し替える。
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";

export const SUPABASE = "http://127.0.0.1:54321";
const OUT = join(process.cwd(), "out");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

export function serveOut(): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const p = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^([/\\])+/, "");
      let file = join(OUT, p);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file)) file = join(OUT, "404.html");
      const body = readFileSync(file);
      res.writeHead(existsSync(join(OUT, p)) || p === "" ? 200 : 404, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

export async function launch(): Promise<Browser> {
  // この PC は署名済みの Edge を使う（Smart App Control のため）。CI（Linux）は Playwright の Chromium
  return chromium.launch(process.env.CI ? { headless: true } : { channel: "msedge", headless: true });
}

// ---- 偽の接続先の中身 ----
export interface FakeMember {
  id: string;
  tenant_id: string;
  user_id: string;
  status: "active" | "suspended";
  role: "admin" | "member" | "staff" | "external";
  display_name: string | null;
}
export interface FakeInvitation {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  expires_at: string;
}
export interface FakeState {
  me: { id: string; email: string };
  tenants: Record<string, { id: string; name: string; address: string | null; phone: string | null; invoice_reg_no: string | null; status: string; trial_ends_at: string | null }>;
  members: FakeMember[];
  invitations: FakeInvitation[];
  grants: Array<{ id: string; tenant_id: string; reason: string; starts_at: string; ends_at: string; revoked_at: string | null }>;
  buildings: Array<{ membership_id: string; building_id: string }>;
  validToken: string | null;
  /** 取引先（002）。tenant_id で絞って返す */
  clients: Array<{ id: string; tenant_id: string; kind: string; name: string }>;
  /** 未読のお知らせの件数（015） */
  unread: number;
  /** 受けた通信の記録 */
  log: Array<{ kind: "otp" | "rpc" | "fn" | "rest"; name: string; body?: unknown; url?: string }>;
  /** 送り箱の記録を送る表への答え：false なら通信できない */
  photosOnline: boolean;
  photosReceived: unknown[];
}

export function newState(over: Partial<FakeState> = {}): FakeState {
  return {
    me: { id: "u-me", email: "me@example.com" },
    tenants: {},
    members: [],
    invitations: [],
    grants: [],
    buildings: [],
    validToken: null,
    clients: [],
    unread: 0,
    log: [],
    photosOnline: true,
    photosReceived: [],
    ...over,
  };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "*",
};
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });

function eq(url: URL, key: string): string | null {
  const v = url.searchParams.get(key);
  return v?.startsWith("eq.") ? v.slice(3) : null;
}

export async function installBackend(ctx: BrowserContext, st: FakeState): Promise<void> {
  await ctx.route(`${SUPABASE}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined;

    if (path === "/auth/v1/otp") {
      st.log.push({ kind: "otp", name: "otp", body });
      return json(route, 200, {});
    }
    if (path === "/auth/v1/logout") return route.fulfill({ status: 204, headers: CORS });

    if (path.startsWith("/functions/v1/")) {
      const name = path.split("/").pop()!;
      st.log.push({ kind: "fn", name, body });
      const caller = st.members.find((m) => m.user_id === st.me.id && m.tenant_id === body.tenant_id && m.status === "active");
      if (caller?.role !== "admin") return json(route, 403, { error: "権限がない", code: "42501" });
      const inv = { id: uid(), tenant_id: body.tenant_id, email: body.email, role: body.role_code, expires_at: new Date(Date.now() + 7 * 864e5).toISOString() };
      st.invitations.push(inv);
      return json(route, 200, { invitation_id: inv.id, expires_at: inv.expires_at });
    }

    if (path.startsWith("/rest/v1/rpc/")) {
      const name = path.split("/").pop()!;
      st.log.push({ kind: "rpc", name, body });
      return rpc(route, st, name, body);
    }

    if (path.startsWith("/rest/v1/")) {
      const table = path.split("/").pop()!;
      st.log.push({ kind: "rest", name: table, url: req.url(), body });
      if (table === "photos") {
        if (!st.photosOnline) return route.abort("failed");
        st.photosReceived.push(body);
        return route.fulfill({ status: 201, headers: CORS, body: "" });
      }
      return rest(route, st, table, url);
    }
    return json(route, 404, { error: "unknown" });
  });
}

function rpc(route: Route, st: FakeState, name: string, b: Record<string, unknown>) {
  const adminCount = (t: string) => st.members.filter((m) => m.tenant_id === t && m.status === "active" && m.role === "admin").length;
  const member = st.members.find((m) => m.id === (b.p_membership as string));
  switch (name) {
    case "accept_invitation": {
      if (!st.validToken || b.p_token !== st.validToken) return json(route, 400, { code: "P0001", message: "招待が使えない" });
      const m: FakeMember = { id: uid(), tenant_id: Object.keys(st.tenants)[0], user_id: st.me.id, status: "active", role: "staff", display_name: String(b.p_display_name) };
      st.members.push(m);
      st.validToken = null;
      return json(route, 200, m.id);
    }
    case "revoke_invitation":
      st.invitations = st.invitations.filter((i) => i.id !== b.p_id);
      return json(route, 200, null);
    case "change_member_role":
      if (member!.role === "admin" && b.p_role_code !== "admin" && adminCount(member!.tenant_id) <= 1)
        return json(route, 400, { code: "P0002", message: "x" });
      member!.role = b.p_role_code as FakeMember["role"];
      return json(route, 200, null);
    case "set_member_status":
      if (b.p_status === "suspended" && member!.role === "admin" && adminCount(member!.tenant_id) <= 1)
        return json(route, 400, { code: "P0002", message: "x" });
      member!.status = b.p_status as FakeMember["status"];
      return json(route, 200, null);
    case "update_tenant_info": {
      const t = st.tenants[b.p_tenant as string];
      Object.assign(t, { name: b.p_name, address: b.p_address || null, phone: b.p_phone || null, invoice_reg_no: b.p_invoice_reg_no || null });
      return json(route, 200, null);
    }
    case "grant_support_access": {
      const g = { id: uid(), tenant_id: b.p_tenant as string, reason: b.p_reason as string, starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: b.p_ends_at as string, revoked_at: null as string | null };
      st.grants.push(g);
      return json(route, 200, g.id);
    }
    case "revoke_support_access":
      st.grants.find((g) => g.id === b.p_id)!.revoked_at = new Date().toISOString();
      return json(route, 200, null);
    case "set_external_building_access":
      st.buildings = st.buildings.filter((x) => x.membership_id !== b.p_membership);
      for (const id of b.p_building_ids as string[]) st.buildings.push({ membership_id: b.p_membership as string, building_id: id });
      return json(route, 200, null);
  }
  return json(route, 404, { message: "no rpc" });
}

function rest(route: Route, st: FakeState, table: string, url: URL) {
  const role = (r: string) => ({ code: r });
  switch (table) {
    case "memberships": {
      const user = eq(url, "user_id");
      const tenant = eq(url, "tenant_id");
      const rows = st.members
        .filter((m) => (user ? m.user_id === user && m.status === "active" : true) && (tenant ? m.tenant_id === tenant : true))
        .map((m) => ({
          id: m.id,
          tenant_id: m.tenant_id,
          user_id: m.user_id,
          status: m.status,
          office_id: null,
          roles: role(m.role),
          tenants: { name: st.tenants[m.tenant_id]?.name },
          profiles: m.display_name ? { display_name: m.display_name } : null,
        }));
      return json(route, 200, rows);
    }
    case "invitations": {
      const t = eq(url, "tenant_id");
      return json(route, 200, st.invitations.filter((i) => i.tenant_id === t).map((i) => ({ id: i.id, email: i.email, expires_at: i.expires_at, roles: role(i.role) })));
    }
    case "role_permissions":
      return json(route, 200, []);
    case "notifications":
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json", "content-range": `0-0/${st.unread}` }, body: "[]" });
    case "clients":
      return json(route, 200, st.clients.filter((c) => c.tenant_id === eq(url, "tenant_id")));
    case "tenants":
      return json(route, 200, [st.tenants[eq(url, "id") ?? ""]].filter(Boolean));
    case "support_access_grants":
      return json(route, 200, st.grants.filter((g) => g.tenant_id === eq(url, "tenant_id")));
    case "external_building_access":
      return json(route, 200, st.buildings.filter((x) => x.membership_id === eq(url, "membership_id")));
  }
  return json(route, 404, { message: "no table" });
}

function fakeJwt(payload: object): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b(payload)}.sig`;
}

/** ログイン済みの状態にする（メールのリンクで入ったあとの状態） */
export async function signIn(ctx: BrowserContext, st: FakeState): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
  const user = { id: st.me.id, aud: "authenticated", role: "authenticated", email: st.me.email, app_metadata: {}, user_metadata: {}, created_at: "2026-11-16T00:00:00Z" };
  const session = { access_token: fakeJwt({ sub: st.me.id, email: st.me.email, exp }), refresh_token: "r", token_type: "bearer", expires_in: 86400, expires_at: exp, user };
  await ctx.addInitScript((s) => {
    try {
      localStorage.setItem("sb-127-auth-token", JSON.stringify(s));
    } catch {
      /* 無視 */
    }
  }, session);
}

export async function newPage(browser: Browser, st: FakeState, opts: { signedIn?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ locale: "ja-JP" });
  await installBackend(ctx, st);
  if (opts.signedIn !== false) await signIn(ctx, st);
  const page = await ctx.newPage();
  return { ctx, page };
}

export const TENANT_A = "00000000-0000-4000-8000-00000000a001";
export const TENANT_B = "00000000-0000-4000-8000-00000000b001";
export const tenant = (id: string, name: string) => ({ id, name, address: "東京都1-1", phone: "03-0000-0000", invoice_reg_no: "T1234567890123", status: "trial", trial_ends_at: null });
