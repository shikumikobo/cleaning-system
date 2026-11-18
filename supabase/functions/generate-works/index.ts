// 予定を作る Edge Function（機能 010）。清掃の契約の繰り返し（RRULE）から、今日から 2 か月先までの作業を作る。
// 使い方は2つ。
//   1. 定時（毎朝）：POST {}（Authorization: Bearer <service_role のキー>）。会社ごとに分けて回し、job_runs に残す
//   2. 画面から「いま作り直す」：POST {"contract_id": "<契約の id>"}（Authorization: Bearer <操作した人のログインの鍵>）。
//      人の鍵で `contract_schedule_tenant` を呼び、権限（contract.edit）と契約の会社を確かめてから、その契約だけを作り直す
// 判断は _shared/schedule.ts。この PC には Deno がないため、ここは実行して確かめていない
// （判断は Vitest で、DB の関数は PGlite で確かめた。配備の前に supabase functions serve で確かめる）。
import { createClient } from "npm:@supabase/supabase-js@2";
import { runSchedule, sanitizeError, type ScheduleStore, type ServiceRow } from "../_shared/schedule.ts";

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

function createStore(url: string, serviceRoleKey: string): ScheduleStore {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async tenants() {
      return must(await db.rpc("schedule_tenants"), "tenants") as unknown as string[];
    },
    async startRun(tenant) {
      return must(await db.rpc("schedule_start", { p_tenant: tenant }), "start_run") as unknown as string | null;
    },
    async services(tenant, from, to, contract) {
      return must(await db.rpc("schedule_services", { p_tenant: tenant, p_from: from, p_to: to, p_contract: contract }), "services") as unknown as ServiceRow[];
    },
    async insert(tenant, run, works) {
      return must(await db.rpc("schedule_insert", { p_tenant: tenant, p_run: run, p_works: works }), "insert") as unknown as {
        created: number;
        skipped: number;
        assignments: number;
        charges: number;
      };
    },
    async finishRun(tenant, run, status, counts, error) {
      must(await db.rpc("schedule_finish", { p_tenant: tenant, p_run: run, p_status: status, p_counts: counts, p_error: error }), "finish_run");
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const url = env.SUPABASE_URL ?? "";
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (req.method !== "POST" || !given || !serviceKey) return json({ error: "forbidden" }, 403);

  let body: { contract_id?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // 本文がなければ空
  }

  try {
    if (sameSecret(given, serviceKey)) {
      // 定時：全部の会社
      return json(await runSchedule(createStore(url, serviceKey)));
    }
    // 画面から：操作した人の鍵で、契約の会社と権限を確かめる（権限がなければ 42501 で止まる）
    const contractId = typeof body.contract_id === "string" ? body.contract_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(contractId)) return json({ error: "forbidden" }, 403);
    const anonKey = env.SUPABASE_ANON_KEY ?? "";
    const asUser = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${given}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const checked = await asUser.rpc("contract_schedule_tenant", { p_contract: contractId });
    if (checked.error || !checked.data) return json({ error: "forbidden" }, 403);
    return json(await runSchedule(createStore(url, serviceKey), { tenant: checked.data as string, contract: contractId }));
  } catch (e) {
    return json({ error: sanitizeError(e) }, 500);
  }
});
