// 毎日の定時のお知らせを作る Edge Function（機能 015、波 6）。1日1回の定時（朝）に呼ばれる。
// 呼べるのは service_role のキーを持つ呼び出しだけ。会社をまたぐ処理なので、判断は _shared/dailyNotify.ts。
//   POST {}                                          明日の作業・出ていない報告書・請求の入金の遅れの3つを、会社ごとに作る
//   POST {"tasks": ["work_tomorrow"], "days": 14}    処理を絞る・出ていない報告書の日数（0〜60）を変える
// 作るのは「送る前」のお知らせだけ（送るのは send-notifications）。期限の近い案件は request-due が別に作る。
// この PC には Deno がないため、ここは実行して確かめていない（判断は Vitest で確かめた。配備の前に supabase functions serve で確かめる）。
import { createClient } from "npm:@supabase/supabase-js@2";
import { DAILY_TASKS, REPORT_MISSING_DAYS, runDailyNotify, sanitizeError, type Counts, type DailyNotifyStore, type DailyTask } from "../_shared/dailyNotify.ts";

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

const NOTIFY_FN: Record<DailyTask, string> = {
  work_tomorrow: "work_tomorrow_notify",
  report_missing: "report_missing_notify",
  invoice_overdue: "invoice_overdue_notify",
};

function createStore(url: string, serviceRoleKey: string): DailyNotifyStore {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async tenants() {
      return must(await db.rpc("daily_notify_tenants"), "tenants") as unknown as string[];
    },
    async startRun(tenant, task) {
      return must(await db.rpc("daily_notify_start", { p_tenant: tenant, p_task: task }), "start_run") as unknown as string | null;
    },
    async notify(tenant, task, run, opts) {
      const args: Record<string, unknown> = { p_tenant: tenant, p_run: run };
      if (task === "report_missing") args.p_days = opts.days;
      return must(await db.rpc(NOTIFY_FN[task], args), "notify") as unknown as Counts;
    },
    async finishRun(tenant, run, task, status, counts, error) {
      must(await db.rpc("daily_notify_finish", { p_tenant: tenant, p_run: run, p_task: task, p_status: status, p_counts: counts, p_error: error }), "finish_run");
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
  let tasks: DailyTask[] = [...DAILY_TASKS];
  let reportDays = REPORT_MISSING_DAYS;
  try {
    const body = await req.json();
    if (Array.isArray(body?.tasks)) {
      const picked = DAILY_TASKS.filter((t) => body.tasks.includes(t));
      if (picked.length > 0) tasks = picked;
    }
    if (body && Number.isInteger(body.days) && body.days >= 0 && body.days <= 60) reportDays = body.days;
  } catch {
    // 本文がなければ既定
  }
  try {
    const summary = await runDailyNotify(createStore(env.SUPABASE_URL ?? "", key), { tasks, reportDays });
    return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: sanitizeError(e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
