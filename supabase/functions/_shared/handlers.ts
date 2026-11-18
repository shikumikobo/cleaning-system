// Edge Function の中身。Deno に依存しないので、Node のテスト（Vitest）でも動かせる。
// 招待のメール：操作した人のログインの鍵で create_invitation を呼ぶ（service_role は使わない）。
// 会社を作る道具：運営だけ。create_tenant は service_role だけが呼べる（DB 側の決まり）。

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
}

export interface Mailer {
  /** 招待のメールを送る。リンクの鍵は、メールの中にだけ入れる */
  sendInvitation(p: { email: string; token: string }): Promise<void>;
}

export interface FnResponse {
  status: number;
  body: Record<string, unknown>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ["admin", "member", "staff", "external"];

function statusFor(code?: string): number {
  switch (code) {
    case "42501":
      return 403;
    case "28000":
      return 401;
    case "22023":
    case "23514":
      return 400;
    case "23505":
      return 409;
    default:
      return 500;
  }
}

const bad = (error: string): FnResponse => ({ status: 400, body: { error } });

export interface InviteDeps {
  userClient(authHeader: string): RpcClient;
  mailer: Mailer;
}

export async function handleInvite(authHeader: string | null, input: unknown, deps: InviteDeps): Promise<FnResponse> {
  if (!authHeader) return { status: 401, body: { error: "ログインが必要です", code: "28000" } };
  const b = (input ?? {}) as Record<string, unknown>;
  const tenant = typeof b.tenant_id === "string" ? b.tenant_id : "";
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const role = typeof b.role_code === "string" ? b.role_code : "";
  const office = typeof b.office_id === "string" ? b.office_id : null;
  if (!tenant) return bad("会社が決まっていません");
  if (!EMAIL.test(email)) return bad("メールアドレスの形が正しくありません");
  if (!ROLES.includes(role)) return bad("役割が正しくありません");

  const { data, error } = await deps
    .userClient(authHeader)
    .rpc("create_invitation", { p_tenant: tenant, p_email: email, p_role_code: role, p_office_id: office });
  if (error) return { status: statusFor(error.code), body: { error: error.message, code: error.code ?? null } };
  const row = (Array.isArray(data) ? data[0] : data) as { invitation_id: string; token: string; expires_at: string } | null;
  if (!row) return { status: 500, body: { error: "招待を作れませんでした" } };

  try {
    await deps.mailer.sendInvitation({ email, token: row.token });
  } catch {
    // 招待は作られている。管理者は一覧から取り消して、もう一度招待できる
    return {
      status: 502,
      body: { error: "招待は作りましたが、メールを送れませんでした。招待を取り消して、もう一度試してください", invitation_id: row.invitation_id },
    };
  }
  return { status: 200, body: { invitation_id: row.invitation_id, expires_at: row.expires_at } };
}

export interface CreateTenantDeps {
  /** 呼んだ人が運営か（JWT の app_metadata.operator。サーバー側で検証する） */
  isOperator(authHeader: string): Promise<boolean>;
  serviceClient: RpcClient;
  mailer: Mailer;
}

export async function handleCreateTenant(authHeader: string | null, input: unknown, deps: CreateTenantDeps): Promise<FnResponse> {
  if (!authHeader) return { status: 401, body: { error: "ログインが必要です", code: "28000" } };
  if (!(await deps.isOperator(authHeader))) {
    return { status: 403, body: { error: "運営だけが会社を作れます", code: "42501" } };
  }
  const b = (input ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const email = typeof b.admin_email === "string" ? b.admin_email.trim().toLowerCase() : "";
  const days = typeof b.trial_days === "number" && Number.isInteger(b.trial_days) && b.trial_days > 0 ? b.trial_days : 30;
  if (!name) return bad("会社の名前が要ります");
  if (!EMAIL.test(email)) return bad("管理者のメールアドレスの形が正しくありません");

  const { data, error } = await deps.serviceClient.rpc("create_tenant", { p_name: name, p_admin_email: email, p_trial_days: days });
  if (error) return { status: statusFor(error.code), body: { error: error.message, code: error.code ?? null } };
  const row = (Array.isArray(data) ? data[0] : data) as { tenant_id: string; invitation_id: string; token: string; expires_at: string } | null;
  if (!row) return { status: 500, body: { error: "会社を作れませんでした" } };

  try {
    await deps.mailer.sendInvitation({ email, token: row.token });
  } catch {
    return {
      status: 502,
      body: { error: "会社は作りましたが、招待のメールを送れませんでした", tenant_id: row.tenant_id, invitation_id: row.invitation_id },
    };
  }
  return { status: 200, body: { tenant_id: row.tenant_id, invitation_id: row.invitation_id, expires_at: row.expires_at } };
}
