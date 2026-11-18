// 画面から DB へ渡す層（API）。呼ぶ RPC の名前と引数、会社での絞り込み、断られたときの文言を確かめる。
import { describe, expect, it } from "vitest";
import { createApi, ApiError } from "./api";
import { fakeClient } from "../../tests/fakeClient";

const T = "tenant-1";

describe("API", () => {
  it("R-001-13 ログインはメールのリンク（パスワードなし）。登録済みの人だけ（新しく作らない）", async () => {
    const { client, calls } = fakeClient();
    await createApi(client).sendLoginLink("A@Example.com", "https://app.example/");
    expect(calls[0]).toMatchObject({
      kind: "auth",
      name: "signInWithOtp",
      args: { email: "a@example.com", options: { shouldCreateUser: false, emailRedirectTo: "https://app.example/" } },
    });
    expect(JSON.stringify(calls[0].args)).not.toMatch(/password/i);
  });

  it("R-001-17 自分の所属を、有効なものだけ、会社の名前と役割つきで取る", async () => {
    const { client, calls } = fakeClient({
      tables: {
        memberships: {
          data: [
            { id: "m1", tenant_id: "t1", office_id: null, tenants: { name: "A社" }, roles: { code: "admin" } },
            { id: "m2", tenant_id: "t2", office_id: "o", tenants: { name: "B社" }, roles: { code: "staff" } },
          ],
        },
      },
    });
    const list = await createApi(client).myMemberships("u1");
    expect(list).toEqual([
      { id: "m1", tenantId: "t1", tenantName: "A社", roleCode: "admin", officeId: null },
      { id: "m2", tenantId: "t2", tenantName: "B社", roleCode: "staff", officeId: "o" },
    ]);
    const chain = calls[0].chain!;
    expect(chain).toContainEqual(["eq", ["user_id", "u1"]]);
    expect(chain).toContainEqual(["eq", ["status", "active"]]);
  });

  it("R-001-17 利用者と招待の一覧は、選んだ会社の分だけを取る", async () => {
    const { client, calls } = fakeClient();
    const api = createApi(client);
    await api.listMembers(T);
    await api.listInvitations(T);
    for (const c of calls) expect(c.chain).toContainEqual(["eq", ["tenant_id", T]]);
  });

  it("R-001-7 招待は Edge Function を呼ぶ。メールアドレスは小文字にする。鍵は受け取らない", async () => {
    const { client, calls } = fakeClient({
      invoke: { "invite-user": { data: { invitation_id: "i1", expires_at: "2026-11-23T00:00:00Z" } } },
    });
    const r = await createApi(client).invite({ tenantId: T, email: " Staff@Example.com ", roleCode: "staff" });
    expect(calls[0]).toMatchObject({
      kind: "invoke",
      name: "invite-user",
      args: { body: { tenant_id: T, email: "staff@example.com", role_code: "staff", office_id: null } },
    });
    expect(r).toEqual({ invitationId: "i1", expiresAt: "2026-11-23T00:00:00Z" });
    expect(JSON.stringify(r)).not.toMatch(/token/);
  });

  it("R-001-12 管理者でない人の招待を Edge Function が断ったら、権限がないと出す", async () => {
    const err = { context: { json: async () => ({ code: "42501", error: "権限がない" }), status: 403 }, message: "x" };
    const { client } = fakeClient({ invoke: { "invite-user": { error: err } } });
    await expect(createApi(client).invite({ tenantId: T, email: "a@b.jp", roleCode: "staff" })).rejects.toThrow(
      "権限がありません",
    );
  });

  it("R-001-11 招待の取り消しは RPC を呼ぶ", async () => {
    const { client, calls } = fakeClient();
    await createApi(client).revokeInvitation("i1");
    expect(calls[0]).toMatchObject({ kind: "rpc", name: "revoke_invitation", args: { p_id: "i1" } });
  });

  it("R-001-8 招待の受け入れは、鍵と表示名で RPC を呼び、所属の ID を返す", async () => {
    const { client, calls } = fakeClient({ rpc: { accept_invitation: { data: "m-new" } } });
    const id = await createApi(client).acceptInvitation("tok", " 山田 ");
    expect(id).toBe("m-new");
    expect(calls[0]).toMatchObject({ args: { p_token: "tok", p_display_name: "山田" } });
  });

  it("R-001-9 使えない招待は、理由を区別しない文言で断る", async () => {
    const { client } = fakeClient({
      rpc: { accept_invitation: { error: { code: "P0001", message: "招待が使えない" } } },
    });
    const e = await createApi(client).acceptInvitation("bad", "山田").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toContain("この招待は使えません");
  });

  it("R-001-14 役割の変更・R-001-15 止める は RPC を呼ぶ", async () => {
    const { client, calls } = fakeClient();
    const api = createApi(client);
    await api.changeRole("m1", "member");
    await api.setStatus("m1", "suspended");
    expect(calls[0]).toMatchObject({ name: "change_member_role", args: { p_membership: "m1", p_role_code: "member" } });
    expect(calls[1]).toMatchObject({ name: "set_member_status", args: { p_membership: "m1", p_status: "suspended" } });
  });

  it("R-001-16 最後の管理者を止められなかったとき、その理由を出す", async () => {
    const { client } = fakeClient({ rpc: { set_member_status: { error: { code: "P0002", message: "x" } } } });
    await expect(createApi(client).setStatus("m1", "suspended")).rejects.toThrow("管理者が1人だけ");
  });

  it("R-001-5 会社の情報の更新は RPC を呼ぶ（空欄はそのまま渡し、DB が null にそろえる）", async () => {
    const { client, calls } = fakeClient();
    await createApi(client).updateTenant(T, { name: "A社", address: "", phone: "03", invoiceRegNo: "T1234567890123" });
    expect(calls[0]).toMatchObject({
      name: "update_tenant_info",
      args: { p_tenant: T, p_name: "A社", p_address: "", p_phone: "03", p_invoice_reg_no: "T1234567890123" },
    });
  });

  it("R-001-3 運営の閲覧を、期間つきで許し、R-001-4 取り消せる", async () => {
    const { client, calls } = fakeClient({ rpc: { grant_support_access: { data: "g1" } } });
    const api = createApi(client);
    await api.grantSupport(T, "問い合わせの調査", new Date("2026-11-20T00:00:00Z"));
    await api.revokeSupport("g1");
    expect(calls[0]).toMatchObject({
      name: "grant_support_access",
      args: { p_tenant: T, p_reason: "問い合わせの調査", p_ends_at: "2026-11-20T00:00:00.000Z" },
    });
    expect(calls[1]).toMatchObject({ name: "revoke_support_access", args: { p_id: "g1" } });
  });

  it("R-001-18 外部の人の建物は、ID の一覧にしてまとめて決める", async () => {
    const { client, calls } = fakeClient();
    await createApi(client).setBuildings("m9", ["b1", "b2"]);
    expect(calls[0]).toMatchObject({
      name: "set_external_building_access",
      args: { p_membership: "m9", p_building_ids: ["b1", "b2"] },
    });
  });
});
