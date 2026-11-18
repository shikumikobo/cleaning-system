// 予定の作成（機能 010）の流れを、PGlite に流したマイグレーションと、Edge Function の判断のコード
// （supabase/functions/_shared/schedule.ts。Node が型を外して読む）で通し、結果の事実を JSON で標準出力に出す。
// 確かめ（期待値との比べ）は apps/web/tests/schedule-db.test.ts が行う。
// 使い方：node --liftoff-only tools/pglite/schedule-scenario.mjs
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const { runSchedule } = await import(pathToFileURL(join(root, "supabase", "functions", "_shared", "schedule.ts")).href);

const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
await db.exec(readFileSync(join(here, "supabase_base.sql"), "utf8"));
await db.exec("set search_path to public, extensions");
await db.exec(readFileSync(join(here, "pgtap_shim.sql"), "utf8"));
const migDir = join(root, "supabase", "migrations");
for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(join(migDir, f), "utf8"));
const testDir = join(root, "supabase", "tests");
for (const f of readdirSync(testDir).filter((x) => x.startsWith("0000") && x.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(testDir, f), "utf8").replace(/create extension if not exists pgtap[^;]*;/i, ""));
}
await db.exec("select tests.seed()");

// ---- 判断のコードが使う DB への口（service_role の関数を呼ぶ）----
const one = async (sql, params) => (await db.query(sql, params)).rows[0].r;
const store = {
  tenants: async () => (await db.query("select public.schedule_tenants() as t")).rows.map((x) => x.t),
  startRun: (t) => one("select public.schedule_start($1) as r", [t]),
  services: (t, from, to, contract) => one("select public.schedule_services($1, $2, $3, $4) as r", [t, from, to, contract]),
  insert: (t, run, works) => one("select public.schedule_insert($1, $2, $3::jsonb) as r", [t, run, JSON.stringify(works)]),
  finishRun: async (t, run, status, counts, error) => {
    await db.query("select public.schedule_finish($1, $2, $3, $4::jsonb, $5)", [t, run, status, JSON.stringify(counts), error]);
  },
};
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const val = async (sql, params = []) => Object.values((await rows(sql, params))[0] ?? {})[0] ?? null;
const addDays = (s, n) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const callAs = async (user, fn, args) => {
  const j = (await db.query(`select tests.run_as(tests.u($1), format('select public.%I(%s) as r', $2::text, $3::text)) as j`, [user, fn, args])).rows[0].j;
  if (j.error) throw new Error(`${fn}: ${j.error} ${j.message}`);
  return j.rows[0].r;
};

const f = {};
f.today = await val("select (now() at time zone 'Asia/Tokyo')::date::text");
f.horizon = await val("select ((now() at time zone 'Asia/Tokyo')::date + interval '2 months')::date::text");
const today = f.today;
const dates = (key) => rows(`select scheduled_date::text as d from public.works where service_key = tests.id($1) and run_id is not null and deleted_at is null order by 1`, [key]).then((r) => r.map((x) => x.d));

// 1回目
f.first = await runSchedule(store, { today });
f.base = await dates("key:A10-base");
f.a1 = await dates("key:A1-base");
f.opt = await dates("key:A10-opt");
f.crossTenant = Number(await val(`select count(*) from public.works w join public.contract_services s on s.id = w.contract_service_id where w.tenant_id <> s.tenant_id`));
f.bInA = Number(await val(`select count(*) from public.works where run_id is not null and tenant_id = tests.t('A') and service_key = tests.id('key:B10-base')`));
f.runs = (await rows(`select tenant_id::text t, status, counts->>'created' as c from public.job_runs where kind = 'schedule_works' order by started_at, t`)).map((r) => ({ status: r.status, created: Number(r.c) }));
f.runIds = Number(await val(`select count(distinct run_id) from public.works where run_id is not null`));
const asg = (await rows(`select count(distinct w.id)::int as n, count(a.id)::int as a from public.works w join public.work_assignments a on a.work_id = w.id and a.deleted_at is null where w.service_key = tests.id('key:A10-base') and w.run_id is not null`))[0];
f.assignA10 = asg;
f.assignB10 = Number(await val(`select count(distinct w.id) from public.works w join public.work_assignments a on a.work_id = w.id where w.service_key = tests.id('key:B10-base') and w.run_id is not null and a.membership_id = tests.id('m:B:staffB')`));
f.optCharges = (await rows(`select c.amount::text as a from public.works w join public.work_charges c on c.work_id = w.id where w.service_key = tests.id('key:A10-opt') and w.run_id is not null`)).map((r) => r.a);
f.baseCharges = Number(await val(`select count(*) from public.works w join public.work_charges c on c.work_id = w.id where w.service_key = tests.id('key:A10-base') and w.run_id is not null`));

// 2回目（二度動いても重ならない）
f.worksBefore = Number(await val("select count(*) from public.works"));
f.second = await runSchedule(store, { today });
f.worksAfter = Number(await val("select count(*) from public.works"));
f.successRuns = Number(await val("select count(*) from public.job_runs where kind = 'schedule_works' and status = 'success'"));

// 中身を変える → 取り消し → 作り直し
f.eff = addDays(today, 14);
const sid = await val(`select id::text from public.contract_services where service_key = tests.id('key:A10-base') and valid_to is null`);
f.change = await callAs("memberA", "change_contract_service", `'${sid}', '${f.eff}', '{"recurrence":"FREQ=WEEKLY;BYDAY=WE","amount":33000}'`);
f.liveAfterChange = Number(await val(`select count(*) from public.works where service_key = tests.id('key:A10-base') and run_id is not null and deleted_at is null and scheduled_date >= $1`, [f.eff]));
f.third = await runSchedule(store, { today });
f.afterRebuild = await dates("key:A10-base");
f.assignRebuilt = (await rows(`select count(distinct w.id)::int as n, count(a.id)::int as a from public.works w join public.work_assignments a on a.work_id = w.id and a.deleted_at is null where w.service_key = tests.id('key:A10-base') and w.run_id is not null and w.deleted_at is null and w.scheduled_date >= $1`, [f.eff]))[0];
f.serviceRows = (await rows(`select amount::text as a, valid_from::text as f, coalesce(valid_to::text, '') as t from public.contract_services where service_key = tests.id('key:A10-base') order by valid_from`));

// 契約を終える → 終了日より後は作られない
f.end = addDays(today, 20);
const cid = await val("select tests.id('cA10')::text");
f.endResult = await callAs("memberA", "end_contract", `'${cid}', '${f.end}'`);
await runSchedule(store, { today });
const cA10Works = `tenant_id = tests.t('A') and contract_service_id in (select id from public.contract_services where contract_id = tests.id('cA10')) and run_id is not null and deleted_at is null`;
f.afterEndLater = Number(await val(`select count(*) from public.works where ${cA10Works} and scheduled_date > $1`, [f.end]));
f.afterEndUntil = Number(await val(`select count(*) from public.works where ${cA10Works} and scheduled_date <= $1`, [f.end]));

// 繰り返しが読めない中身があっても、ほかは作る
await db.exec(`alter table public.contract_services drop constraint contract_services_recurrence_check;
               update public.contract_services set recurrence = 'FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO' where id = tests.id('svcA1-base');`);
const tenantA = await val("select tests.t('A')::text");
f.invalid = await runSchedule(store, { today, tenant: tenantA });
f.invalidRun = (await rows(`select status, counts->>'invalid' as inv from public.job_runs where kind = 'schedule_works' and tenant_id = tests.t('A') order by started_at desc, id desc limit 1`))[0];

console.log(JSON.stringify(f));
await db.close();
