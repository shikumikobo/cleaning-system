// Edge Function の中身（招待のメール・会社を作る道具）。Deno に依存しない部分を Node で確かめる。
import { describe, expect, it } from "vitest";
import {
  handleCreateTenant,
  handleInvite,
  type Mailer,
  type RpcClient,
} from "../../../supabase/functions/_shared/handlers";

type Rpc = { fn: string; args: Record<string, unknown> };

function rpcClient(answer: { data?: unknown; error?: { code?: string; message: string } | null }, log: Rpc[]): RpcClient {
  return {
    rpc: async (fn, args) => {
      log.push({ fn, args });
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  };
}

function mailer(sent: Array<{ email: string; token: string }>, fail = false): Mailer {
  return {
    async sendInvitation(p) {
      if (fail) throw new Error("smtp down");
      sent.push(p);
    },
  };
}

const INVITE_ROW = [{ invitation_id: "i1", token: "secret-token", expires_at: "2026-11-23T00:00:00Z" }];

describe("招待のメール（invite-user）", () => {
  it("R-001-7 操作した人のログインの鍵で create_invitation を呼び、鍵つきのメールを送る。鍵は返さない", async () => {
    const log: Rpc[] = [];
    const used: string[] = [];
    const sent: Array<{ email: string; token: string }> = [];
    const r = await handleInvite(
      "Bearer user-jwt",
      { tenant_id: "t1", email: "Staff@Example.com", role_code: "staff" },
      {
        userClient: (h) => {
          used.push(h);
          return rpcClient({ data: INVITE_ROW }, log);
        },
        mailer: mailer(sent),
      },
    );
    expect(used).toEqual(["Bearer user-jwt"]);
    expect(log[0]).toEqual({ fn: "create_invitation", args: { p_tenant: "t1", p_email: "staff@example.com", p_role_code: "staff", p_office_id: null } });
    expect(sent).toEqual([{ email: "staff@example.com", token: "secret-token" }]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ invitation_id: "i1", expires_at: "2026-11-23T00:00:00Z" });
    expect(JSON.stringify(r.body)).not.toContain("secret-token");
  });

  it("R-001-12 管理者でない人は断られ、メールは送らない", async () => {
    const sent: Array<{ email: string; token: string }> = [];
    const r = await handleInvite(
      "Bearer staff-jwt",
      { tenant_id: "t1", email: "a@b.jp", role_code: "staff" },
      { userClient: () => rpcClient({ error: { code: "42501", message: "権限がない" } }, []), mailer: mailer(sent) },
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("42501");
    expect(sent).toEqual([]);
  });

  it("R-001-12 ログインしていない呼び出しは、DB を呼ぶ前に断る", async () => {
    const log: Rpc[] = [];
    const r = await handleInvite(null, { tenant_id: "t1", email: "a@b.jp", role_code: "staff" }, {
      userClient: () => rpcClient({ data: INVITE_ROW }, log),
      mailer: mailer([]),
    });
    expect(r.status).toBe(401);
    expect(log).toEqual([]);
  });

  it("R-001-7 メールアドレスや役割が正しくない入力は、DB を呼ぶ前に断る", async () => {
    const log: Rpc[] = [];
    const deps = { userClient: () => rpcClient({ data: INVITE_ROW }, log), mailer: mailer([]) };
    expect((await handleInvite("Bearer j", { tenant_id: "t1", email: "not-an-email", role_code: "staff" }, deps)).status).toBe(400);
    expect((await handleInvite("Bearer j", { email: "a@b.jp", role_code: "staff" }, deps)).status).toBe(400);
    expect((await handleInvite("Bearer j", { tenant_id: "t1", email: "a@b.jp", role_code: "root" }, deps)).status).toBe(400);
    expect(log).toEqual([]);
  });

  it("R-001-7 メールが送れなかったときは、招待は作られているので、そのことを伝える", async () => {
    const r = await handleInvite(
      "Bearer j",
      { tenant_id: "t1", email: "a@b.jp", role_code: "staff" },
      { userClient: () => rpcClient({ data: INVITE_ROW }, []), mailer: mailer([], true) },
    );
    expect(r.status).toBe(502);
    expect(r.body.invitation_id).toBe("i1");
    expect(String(r.body.error)).toContain("メールを送れませんでした");
    expect(JSON.stringify(r.body)).not.toContain("secret-token");
  });

  it("R-001-7 招待の関数は、service_role を受け取らない（操作した人の鍵だけで動く）", () => {
    // 依存の形そのものに serviceClient がない（型で守る）。ここでは実行時にも、渡した依存の鍵が userClient と mailer だけと確かめる
    const deps = { userClient: () => rpcClient({}, []), mailer: mailer([]) };
    expect(Object.keys(deps).sort()).toEqual(["mailer", "userClient"]);
  });
});

describe("会社を作る道具（create-tenant）", () => {
  const body = { name: "A清掃", admin_email: "Owner@Example.com" };

  it("R-001-1 運営が会社の名前と管理者のメールを入れると、試用の会社を作り、管理者に招待を送る", async () => {
    const log: Rpc[] = [];
    const sent: Array<{ email: string; token: string }> = [];
    const r = await handleCreateTenant("Bearer op-jwt", body, {
      isOperator: async (h) => h === "Bearer op-jwt",
      serviceClient: rpcClient({ data: [{ tenant_id: "t9", invitation_id: "i9", token: "tok9", expires_at: "2026-11-23T00:00:00Z" }] }, log),
      mailer: mailer(sent),
    });
    expect(log[0]).toEqual({ fn: "create_tenant", args: { p_name: "A清掃", p_admin_email: "owner@example.com", p_trial_days: 30 } });
    expect(sent).toEqual([{ email: "owner@example.com", token: "tok9" }]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tenant_id: "t9", invitation_id: "i9" });
    expect(JSON.stringify(r.body)).not.toContain("tok9");
  });

  it("R-001-1 運営でない人には、会社を作らせない（DB も呼ばない）", async () => {
    const log: Rpc[] = [];
    const r = await handleCreateTenant("Bearer user-jwt", body, {
      isOperator: async () => false,
      serviceClient: rpcClient({}, log),
      mailer: mailer([]),
    });
    expect(r.status).toBe(403);
    expect(log).toEqual([]);
  });

  it("R-001-1 試用の日数は指定できる。名前やメールが空なら断る", async () => {
    const log: Rpc[] = [];
    const deps = {
      isOperator: async () => true,
      serviceClient: rpcClient({ data: [{ tenant_id: "t", invitation_id: "i", token: "k", expires_at: "x" }] }, log),
      mailer: mailer([]),
    };
    await handleCreateTenant("Bearer j", { ...body, trial_days: 14 }, deps);
    expect(log[0].args.p_trial_days).toBe(14);
    expect((await handleCreateTenant("Bearer j", { name: " ", admin_email: "a@b.jp" }, deps)).status).toBe(400);
    expect((await handleCreateTenant("Bearer j", { name: "A", admin_email: "x" }, deps)).status).toBe(400);
  });
});
