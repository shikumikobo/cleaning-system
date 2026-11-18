// 画面から Supabase へ渡す層。RPC の名前と引数をここに集め、断られた理由を日本語にする。
// 会社のデータの絞り込みは、画面で選んだ会社の tenant_id を必ず付ける（R-001-17）。DB の RLS が最後の守り。
import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError } from "./errors";

export type RoleCode = "admin" | "member" | "staff" | "external";
export const ROLE_LABELS: Record<RoleCode, string> = {
  admin: "管理者",
  member: "社員",
  staff: "スタッフ",
  external: "外部の人",
};
export const ROLE_CODES = Object.keys(ROLE_LABELS) as RoleCode[];

export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

export interface MyMembership {
  id: string;
  tenantId: string;
  tenantName: string;
  roleCode: RoleCode;
  officeId: string | null;
}
export interface Member {
  id: string;
  userId: string;
  displayName: string | null;
  roleCode: RoleCode;
  status: "invited" | "active" | "suspended";
}
export interface Invitation {
  id: string;
  email: string;
  roleCode: RoleCode;
  expiresAt: string;
}
export interface TenantInfo {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  invoiceRegNo: string | null;
  status: string;
  trialEndsAt: string | null;
}
export interface SupportGrant {
  id: string;
  reason: string;
  startsAt: string;
  endsAt: string;
  revokedAt: string | null;
}

type Row = Record<string, unknown>;
const one = <T,>(v: unknown): T => (Array.isArray(v) ? v[0] : v) as T;

function fail(error: unknown): never {
  throw new ApiError(describeError(error), (error as { code?: string })?.code);
}

/** Edge Function が断ったとき、返ってきた本文（{error, code}）から理由を取る */
async function functionError(error: unknown): Promise<never> {
  const ctx = (error as { context?: { json?: () => Promise<{ error?: string; code?: string }> } })?.context;
  let parsed: { code?: string; message?: string } | null = null;
  if (ctx?.json) {
    try {
      const b = await ctx.json();
      parsed = { code: b.code, message: b.error };
    } catch {
      /* 本文が読めなければ、元のエラーで出す */
    }
  }
  return fail(parsed ?? error);
}

export function createApi(client: SupabaseClient) {
  async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(fn, args);
    if (error) fail(error);
    return data as T;
  }
  async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
    const { data, error } = await q;
    if (error) fail(error);
    return (data ?? []) as Row[];
  }

  return {
    /** メールのリンクを送る（パスワードなし。R-001-13）。登録済みの人だけ。招待の人は招待のメールで入る */
    async sendLoginLink(email: string, redirectTo: string): Promise<void> {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
      });
      if (error) fail(error);
    },
    async signOut(): Promise<void> {
      await client.auth.signOut();
    },

    async myMemberships(userId: string): Promise<MyMembership[]> {
      const data = await rows(
        client
          .from("memberships")
          .select("id, tenant_id, office_id, tenants(name), roles(code)")
          .eq("user_id", userId)
          .eq("status", "active")
          .is("deleted_at", null)
          .order("created_at"),
      );
      return data.map((r) => ({
        id: r.id as string,
        tenantId: r.tenant_id as string,
        tenantName: one<{ name: string }>(r.tenants)?.name ?? "",
        roleCode: one<{ code: RoleCode }>(r.roles).code,
        officeId: (r.office_id as string | null) ?? null,
      }));
    },

    /** 役割が持つ権限の code（画面の出し分け用。判定は DB が行う） */
    async permissionsOf(roleCode: RoleCode): Promise<string[]> {
      const data = await rows(client.from("role_permissions").select("permissions(code), roles!inner(code)").eq("roles.code", roleCode));
      return data.flatMap((r) => {
        const p = r.permissions as { code: string } | { code: string }[] | null;
        return Array.isArray(p) ? p.map((x) => x.code) : p ? [p.code] : [];
      });
    },

    async listMembers(tenantId: string): Promise<Member[]> {
      const data = await rows(
        client
          .from("memberships")
          .select("id, user_id, status, roles(code), profiles(display_name)")
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .order("created_at"),
      );
      return data.map((r) => ({
        id: r.id as string,
        userId: r.user_id as string,
        displayName: one<{ display_name: string }>(r.profiles)?.display_name ?? null,
        roleCode: one<{ code: RoleCode }>(r.roles).code,
        status: r.status as Member["status"],
      }));
    },

    async listInvitations(tenantId: string): Promise<Invitation[]> {
      const data = await rows(
        client
          .from("invitations")
          .select("id, email, expires_at, roles(code)")
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .is("accepted_at", null)
          .order("created_at"),
      );
      return data.map((r) => ({
        id: r.id as string,
        email: r.email as string,
        roleCode: one<{ code: RoleCode }>(r.roles).code,
        expiresAt: r.expires_at as string,
      }));
    },

    /** 招待する。DB への書き込みとメールは Edge Function が、操作した人の鍵で行う（R-001-7）。鍵は受け取らない */
    async invite(p: { tenantId: string; email: string; roleCode: RoleCode; officeId?: string | null }) {
      const { data, error } = await client.functions.invoke("invite-user", {
        body: {
          tenant_id: p.tenantId,
          email: p.email.trim().toLowerCase(),
          role_code: p.roleCode,
          office_id: p.officeId ?? null,
        },
      });
      if (error) await functionError(error);
      const d = data as { invitation_id: string; expires_at: string };
      return { invitationId: d.invitation_id, expiresAt: d.expires_at };
    },
    async revokeInvitation(id: string): Promise<void> {
      await rpc("revoke_invitation", { p_id: id });
    },
    async acceptInvitation(token: string, displayName: string): Promise<string> {
      return rpc<string>("accept_invitation", { p_token: token, p_display_name: displayName.trim() });
    },

    async changeRole(membershipId: string, roleCode: RoleCode): Promise<void> {
      await rpc("change_member_role", { p_membership: membershipId, p_role_code: roleCode });
    },
    async setStatus(membershipId: string, status: "active" | "suspended"): Promise<void> {
      await rpc("set_member_status", { p_membership: membershipId, p_status: status });
    },

    async getTenant(tenantId: string): Promise<TenantInfo | null> {
      const data = await rows(
        client.from("tenants").select("id, name, address, phone, invoice_reg_no, status, trial_ends_at").eq("id", tenantId),
      );
      const r = data[0];
      if (!r) return null;
      return {
        id: r.id as string,
        name: r.name as string,
        address: (r.address as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        invoiceRegNo: (r.invoice_reg_no as string | null) ?? null,
        status: r.status as string,
        trialEndsAt: (r.trial_ends_at as string | null) ?? null,
      };
    },
    async updateTenant(
      tenantId: string,
      v: { name: string; address: string; phone: string; invoiceRegNo: string },
    ): Promise<void> {
      await rpc("update_tenant_info", {
        p_tenant: tenantId,
        p_name: v.name,
        p_address: v.address,
        p_phone: v.phone,
        p_invoice_reg_no: v.invoiceRegNo,
      });
    },

    async listSupportGrants(tenantId: string): Promise<SupportGrant[]> {
      const data = await rows(
        client
          .from("support_access_grants")
          .select("id, reason, starts_at, ends_at, revoked_at")
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false }),
      );
      return data.map((r) => ({
        id: r.id as string,
        reason: r.reason as string,
        startsAt: r.starts_at as string,
        endsAt: r.ends_at as string,
        revokedAt: (r.revoked_at as string | null) ?? null,
      }));
    },
    async grantSupport(tenantId: string, reason: string, endsAt: Date): Promise<string> {
      return rpc<string>("grant_support_access", {
        p_tenant: tenantId,
        p_reason: reason,
        p_ends_at: endsAt.toISOString(),
      });
    },
    async revokeSupport(id: string): Promise<void> {
      await rpc("revoke_support_access", { p_id: id });
    },

    async getBuildings(tenantId: string, membershipId: string): Promise<string[]> {
      const data = await rows(
        client
          .from("external_building_access")
          .select("building_id")
          .eq("tenant_id", tenantId)
          .eq("membership_id", membershipId)
          .is("deleted_at", null),
      );
      return data.map((r) => r.building_id as string);
    },
    async setBuildings(membershipId: string, buildingIds: string[]): Promise<void> {
      await rpc("set_external_building_access", { p_membership: membershipId, p_building_ids: buildingIds });
    },
  };
}

export type Api = ReturnType<typeof createApi>;
