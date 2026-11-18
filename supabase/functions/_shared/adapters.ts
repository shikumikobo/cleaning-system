// Deno にだけ依存する外への口（DB・環境変数・Web Push）。判断は notifications.ts に置く。
// この PC には Deno がないため、ここは実行して確かめていない（型と形だけ。配備の前に supabase functions serve で確かめる）。
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import {
  createMailSender,
  createPushSender,
  type Deps,
  type MailSender,
  type NotificationStore,
  type OutboxRow,
  type Subscription,
} from "./notifications.ts";

/** メールの送り手の登録簿。契約したサービスの口を、ここに1つ足す（MAIL_PROVIDER の名前をキーにする） */
export const mailProviders: Record<string, (env: Record<string, string | undefined>) => MailSender> = {};

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

export function createStore(url: string, serviceRoleKey: string): NotificationStore {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async tenantsPending() {
      return must(await db.rpc("notification_tenants_pending"), "tenants_pending") as unknown as string[];
    },
    async allTenants() {
      const rows = must(await db.from("tenants").select("id").is("deleted_at", null), "tenants") as { id: string }[];
      return rows.map((r) => r.id);
    },
    async startRun(tenant, kind) {
      return must(await db.rpc("notification_start_run", { p_tenant: tenant, p_kind: kind }), "start_run") as unknown as string | null;
    },
    async finishRun(tenant, run, status, counts, error) {
      must(await db.rpc("notification_finish_run", { p_tenant: tenant, p_run: run, p_status: status, p_counts: counts, p_error: error }), "finish_run");
    },
    async outbox(tenant, limit) {
      return must(await db.rpc("notification_outbox", { p_tenant: tenant, p_limit: limit }), "outbox") as unknown as OutboxRow[];
    },
    async subscriptions(tenant, membership) {
      return must(
        await db.from("push_subscriptions").select("id, endpoint, p256dh, auth")
          .eq("tenant_id", tenant).eq("membership_id", membership).is("deleted_at", null),
        "subscriptions",
      ) as Subscription[];
    },
    async mark(tenant, id, status, error) {
      must(await db.rpc("notification_mark", { p_tenant: tenant, p_id: id, p_status: status, p_error: error }), "mark");
    },
    async dropSubscription(tenant, id) {
      must(await db.rpc("notification_drop_subscription", { p_tenant: tenant, p_id: id }), "drop_subscription");
    },
    async purge(tenant) {
      return must(await db.rpc("notification_purge", { p_tenant: tenant }), "purge") as unknown as number;
    },
    async emailOf(userId) {
      const { data, error } = await db.auth.admin.getUserById(userId);
      if (error) throw new Error(`get_user: ${error.message}`);
      return data.user?.email ?? null;
    },
  };
}

/** 環境変数から、送る処理の部品をそろえる。鍵がなければ「使えない送り手」になる（理由は固定の文字） */
export function createDeps(env: Record<string, string | undefined>): Deps {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("supabase_env_missing");
  return {
    store: createStore(url, key),
    push: createPushSender(env, webpush),
    mail: createMailSender(env, mailProviders),
    appBaseUrl: env.APP_BASE_URL,
  };
}
