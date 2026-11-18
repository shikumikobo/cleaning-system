// 期限の近い案件のお知らせを作る Edge Function（機能 003）。1日1回の定時（朝）に呼ばれる。
// 呼べるのは service_role のキーを持つ呼び出しだけ。会社をまたぐ処理なので、判断は _shared/requestDue.ts。
//   POST {"days": 3}   期限まで何日以内を「近い」とするか（省くと 3）
// 作るのは「送る前」のお知らせだけ（送るのは 015 の send-notifications）。
// この PC には Deno がないため、ここは実行して確かめていない（判断は Vitest で確かめた。配備の前に supabase functions serve で確かめる）。
import { createClient } from "npm:@supabase/supabase-js@2";
import { DEFAULT_DAYS, runRequestDue, sanitizeError, type RequestDueStore } from "../_shared/requestDue.ts";

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

function createStore(url: string, serviceRoleKey: string): RequestDueStore {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async tenants() {
      return must(await db.rpc("request_due_tenants"), "tenants") as unknown as string[];
    },
    async startRun(tenant) {
      return must(await db.rpc("request_due_start", { p_tenant: tenant }), "start_run") as unknown as string | null;
    },
    async notify(tenant, run, days) {
      return must(await db.rpc("request_due_notify", { p_tenant: tenant, p_run: run, p_days: days }), "notify") as unknown as {
        requests: number;
        notified: number;
      };
    },
    async finishRun(tenant, run, status, counts, error) {
      must(await db.rpc("request_due_finish", { p_tenant: tenant, p_run: run, p_status: status, p_counts: counts, p_error: error }), "finish_run");
    },
  };
}

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (req.method !== "POST" || !key || !sameSecret(given, key)) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  let days = DEFAULT_DAYS;
  try {
    const body = await req.json();
    if (body && Number.isInteger(body.days) && body.days >= 0 && body.days <= 30) days = body.days;
  } catch {
    // 本文がなければ既定の日数
  }
  try {
    const summary = await runRequestDue(createStore(env.SUPABASE_URL ?? "", key), days);
    return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: sanitizeError(e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
