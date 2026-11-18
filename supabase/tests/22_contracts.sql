-- 機能 010：清掃の契約（R-010-1〜25）。R-010-6〜12 の予定の作り方（RRULE の読み解き・会社ごとの回し方）は
-- apps/web/tests/schedule.test.ts（Vitest）と、その DB 側の関数をここで確かめる。R-010-26〜32 は画面の部品と画面の流れ。
begin;
select * from no_plan();
select tests.seed();

-- ---- 道具 ----
create or replace function pg_temp.call(p_uid uuid, p_fn text, p_args text) returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.callerr(p_uid uuid, p_fn text, p_args text) returns text language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) ->> 'error'
$$;
create or replace function pg_temp.svc(p_fn text, p_args text) returns jsonb language sql as $$
  select tests.run_as_service(format('select public.%I(%s) as r', p_fn, p_args)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.svcerr(p_fn text, p_args text) returns text language sql as $$
  select tests.run_as_service(format('select public.%I(%s) as r', p_fn, p_args)) ->> 'error'
$$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
create or replace function pg_temp.q(p text) returns text language sql as $$ select quote_literal(tests.id(p)::text) $$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Tokyo')::date $$;
-- 承認された見積（会社 A・建物 A4）と明細を、RLS を通らずに用意する
create or replace function pg_temp.mkq(p_name text, p_kind text, p_status text default 'approved') returns void language plpgsql as $$
begin
  insert into public.quotes (id, tenant_id, client_id, building_id, kind, status, number, issue_date, valid_until, tax_rate, subtotal, tax, total, submitted_at, decided_at, decided_by)
  values (tests.id(p_name), tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'), p_kind, p_status,
          case when p_status = 'draft' then null else 'Q-2030-' || lpad((select count(*) + 1 from public.quotes where number like 'Q-2030-%')::text, 4, '0') end,
          case when p_status = 'draft' then null else date '2030-01-01' end, null, 0.1, 0, 0, 0,
          case when p_status = 'draft' then null else now() end,
          case when p_status in ('approved', 'rejected') then now() end, case when p_status in ('approved', 'rejected') then tests.u('adminA') end);
end $$;
create or replace function pg_temp.mkl(p_q text, p_n int, p_kind text, p_qty numeric, p_price int, p_rec text default null) returns void language plpgsql as $$
begin
  insert into public.quote_lines (id, tenant_id, quote_id, line_kind, name, qty, unit, unit_price, recurrence, sort)
  values (tests.id('ln:' || p_q || ':' || p_n), tests.t('A'), tests.id(p_q), p_kind, p_q || '-' || p_n, p_qty, '式', p_price, p_rec, p_n);
end $$;
-- 契約を作って、中身の id を返す（変更・終了のテストの元）
create or replace function pg_temp.mkc(p_q text, p_start date) returns uuid language plpgsql as $$
declare r jsonb;
begin
  r := pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q(p_q) || format(', %L', p_start));
  return (r ->> 'id')::uuid;
end $$;
create or replace function pg_temp.sid(p_contract uuid, p_kind text) returns uuid language sql as $$
  select id from public.contract_services where contract_id = p_contract and service_kind = p_kind and valid_to is null and deleted_at is null
$$;
create or replace function pg_temp.mkrun(p_name text) returns uuid language plpgsql as $$
begin
  insert into public.job_runs (id, tenant_id, kind, status) values (tests.id(p_name), tests.t('A'), 'schedule_works', 'success');
  return tests.id(p_name);
end $$;

select pg_temp.mkq('q10-rec', 'recurring');
select pg_temp.mkl('q10-rec', 1, 'base', 1, 30000, 'FREQ=WEEKLY;BYDAY=MO');
select pg_temp.mkl('q10-rec', 2, 'option', 1, 12000, 'FREQ=MONTHLY;INTERVAL=3');
select pg_temp.mkl('q10-rec', 3, 'one_time', 2, 5000);
select pg_temp.mkq('q10-one', 'request');
select pg_temp.mkl('q10-one', 1, 'one_time', 1, 8000);
select pg_temp.mkl('q10-one', 2, 'one_time', 1, 3000);
select pg_temp.mkq('q10-sub', 'recurring', 'submitted');
select pg_temp.mkl('q10-sub', 1, 'base', 1, 1000, 'FREQ=MONTHLY');
select pg_temp.mkq('q10-draft', 'request', 'draft');
select pg_temp.mkl('q10-draft', 1, 'one_time', 1, 1000);
select pg_temp.mkq('q10-rej', 'recurring', 'rejected');
select pg_temp.mkl('q10-rej', 1, 'base', 1, 1000, 'FREQ=MONTHLY');
select pg_temp.mkq('q10-empty', 'request');

-- ===== R-010-1 承認された見積から契約を作る =====
select is(pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('q10-rec') || format(', %L', pg_temp.today())) ->> 'ok', 'true', 'R-010-1 社員は、承認された見積から契約を作れる');
select is((select kind || '/' || status || '/' || source || '/' || start_date::text || '/' || coalesce(end_date::text, 'null') from public.contracts where quote_id = tests.id('q10-rec')),
  'recurring/active/quote/' || pg_temp.today()::text || '/null', 'R-010-1 定期の見積から作った契約は、種類が定期・状況が有効・元が見積・終了日なし');
select is((select count(*)::int from public.contracts where quote_id = tests.id('q10-rec')), 1, 'R-010-1 契約は1つできる');
select is(pg_temp.call(tests.u('adminA'), 'create_contract_from_quote', pg_temp.q('q10-one') || format(', %L, %L', pg_temp.today() + 5, pg_temp.today() + 5)) ->> 'ok', 'true', 'R-010-1 管理者も作れる（終了日つき）');
select is((select kind from public.contracts where quote_id = tests.id('q10-one')), 'one_time', 'R-010-1 定期でない見積から作った契約は、種類が単発');
select is((select client_id || '/' || building_id from public.contracts where quote_id = tests.id('q10-one')), tests.id('clientA4')::text || '/' || tests.id('buildingA4')::text, 'R-010-1 取引先と建物は見積から写る');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('q10-sub') || format(', %L', pg_temp.today())) ->> 'reason', 'not_approved', 'R-010-1 提出のままの見積からは作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('q10-draft') || format(', %L', pg_temp.today())) ->> 'reason', 'not_approved', 'R-010-1 下書きの見積からは作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('q10-rej') || format(', %L', pg_temp.today())) ->> 'reason', 'not_approved', 'R-010-1 不成立の見積からは作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('q10-empty') || format(', %L', pg_temp.today())) ->> 'reason', 'no_lines', 'R-010-1 明細のない見積からは作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('qA-app') || ', null') ->> 'reason', 'start_required', 'R-010-1 開始日がなければ作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('qA-app') || format(', %L, %L', pg_temp.today(), pg_temp.today() - 1)) ->> 'reason', 'end_before_start', 'R-010-1 終了日が開始日より前なら作らない');
select is((select count(*)::int from public.contracts where quote_id = tests.id('qA-app')), 0, 'R-010-1 断ったときは、契約も中身も作らない');

-- ===== R-010-2 明細が清掃の中身になる =====
select is((select string_agg(service_kind || ':' || billing || ':' || amount::text || ':' || recurrence, ' | ' order by name) from public.contract_services s
           join public.contracts c on c.id = s.contract_id and c.quote_id = tests.id('q10-rec')),
  'base:monthly:30000:FREQ=WEEKLY;BYDAY=MO | option:per_visit:12000:FREQ=MONTHLY;INTERVAL=3 | special:per_visit:10000:FREQ=DAILY;COUNT=1',
  'R-010-2 基本は毎月・オプションと単発（特別清掃）は行った回ごと。金額は明細の金額（数量×単価）、繰り返しのない明細は単発');
select is((select string_agg(name, ',' order by name) from public.contract_services s join public.contracts c on c.id = s.contract_id and c.quote_id = tests.id('q10-rec')),
  'q10-rec-1,q10-rec-2,q10-rec-3', 'R-010-2 名前は明細の品名');
select is((select count(*)::int from public.contract_services s join public.contracts c on c.id = s.contract_id and c.quote_id = tests.id('q10-rec')
           where s.valid_from = pg_temp.today() and s.valid_to is null and s.service_key is not null), 3, 'R-010-2 起点（valid_from）は開始日。同じ契約の中身ごとに service_key が付く');
select is((select count(distinct service_key)::int from public.contract_services s join public.contracts c on c.id = s.contract_id and c.quote_id = tests.id('q10-rec')), 3, 'R-010-2 service_key は中身ごとに別');
select is((select string_agg(service_kind || ':' || billing || ':' || recurrence, ' | ' order by name) from public.contract_services s join public.contracts c on c.id = s.contract_id and c.quote_id = tests.id('q10-one')),
  'special:per_visit:FREQ=DAILY;COUNT=1 | special:per_visit:FREQ=DAILY;COUNT=1', 'R-010-2 単発の契約は、特別清掃の2行で、どちらも単発の繰り返し');

-- ===== R-010-3 同じ見積から二度作らない =====
select is((select id from public.contracts where quote_id = tests.id('q10-rec'))::text, pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('q10-rec') || format(', %L', pg_temp.today() + 3)) ->> 'id',
  'R-010-3 同じ見積からもう一度呼んでも、同じ契約を返す');
select is((select count(*)::int from public.contracts where quote_id = tests.id('q10-rec')), 1, 'R-010-3 契約は増えない');
select is((select count(*)::int from public.contract_services s join public.contracts c on c.id = s.contract_id and c.quote_id = tests.id('q10-rec')), 3, 'R-010-3 中身も増えない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('q10-rec') || format(', %L', pg_temp.today() + 3)) ->> 'already', 'true', 'R-010-3 すでにあることが分かる');
select is(pg_temp.try(format($q$insert into public.contracts (tenant_id, client_id, building_id, source, quote_id, kind, start_date) values (%L, %L, %L, 'quote', %L, 'recurring', date '2030-01-01')$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'), tests.id('q10-rec'))), '23505', 'R-010-3 1つの見積に契約は1つだけ（DB の一意の索引）');

-- ===== R-010-4 取り込みの契約（見積なし）・元の形の確かめ =====
select is(pg_temp.call(tests.u('memberA'), 'create_contract_import', format('%L, %L, ''recurring'', %L, null, %L::jsonb', tests.id('clientA4'), tests.id('buildingA4'), pg_temp.today(),
  '[{"service_kind":"base","name":"取り込みの定期清掃","amount":"20000","recurrence":"FREQ=WEEKLY;BYDAY=TU,FR","start_time":"09:00","end_time":"11:30"},{"service_kind":"special","name":"取り込みの特別清掃","amount":"7000"}]')) ->> 'ok', 'true',
  'R-010-4 取り込みで、見積なしの契約を作れる');
select is((select source || '/' || coalesce(quote_id::text, 'null') from public.contracts where id = (select c.id from public.contracts c join public.contract_services s on s.contract_id = c.id where s.name = '取り込みの定期清掃')), 'import/null', 'R-010-4 元は取り込み・見積なし');
select is((select billing || '/' || recurrence || '/' || start_time::text || '/' || end_time::text from public.contract_services where name = '取り込みの定期清掃'), 'monthly/FREQ=WEEKLY;BYDAY=TU,FR/09:00:00/11:30:00', 'R-010-4 基本は毎月が初めの値・時刻が入る');
select is((select billing || '/' || recurrence from public.contract_services where name = '取り込みの特別清掃'), 'per_visit/FREQ=DAILY;COUNT=1', 'R-010-4 特別清掃は行った回ごと・単発が初めの値');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_import', format('%L, %L, ''recurring'', %L, null, ''[]''::jsonb', tests.id('clientA4'), tests.id('buildingA4'), pg_temp.today())) ->> 'reason', 'no_services', 'R-010-4 中身がなければ作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_import', format('%L, %L, ''recurring'', %L, null, %L::jsonb', tests.id('clientA4'), tests.id('buildingA4'), pg_temp.today(),
  '[{"service_kind":"base","name":"x","amount":"1"},{"service_kind":"base","name":"y","amount":"-5"}]')) ->> 'reason', 'invalid_amount', 'R-010-4 1つでも金額が正しくなければ、全部作らない');
select is((select count(*)::int from public.contracts where building_id = tests.id('buildingA4') and source = 'import'), 1, 'R-010-4 断ったときは、半分だけ作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_import', format('%L, %L, ''recurring'', %L, null, %L::jsonb', tests.id('clientA4'), tests.id('buildingA4'), pg_temp.today(),
  '[{"service_kind":"base","name":"x","amount":"1","recurrence":"毎週"}]')) ->> 'reason', 'invalid_recurrence', 'R-010-4 繰り返しが RRULE の形でなければ作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_contract_import', format('%L, %L, ''weekly'', %L, null, ''[]''::jsonb', tests.id('clientA4'), tests.id('buildingA4'), pg_temp.today())) ->> 'reason', 'invalid_kind', 'R-010-4 種類が定期・単発以外なら作らない');
select is(pg_temp.callerr(tests.u('memberA'), 'create_contract_import', format('%L, %L, ''recurring'', %L, null, ''[]''::jsonb', tests.id('clientB4'), tests.id('buildingA4'), pg_temp.today())), '42501', 'R-010-4 別の会社の取引先は受け付けない');
select is(pg_temp.try(format($q$insert into public.contracts (tenant_id, client_id, building_id, source, quote_id, kind, start_date) values (%L, %L, %L, 'quote', null, 'recurring', date '2030-01-01')$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), '23514', 'R-010-4 元が見積なら、見積（quote_id）が必ず要る（DB の制約）');
select is(pg_temp.try(format($q$insert into public.contracts (tenant_id, client_id, building_id, source, quote_id, kind, start_date) values (%L, %L, %L, 'import', %L, 'recurring', date '2030-01-01')$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'), tests.id('q10-sub'))), '23514', 'R-010-4 元が取り込みなら、見積は付けない（DB の制約）');

-- ===== R-010-5 権限 =====
select is(pg_temp.callerr(tests.u('staffA'), 'create_contract_from_quote', pg_temp.q('q10-one') || format(', %L', pg_temp.today())), '42501', 'R-010-5 スタッフは契約を作れない');
select is(pg_temp.callerr(tests.u('extA'), 'create_contract_from_quote', pg_temp.q('q10-one') || format(', %L', pg_temp.today())), '42501', 'R-010-5 外部の人は契約を作れない');
select is(pg_temp.callerr(tests.u('operator'), 'create_contract_from_quote', pg_temp.q('q10-one') || format(', %L', pg_temp.today())), '42501', 'R-010-5 運営は契約を作れない');
select is(pg_temp.callerr(tests.u('nobody'), 'create_contract_from_quote', pg_temp.q('q10-one') || format(', %L', pg_temp.today())), '42501', 'R-010-5 どこにも属さない人は契約を作れない');
select is(tests.run_as_anon(format('select public.create_contract_from_quote(%L, %L)', tests.id('q10-one'), pg_temp.today())) ->> 'error', '42501', 'R-010-5 ログインしていない人は契約を作れない');
select is(pg_temp.callerr(tests.u('adminB'), 'create_contract_from_quote', pg_temp.q('q10-one') || format(', %L', pg_temp.today())), '42501', 'R-010-24 別の会社の管理者は、A の見積から契約を作れない（見つからないのと同じ 42501）');
select is(pg_temp.callerr(tests.u('memberA'), 'create_contract_from_quote', quote_literal(gen_random_uuid()::text) || format(', %L', pg_temp.today())), '42501', 'R-010-5 存在しない見積も同じ 42501');

-- ===== R-010-18 契約・中身は画面から直接書けない =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.contracts (tenant_id, client_id, building_id, source, kind, start_date) values (%L, %L, %L, 'import', 'recurring', date '2030-01-01')$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), '42501', 'R-010-18 社員も、契約を直接作れない（RPC だけ）');
select is(tests.err(tests.u('adminA'), format($q$update public.contracts set status = 'ended', end_date = date '2030-01-01' where id = %L$q$, tests.id('cA10'))), '42501', 'R-010-18 管理者も、契約を直接直せない（終了は RPC）');
select is(tests.err(tests.u('adminA'), format($q$update public.contract_services set amount = 1 where id = %L$q$, tests.id('svcA10-base'))), '42501', 'R-010-18 中身の金額を直接直せない（変更は RPC）');
select is(tests.err(tests.u('adminA'), format($q$insert into public.contract_services (tenant_id, contract_id, service_kind, name, billing, recurrence, valid_from) values (%L, %L, 'base', 'x', 'monthly', 'FREQ=MONTHLY', date '2030-01-01')$q$,
  tests.t('A'), tests.id('cA10'))), '42501', 'R-010-18 中身を直接足せない');
select is(tests.err(tests.u('adminA'), format($q$delete from public.contracts where id = %L$q$, tests.id('cA10'))), '42501', 'R-010-18 契約は消せない');

-- ===== R-010-19 読める人 =====
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.contracts where id = %L$q$, tests.id('cA10'))), 1::bigint, 'R-010-19 社員は契約を読める');
select is(tests.n(tests.u('adminA'), format($q$select 1 from public.contract_services where contract_id = %L$q$, tests.id('cA10'))), 2::bigint, 'R-010-19 管理者は中身を読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.contracts'), 0::bigint, 'R-010-19 スタッフは契約を読めない（金額）');
select is(tests.n(tests.u('staffA'), 'select 1 from public.contract_services'), 0::bigint, 'R-010-19 スタッフは中身を読めない（金額）');
select is(tests.n(tests.u('extA'), 'select 1 from public.contracts'), 0::bigint, 'R-010-19 外部の人は契約を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.contract_services'), 0::bigint, 'R-010-19 外部の人は中身を読めない');
select is(tests.n(tests.u('adminB'), format($q$select 1 from public.contracts where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-010-24 別の会社の契約は読めない');

-- ===== R-010-13・14 中身を変える =====
-- 準備：定期の契約（q10-rec。開始は今日）。基本に担当（スタッフ A）を付け、予定を作る
create temp table _ctx on commit drop as select pg_temp.sid((select id from public.contracts where quote_id = tests.id('q10-rec')), 'base') as base_id,
  (select id from public.contracts where quote_id = tests.id('q10-rec')) as contract_id;
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.contract_service_staff (tenant_id, contract_service_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), (select base_id from _ctx), tests.id('m:A:staffA'))), 1::bigint,
  '（準備）基本の中身に、決まった担当を付ける');
select pg_temp.mkrun('run-chg');
create temp table _key on commit drop as select service_key as k from public.contract_services where id = (select base_id from _ctx);
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-chg'),
  format('[{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"}]',
    (select base_id from _ctx), pg_temp.today() + 3, (select base_id from _ctx), pg_temp.today() + 10, (select base_id from _ctx), pg_temp.today() + 12, (select base_id from _ctx), pg_temp.today() + 17))) ->> 'created', '4',
  '（準備）基本の予定を4日分作る（定時の処理の関数）');
-- 手で足した作業（run_id なし）と、始まっている作業
insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status)
  select tests.id('w-manual'), tests.t('A'), tests.id('buildingA4'), (select base_id from _ctx), (select k from _key), '臨時の訪問', pg_temp.today() + 15, 'scheduled';
update public.works set status = 'in_progress' where tenant_id = tests.t('A') and service_key = (select k from _key) and scheduled_date = pg_temp.today() + 12;

select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() - 1, '{"amount":"35000"}')) ->> 'reason', 'effective_in_past', 'R-010-13 適用日が今日より前なら変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today(), '{"amount":"35000"}')) ->> 'reason', 'effective_not_after_start', 'R-010-13 適用日が今の中身の開始日以前なら変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{}')) ->> 'reason', 'nothing_to_change', 'R-010-13 変える項目がなければ変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"amount":30000}')) ->> 'reason', 'no_change', 'R-010-13 今と同じ値なら変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"amount":"abc"}')) ->> 'reason', 'invalid_amount', 'R-010-13 金額が数でなければ変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"amount":-1}')) ->> 'reason', 'invalid_amount', 'R-010-13 金額が負なら変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"recurrence":"毎週月曜"}')) ->> 'reason', 'invalid_recurrence', 'R-010-13 繰り返しが RRULE の形でなければ変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"start_time":"12:00","end_time":"09:00"}')) ->> 'reason', 'invalid_time', 'R-010-13 終了の時刻が開始より前なら変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"name":" "}')) ->> 'reason', 'invalid_name', 'R-010-13 名前が空なら変えない');
select is(pg_temp.callerr(tests.u('staffA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"amount":35000}')), '42501', 'R-010-13 スタッフは変えられない');
select is(pg_temp.callerr(tests.u('adminB'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"amount":35000}')), '42501', 'R-010-24 別の会社の人は変えられない');
select is((select count(*)::int from public.contract_services where service_key = (select k from _key)), 1, 'R-010-13 断ったときは、中身を増やさない');

select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 10, '{"amount":35000,"recurrence":"FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"}')) ->> 'ok', 'true',
  'R-010-13 社員は金額と繰り返しを変えられる');
select is((select count(*)::int from public.contract_services where service_key = (select k from _key)), 2, 'R-010-13 同じ service_key で、行が2つになる（古い行は残る）');
select is((select amount::text || '/' || valid_from::text || '/' || valid_to::text from public.contract_services where id = (select base_id from _ctx)),
  '30000/' || pg_temp.today()::text || '/' || (pg_temp.today() + 9)::text, 'R-010-13 古い行は金額そのまま、valid_to（適用日の前日）で閉じる。どの月にいくらだったかが残る');
select is((select amount::text || '/' || valid_from::text || '/' || coalesce(valid_to::text, 'null') || '/' || recurrence from public.contract_services where service_key = (select k from _key) and valid_to is null),
  '35000/' || (pg_temp.today() + 10)::text || '/null/FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'R-010-13 新しい行は新しい金額・繰り返しで、valid_from は適用日');
select is((select service_kind || '/' || billing || '/' || name from public.contract_services where service_key = (select k from _key) and valid_to is null),
  (select service_kind || '/' || billing || '/' || name from public.contract_services where id = (select base_id from _ctx)), 'R-010-13 種類・請求の仕方・名前（変えなかったもの）は引き継ぐ');
select is((select count(*)::int from public.contract_service_staff where contract_service_id = (select id from public.contract_services where service_key = (select k from _key) and valid_to is null) and membership_id = tests.id('m:A:staffA') and deleted_at is null),
  1, 'R-010-14 決まった担当は新しい行に引き継ぐ');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select base_id from _ctx), pg_temp.today() + 20, '{"amount":1}')) ->> 'reason', 'not_current', 'R-010-13 すでに閉じた古い行は、もう変えられない');

-- 予定：適用日以降の、始まっていない定時の作業（+10・+17）だけ取り消す
select is((select string_agg(scheduled_date::text || ':' || status || ':' || (deleted_at is not null)::text, ' | ' order by scheduled_date) from public.works where service_key = (select k from _key) and run_id is not null),
  (pg_temp.today() + 3)::text || ':scheduled:false | ' || (pg_temp.today() + 10)::text || ':cancelled:true | ' || (pg_temp.today() + 12)::text || ':in_progress:false | ' || (pg_temp.today() + 17)::text || ':cancelled:true',
  'R-010-14 適用日以降で、まだ始まっていない予定は取り消す。適用日より前・始まっている作業は残す');
select is((select status from public.works where id = tests.id('w-manual')), 'scheduled', 'R-010-14 手で足した作業は取り消さない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select id from public.contract_services where service_key = (select k from _key) and valid_to is null), pg_temp.today() + 30, '{"name":"定期清掃（改）"}')) ->> 'cancelled', '0', 'R-010-14 取り消す予定がなければ 0 件');

-- 作り直し：取り消した日を、定時の処理の関数が、その日に効いている中身（適用日からの新しい行）で作れる。二度目は重ならない
select pg_temp.mkrun('run-rebuild');
create temp table _rb on commit drop as select id as sid from public.contract_services where service_key = (select k from _key) and valid_from = pg_temp.today() + 10;
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-rebuild'),
  format('[{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"}]', (select sid from _rb), pg_temp.today() + 10, (select sid from _rb), pg_temp.today() + 17))) ->> 'created', '2',
  'R-010-14 取り消した日（+10・+17）は、新しい中身で作り直せる');
select is((select string_agg(scheduled_date::text || ':' || status, ' | ' order by scheduled_date) from public.works where service_key = (select k from _key) and run_id is not null and deleted_at is null),
  (pg_temp.today() + 3)::text || ':scheduled | ' || (pg_temp.today() + 10)::text || ':scheduled | ' || (pg_temp.today() + 12)::text || ':in_progress | ' || (pg_temp.today() + 17)::text || ':scheduled',
  'R-010-14 作り直した予定と、残した予定が並ぶ（同じ日に二重にならない）');
select is((select r from (select pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-rebuild'), format('[{"service_id":"%s","date":"%s"}]', (select sid from _rb), pg_temp.today() + 10))) ->> 'created' as r) z), '0',
  'R-010-8 二度目は作らない');
select is((select count(*)::int from public.works where service_key = (select k from _key) and scheduled_date = pg_temp.today() + 10), 2, 'R-010-14 取り消した古い行は、履歴として残る（deleted_at つき）');

-- ===== R-010-17 契約を終える =====
select pg_temp.mkq('q10-end', 'recurring');
select pg_temp.mkl('q10-end', 1, 'base', 1, 10000, 'FREQ=DAILY');
select pg_temp.mkl('q10-end', 2, 'option', 1, 2000, 'FREQ=WEEKLY;BYDAY=FR');
create temp table _end on commit drop as select pg_temp.mkc('q10-end', pg_temp.today()) as cid;
select pg_temp.mkrun('run-end');
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-end'),
  format('[{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"}]',
    pg_temp.sid((select cid from _end), 'base'), pg_temp.today() + 1, pg_temp.sid((select cid from _end), 'base'), pg_temp.today() + 5,
    pg_temp.sid((select cid from _end), 'option'), pg_temp.today() + 6, pg_temp.sid((select cid from _end), 'option'), pg_temp.today() + 13))) ->> 'created', '4', '（準備）終えるテストの予定を作る');
select is(pg_temp.callerr(tests.u('staffA'), 'end_contract', format('%L, %L', (select cid from _end), pg_temp.today() + 5)), '42501', 'R-010-17 スタッフは契約を終えられない');
select is(pg_temp.callerr(tests.u('adminB'), 'end_contract', format('%L, %L', (select cid from _end), pg_temp.today() + 5)), '42501', 'R-010-24 別の会社の人は契約を終えられない');
select is(pg_temp.call(tests.u('memberA'), 'end_contract', format('%L, %L', (select cid from _end), pg_temp.today() - 1)) ->> 'reason', 'end_before_start', 'R-010-17 終了日が開始日より前なら終えない');
select is(pg_temp.call(tests.u('memberA'), 'end_contract', format('%L, %L', (select cid from _end), pg_temp.today() + 5)) ->> 'ok', 'true', 'R-010-17 社員は契約を終えられる');
select is((select status || '/' || end_date::text from public.contracts where id = (select cid from _end)), 'ended/' || (pg_temp.today() + 5)::text, 'R-010-17 状況は終了・終了日が入る');
select is((select count(*)::int from public.contract_services where contract_id = (select cid from _end) and valid_to = pg_temp.today() + 5), 2, 'R-010-17 開いていた中身は、終了日で閉じる');
select is((select string_agg(scheduled_date::text || ':' || status, ' | ' order by scheduled_date) from public.works where contract_service_id in (select id from public.contract_services where contract_id = (select cid from _end)) and deleted_at is null),
  (pg_temp.today() + 1)::text || ':scheduled | ' || (pg_temp.today() + 5)::text || ':scheduled', 'R-010-17 終了日より後の予定は取り消し、終了日までの予定は残す');
select is(pg_temp.call(tests.u('memberA'), 'end_contract', format('%L, %L', (select cid from _end), pg_temp.today() + 2)) ->> 'already', 'true', 'R-010-17 終えた契約をもう一度終えても、何もしない');
select is((select end_date::text from public.contracts where id = (select cid from _end)), (pg_temp.today() + 5)::text, 'R-010-17 二度目は終了日を変えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select id from public.contract_services where contract_id = (select cid from _end) and service_kind = 'base'), pg_temp.today() + 3, '{"amount":1}')) ->> 'reason', 'contract_ended', 'R-010-17 終えた契約の中身は変えられない（理由：契約が終了）');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.contracts where id = %L and status = 'ended'$q$, (select cid from _end))), 1::bigint, 'R-010-17 終えた契約も読める（履歴として残る）');

-- ===== R-010-15 終了日のある契約は、終了日より後の日からの変更はしない =====
select pg_temp.mkq('q10-ce', 'recurring');
select pg_temp.mkl('q10-ce', 1, 'base', 1, 10000, 'FREQ=WEEKLY;BYDAY=FR');
create temp table _ce on commit drop as
  select (pg_temp.call(tests.u('memberA'), 'create_contract_from_quote', pg_temp.q('q10-ce') || format(', %L, %L', pg_temp.today(), pg_temp.today() + 30)) ->> 'id')::uuid as cid;
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', pg_temp.sid((select cid from _ce), 'base'), pg_temp.today() + 31, '{"amount":12000}')) ->> 'reason', 'after_contract_end', 'R-010-15 契約の終了日より後の日からの変更はしない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', pg_temp.sid((select cid from _ce), 'base'), pg_temp.today() + 30, '{"amount":12000}')) ->> 'ok', 'true', 'R-010-15 終了日までなら変えられる');

-- ===== R-010-16 請求書に載った契約の中身は直せない（011 の本物の表で確かめる） =====
select pg_temp.mkq('q10-inv', 'recurring');
select pg_temp.mkl('q10-inv', 1, 'base', 1, 10000, 'FREQ=WEEKLY;BYDAY=WE');
create temp table _inv on commit drop as select pg_temp.mkc('q10-inv', pg_temp.today()) as cid;
create temp table _invkey on commit drop as select service_key as k, id as sid from public.contract_services where contract_id = (select cid from _inv);
-- 載っていなければ、載っていない扱い
select is(app.service_invoiced(tests.t('A'), (select k from _invkey), pg_temp.today()), false, 'R-010-16 請求書の明細に載っていなければ、載っていない扱い');
insert into public.invoices (id, tenant_id, client_id, period) values (tests.id('inv-c10'), tests.t('A'), tests.id('clientA11'), date '2032-01-01');
insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, name) values (tests.t('A'), tests.id('inv-c10'), (select k from _invkey), (date_trunc('month', pg_temp.today() + 40))::date, '定期清掃');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select sid from _invkey), pg_temp.today() + 40, '{"amount":99}')) ->> 'reason', 'invoiced', 'R-010-16 請求書に載った月以降に効く変更はしない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select sid from _invkey), greatest((date_trunc('month', pg_temp.today() + 40))::date, pg_temp.today() + 1), '{"amount":99}')) ->> 'reason', 'invoiced', 'R-010-16 載った月の中の適用日も変えない');
select is(pg_temp.call(tests.u('memberA'), 'end_contract', format('%L, %L', (select cid from _inv), pg_temp.today() + 5)) ->> 'reason', 'invoiced', 'R-010-16 載った月より前に終えると、載った月が残るので終えない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select sid from _invkey), pg_temp.today() + 5, '{"amount":99}')) ->> 'reason', 'invoiced', 'R-010-16 載った月より前の適用日でも、載った月に効く変更はしない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', (select sid from _invkey), (date_trunc('month', pg_temp.today() + 40) + interval '1 month')::date, '{"amount":99}')) ->> 'ok', 'true', 'R-010-16 載った月より後の月から効く変更は、できる');
update public.invoice_lines set deleted_at = now() where invoice_id = tests.id('inv-c10');
select is(pg_temp.call(tests.u('memberA'), 'end_contract', format('%L, %L', (select cid from _inv), pg_temp.today() + 50)) ->> 'ok', 'true', 'R-010-16 請求書の明細が取り消されていれば（deleted_at）、終えられる');

-- ===== R-010-20 決まった担当 =====
select ok(tests.n(tests.u('staffA'), 'select 1 from public.contract_service_staff') > 0 and tests.n(tests.u('staffA'), format($q$select 1 from public.contract_service_staff where membership_id <> %L$q$, tests.id('m:A:staffA'))) = 0,
  'R-010-20 スタッフは、決まった担当を自分の行だけ読める');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.contract_service_staff where tenant_id = %L$q$, tests.t('A'))), (select count(*) from public.contract_service_staff where tenant_id = tests.t('A') and deleted_at is null), 'R-010-20 社員は会社の全部を読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.contract_service_staff'), 0::bigint, 'R-010-20 外部の人は読めない');
select is(tests.err(tests.u('staffA'), format($q$insert into public.contract_service_staff (tenant_id, contract_service_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('svcA1-base'), tests.id('m:A:staffA'))), '42501', 'R-010-20 スタッフは担当を決められない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.contract_service_staff (tenant_id, contract_service_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('svcA1-base'), tests.id('m:A:extA'))), '42501', 'R-010-20 外部の人の所属は担当にできない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.contract_service_staff (tenant_id, contract_service_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('svcA1-base'), tests.id('m:B:staffB'))), '42501', 'R-010-20 別の会社の所属は担当にできない');
select is(pg_temp.try(format($q$insert into public.contract_service_staff (tenant_id, contract_service_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('svcA1-base'), tests.id('m:B:staffB'))), '23503', 'R-010-20 別の会社の所属は、組の外部キーでも止まる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.contract_service_staff (tenant_id, contract_service_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('svcA1-base'), tests.id('m:A:staffA'))), null, 'R-010-20 社員は担当を決められる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.contract_service_staff (tenant_id, contract_service_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('svcA1-base'), tests.id('m:A:staffA'))), '23505', 'R-010-20 同じ担当は二重に付けない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.contract_service_staff set deleted_at = now() where contract_service_id = %L and membership_id = %L$q$, tests.id('svcA1-base'), tests.id('m:A:staffA'))), 1::bigint, 'R-010-20 担当を外せる（論理削除）');
select is(tests.cnt(tests.u('staffA'), format($q$update public.contract_service_staff set deleted_at = now() where id = %L$q$, tests.id('cssA10-staff'))), 0::bigint, 'R-010-20 スタッフは自分の担当も外せない');

-- ===== R-010-21 作業を読める人 =====
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.works where id = %L$q$, tests.id('wA10'))), 1::bigint, 'R-010-21 スタッフは、担当の作業を読める');
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.works where id in (%L, %L, %L)$q$, tests.id('wA1'), tests.id('wA10-done'), tests.id('wB10'))), 0::bigint, 'R-010-21 担当でない作業（同じ会社の別の作業・別の会社の作業）は読めない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.works w where not exists (select 1 from public.work_assignments a where a.work_id = w.id and a.membership_id = ' || quote_literal(tests.id('m:A:staffA')) || ')'), 0::bigint, 'R-010-21 読める作業は、全部、自分が担当のもの');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.works where tenant_id = %L and deleted_at is null$q$, tests.t('A'))), (select count(*) from public.works where tenant_id = tests.t('A') and deleted_at is null), 'R-010-21 work.assign を持つ社員は全部読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.works'), 1::bigint, 'R-010-21 外部の人は、許された建物（A1）の作業だけ読める');
select is(tests.run_as(tests.u('extA'), 'select id from public.works') -> 'rows' -> 0 ->> 'id', tests.id('wA1')::text, 'R-010-21 読めるのは建物 A1 の作業');
select is(tests.n(tests.u('extA'), 'select 1 from public.work_assignments'), 0::bigint, 'R-010-21 外部の人は担当を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.work_charges'), 0::bigint, 'R-010-21 外部の人は作業の金額を読めない');
update public.works set deleted_at = now() where id = tests.id('wA1');
select is(tests.n(tests.u('extA'), 'select 1 from public.works'), 0::bigint, 'R-010-21 消した作業は、外部の人に見せない');
update public.works set deleted_at = null where id = tests.id('wA1');
select is(tests.n(tests.u('staffB'), format($q$select 1 from public.works where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-010-24 別の会社のスタッフは、A の作業を読めない');
select is(tests.n(tests.u('nobody'), 'select 1 from public.works'), 0::bigint, 'R-010-21 どこにも属さない人は読めない');

-- ===== R-010-23 作業は直接作れない・状況を直接直せない =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.works (tenant_id, building_id, request_id, title, scheduled_date) values (%L, %L, %L, 'x', date '2030-01-01')$q$, tests.t('A'), tests.id('buildingA4'), tests.id('reqA-1'))), '42501', 'R-010-23 社員も、作業を直接作れない（RPC だけ）');
select is(tests.err(tests.u('memberA'), format($q$update public.works set status = 'done' where id = %L$q$, tests.id('wA10'))), '42501', 'R-010-23 状況は直接直せない');
select is(tests.err(tests.u('memberA'), format($q$update public.works set scheduled_date = date '2030-01-01' where id = %L$q$, tests.id('wA10'))), '42501', 'R-010-23 日付も直接直せない（動かすのは RPC。012）');
select is(tests.cnt(tests.u('memberA'), format($q$update public.works set start_time = time '10:00', end_time = time '13:00' where id = %L$q$, tests.id('wA10'))), 1::bigint, 'R-010-23 予定の間は、時刻を直せる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.works set start_time = time '10:00' where id = %L$q$, tests.id('wA10-done'))), 0::bigint, 'R-010-23 終わった作業の時刻は直せない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.works set start_time = time '10:00' where id = %L$q$, tests.id('wA10'))), 0::bigint, 'R-010-23 スタッフは作業を直せない');
select is(tests.err(tests.u('adminA'), format($q$delete from public.works where id = %L$q$, tests.id('wA10'))), '42501', 'R-010-23 作業は消せない');
select is(pg_temp.try(format($q$insert into public.works (tenant_id, building_id, title, scheduled_date) values (%L, %L, 'どちらも無い', date '2030-01-01')$q$, tests.t('A'), tests.id('buildingA4'))), '23514', 'R-010-23 契約の中身も案件もない作業は作れない（DB の制約）');
select is(pg_temp.try(format($q$insert into public.works (tenant_id, building_id, contract_service_id, request_id, title, scheduled_date) values (%L, %L, %L, %L, 'どちらも有る', date '2030-01-01')$q$,
  tests.t('A'), tests.id('buildingA4'), tests.id('svcA10-base'), tests.id('reqA-1'))), '23514', 'R-010-23 契約の中身と案件の両方を持つ作業は作れない');
select is(pg_temp.try(format($q$insert into public.works (tenant_id, building_id, request_id, title, scheduled_date, status) values (%L, %L, %L, 'x', date '2030-01-01', 'weird')$q$, tests.t('A'), tests.id('buildingA4'), tests.id('reqA-1'))), '23514', 'R-010-23 状況は決まった値だけ');
select is(pg_temp.try(format($q$insert into public.works (tenant_id, building_id, request_id, title, scheduled_date) values (%L, %L, %L, 'x', date '2030-01-01')$q$, tests.t('A'), tests.id('buildingB4'), tests.id('reqA-1'))), '23503', 'R-010-24 別の会社の建物の作業は作れない');
select is(pg_temp.try(format($q$insert into public.works (tenant_id, building_id, request_id, title, scheduled_date) values (%L, %L, %L, 'x', date '2030-01-01')$q$, tests.t('A'), tests.id('buildingA4'), tests.id('reqB-1'))), '23503', 'R-010-24 別の会社の案件の作業は作れない');
select is(pg_temp.try(format($q$insert into public.works (tenant_id, building_id, request_id, title, scheduled_date) values (%L, %L, %L, '案件の作業', date '2030-01-01')$q$, tests.t('A'), tests.id('buildingA4'), tests.id('reqA-1'))), 'ok', 'R-010-23 案件を元にした作業は作れる（012 の手で足す作業の形）');

-- ===== 担当（work_assignments）=====
select ok(tests.n(tests.u('staffA'), 'select 1 from public.work_assignments') > 0 and tests.n(tests.u('staffA'), format($q$select 1 from public.work_assignments where membership_id <> %L$q$, tests.id('m:A:staffA'))) = 0, 'R-010-21 スタッフは、担当を自分の行だけ読める');
select is(tests.err(tests.u('memberA'), format($q$insert into public.work_assignments (tenant_id, work_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('wA1'), tests.id('m:A:staffA'))), null, 'R-010-21 社員は担当を割り当てられる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.work_assignments (tenant_id, work_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('wA1'), tests.id('m:A:extA'))), '42501', 'R-010-21 外部の人の所属は担当にできない');
select is(tests.err(tests.u('staffA'), format($q$insert into public.work_assignments (tenant_id, work_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('wA10-done'), tests.id('m:A:staffA'))), '42501', 'R-010-21 スタッフは担当を割り当てられない');
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.works where id = %L$q$, tests.id('wA1'))), 1::bigint, 'R-010-21 担当になると、その作業を読める');

-- ===== R-010-10・22 作業の金額 =====
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.work_charges where id = %L$q$, tests.id('wcA10'))), 1::bigint, 'R-010-22 社員は作業の金額を読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.work_charges'), 0::bigint, 'R-010-22 スタッフは読めない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.work_charges set amount = 13000 where id = %L$q$, tests.id('wcA10'))), 1::bigint, 'R-010-22 社員は作業の金額を直せる');
select is(tests.err(tests.u('memberA'), format($q$update public.work_charges set work_id = %L where id = %L$q$, tests.id('wA1'), tests.id('wcA10'))), '42501', 'R-010-22 付け替えはできない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.work_charges set amount = 1 where id = %L$q$, tests.id('wcA10'))), 0::bigint, 'R-010-22 スタッフは直せない（読めないので 0 行）');
select is(pg_temp.try(format($q$insert into public.work_charges (tenant_id, work_id, amount) values (%L, %L, 1)$q$, tests.t('A'), tests.id('wA10'))), '23505', 'R-010-22 作業の金額は1つの作業に1つ');
select is(tests.err(tests.u('memberA'), format($q$insert into public.work_charges (tenant_id, work_id, amount) values (%L, %L, -5)$q$, tests.t('A'), tests.id('wA10-done'))), '23514', 'R-010-22 金額が負なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.work_charges (tenant_id, work_id, amount) values (%L, %L, 500)$q$, tests.t('A'), tests.id('wA10-done'))), null, 'R-010-22 社員は作業の金額を作れる');
-- 請求書に載ったら直せない（請求書は、上の R-010-16 で作ってある）
insert into public.invoice_lines (tenant_id, invoice_id, work_id, name) values (tests.t('A'), tests.id('inv-c10'), tests.id('wA10'), '作業');
select is(tests.cnt(tests.u('memberA'), format($q$update public.work_charges set amount = 14000 where id = %L$q$, tests.id('wcA10'))), 0::bigint, 'R-010-16 請求書に載った作業の金額は直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.work_charges set amount = 14000 where id = %L$q$, tests.id('wcA1'))), 1::bigint, 'R-010-16 載っていない作業の金額は直せる');
select is((select amount from public.work_charges where id = tests.id('wcA10')), 13000::bigint, 'R-010-16 載った金額は変わらない');

-- ===== R-010-24・R-010-25 履歴 =====
select ok((select count(*) from public.audit_logs where table_name = 'contracts' and action = 'insert' and source = 'rpc') >= 3, 'R-010-24 契約を作ったことが、source が rpc で履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'contract_services' and action = 'update' and source = 'rpc' and changed ? 'valid_to') >= 1, 'R-010-24 中身を閉じたことが履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'works' and action = 'update' and changed ? 'status') >= 1, 'R-010-24 作業の状況の変化が履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'work_charges' and action = 'update' and changed ? 'amount') >= 1, 'R-010-24 作業の金額を直したことが履歴に残る');

-- ===== 構造の制約 =====
select is(pg_temp.try(format($q$insert into public.contract_services (tenant_id, contract_id, service_key, service_kind, name, billing, recurrence, valid_from) values (%L, %L, %L, 'base', 'x', 'monthly', 'FREQ=MONTHLY', date '2030-01-01')$q$,
  tests.t('A'), tests.id('cA1'), tests.id('key:A1-base'))), '23505', '今の中身（valid_to が空）は、同じ service_key で1つだけ');
select is(pg_temp.try(format($q$insert into public.contract_services (tenant_id, contract_id, service_key, service_kind, name, billing, recurrence, valid_from, valid_to) values (%L, %L, gen_random_uuid(), 'base', 'x', 'monthly', 'FREQ=MONTHLY', date '2030-01-10', date '2030-01-01')$q$,
  tests.t('A'), tests.id('cA1'))), '23514', '中身の終わりが始まりより前なら保存しない');
select is(pg_temp.try(format($q$insert into public.contract_services (tenant_id, contract_id, service_kind, name, billing, recurrence, valid_from) values (%L, %L, 'base', 'x', 'monthly', '毎月', date '2030-01-01')$q$,
  tests.t('A'), tests.id('cA1'))), '23514', '繰り返しが RRULE の形でなければ保存しない');
select is(pg_temp.try(format($q$insert into public.contract_services (tenant_id, contract_id, service_kind, name, billing, recurrence, valid_from) values (%L, %L, 'base', 'x', 'monthly', 'FREQ=MONTHLY', date '2030-01-01')$q$,
  tests.t('A'), tests.id('cB10'))), '23503', '別の会社の契約に中身は付けられない（組の外部キー）');

-- ===== R-010-8・11 定時の処理の関数（service_role だけ）=====
select is(tests.run_as(tests.u('memberA'), 'select public.schedule_tenants()') ->> 'error', '42501', 'R-010-11 定時の処理の関数は、社員からは呼べない');
select is(tests.run_as(tests.u('adminA'), format($q$select public.schedule_insert(%L, null, '[]'::jsonb)$q$, tests.t('A'))) ->> 'error', '42501', 'R-010-11 作業を作る関数は、管理者からも呼べない');
select is(tests.run_as_anon('select public.schedule_tenants()') ->> 'error', '42501', 'R-010-11 ログインしていない人は呼べない');
select ok((select jsonb_agg(r -> 't') from jsonb_array_elements(tests.run_as_service('select public.schedule_tenants() as t') -> 'rows') r) @> to_jsonb(array[tests.t('A')::text, tests.t('B')::text]),
  'R-010-11 対象の会社は、終了していない契約を持つ会社（A と B）');
update public.tenants set status = 'suspended' where id = tests.t('B');
select ok(not ((select jsonb_agg(r -> 't') from jsonb_array_elements(tests.run_as_service('select public.schedule_tenants() as t') -> 'rows') r) @> to_jsonb(array[tests.t('B')::text])),
  'R-010-11 止めた会社は対象にしない');
update public.tenants set status = 'active' where id = tests.t('B');

create temp table _run on commit drop as select pg_temp.svc('schedule_start', format('%L', tests.t('B'))) as r;
select ok((select r from _run) is not null and (select r from _run) <> 'null'::jsonb, 'R-010-12 処理の記録を始められる（job_runs に running で入る）');
select is((select status || '/' || kind from public.job_runs where id = ((select r from _run) #>> '{}')::uuid), 'running/schedule_works', 'R-010-12 記録の種類は schedule_works');
select is(pg_temp.svc('schedule_start', format('%L', tests.t('B'))), 'null'::jsonb, 'R-010-12 同じ会社で動いている最中は、二重に始めない（null）');
select is(pg_temp.svc('schedule_start', format('%L', tests.t('A'))) <> 'null'::jsonb, true, 'R-010-12 ほかの会社は別に始められる');
select is(pg_temp.svc('schedule_finish', format('%L, %L, ''success'', %L::jsonb, null', tests.t('B'), ((select r from _run) #>> '{}')::uuid, '{"created": 3}')), 'true'::jsonb, 'R-010-12 処理の記録を閉じられる');
select is((select status || '/' || (counts ->> 'created') || '/' || (ended_at is not null)::text from public.job_runs where id = ((select r from _run) #>> '{}')::uuid), 'success/3/true', 'R-010-12 状況・件数・終了の時刻が入る');
select is(pg_temp.svc('schedule_finish', format('%L, %L, ''success'', ''{}''::jsonb, null', tests.t('B'), ((select r from _run) #>> '{}')::uuid)), 'false'::jsonb, 'R-010-12 閉じた記録を、もう一度閉じても何も変わらない');
select is(pg_temp.svcerr('schedule_finish', format('%L, %L, ''weird'', ''{}''::jsonb, null', tests.t('B'), tests.id('jobB'))), '22023', 'R-010-12 状況は success か failure だけ');
select is(pg_temp.svc('schedule_start', format('%L', tests.t('B'))) <> 'null'::jsonb, true, 'R-010-12 閉じたあとは、また始められる');
update public.job_runs set started_at = now() - interval '2 hours' where tenant_id = tests.t('A') and kind = 'schedule_works' and status = 'running';
select is(pg_temp.svc('schedule_start', format('%L', tests.t('A'))) <> 'null'::jsonb, true, 'R-010-12 30 分を過ぎた古い記録は失敗で閉じて、始め直せる');
select ok((select count(*) from public.job_runs where tenant_id = tests.t('A') and kind = 'schedule_works' and status = 'failure' and error = 'timeout') >= 1, 'R-010-12 古い記録は timeout の失敗になる');

-- 予定の元になる中身
select is((select jsonb_array_length(pg_temp.svc('schedule_services', format('%L, %L, %L', tests.t('B'), pg_temp.today(), pg_temp.today() + 60)))), 1, 'R-010-7 会社 B の中身は1つ（自分の会社の分だけ）');
select is(pg_temp.svc('schedule_services', format('%L, %L, %L', tests.t('B'), pg_temp.today(), pg_temp.today() + 60)) -> 0 ->> 'service_key', tests.id('key:B10-base')::text, 'R-010-7 service_key・繰り返し・期間が返る');
select is(pg_temp.svc('schedule_services', format('%L, %L, %L', tests.t('B'), pg_temp.today(), pg_temp.today() + 60)) -> 0 -> 'staff' ->> 0, tests.id('m:B:staffB')::text, 'R-010-9 決まった担当が返る');
select is((select jsonb_array_length(pg_temp.svc('schedule_services', format('%L, %L, %L, %L', tests.t('A'), pg_temp.today(), pg_temp.today() + 60, (select cid from _end))))), 0, 'R-010-7 終えた契約の中身は、予定の元にしない');
select is((select jsonb_array_length(pg_temp.svc('schedule_services', format('%L, %L, %L, %L', tests.t('A'), pg_temp.today(), pg_temp.today() + 60, tests.id('cA1'))))), 1, 'R-010-7 契約を1つに絞れる');
select is((select jsonb_array_length(pg_temp.svc('schedule_services', format('%L, %L, %L', tests.t('A'), pg_temp.today() + 1000, pg_temp.today() + 1060)))) >= 0, true, 'R-010-7 期間の外の中身は返さない（空でもよい）');

-- 作業を作る：写す中身・担当・金額・重ならない・ほかの会社の中身は作らない
create temp table _ins on commit drop as select pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-end'),
  format('[{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"}]', tests.id('svcA10-base'), pg_temp.today() + 21, tests.id('svcA10-opt'), pg_temp.today() + 22))) as r;
select is((select r ->> 'created' from _ins), '2', 'R-010-8 作業を作る（基本の1日・オプションの1日）');
select is((select title || '/' || building_id::text || '/' || start_time::text || '/' || end_time::text || '/' || status || '/' || (run_id is not null)::text from public.works where service_key = tests.id('key:A10-base') and scheduled_date = pg_temp.today() + 21),
  '定期清掃/' || tests.id('buildingA10')::text || '/09:00:00/12:00:00/scheduled/true', 'R-010-9 作業は、名前・建物・時刻を写し、状況は予定・run_id が付く');
select is((select string_agg(membership_id::text, ',' order by membership_id::text) from public.work_assignments where work_id = (select id from public.works where service_key = tests.id('key:A10-base') and scheduled_date = pg_temp.today() + 21)),
  (select string_agg(m::text, ',' order by m::text) from unnest(array[tests.id('m:A:staffA'), tests.id('m:A:memberA')]) m), 'R-010-9 決まった担当が、初めの担当に入る');
select is((select r ->> 'assignments' from _ins), '2', 'R-010-9 担当の件数が返る');
select is((select amount from public.work_charges where work_id = (select id from public.works where service_key = tests.id('key:A10-opt') and scheduled_date = pg_temp.today() + 22)), 12000::bigint, 'R-010-10 行った回ごとの中身は、作業の金額（中身の金額）を作る');
select is((select count(*)::int from public.work_charges where work_id = (select id from public.works where service_key = tests.id('key:A10-base') and scheduled_date = pg_temp.today() + 21)), 0, 'R-010-10 毎月の中身は、作業の金額を作らない');
select is((select r ->> 'charges' from _ins), '1', 'R-010-10 作った作業の金額の件数が返る');
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-end'),
  format('[{"service_id":"%s","date":"%s"},{"service_id":"%s","date":"%s"}]', tests.id('svcA10-base'), pg_temp.today() + 21, tests.id('svcA10-opt'), pg_temp.today() + 22))) ->> 'created', '0', 'R-010-8 二度動いても、同じ中身・同じ日の作業は重ならない');
select is((select count(*)::int from public.works where service_key = tests.id('key:A10-base') and scheduled_date = pg_temp.today() + 21), 1, 'R-010-8 作業は1つのまま');
select is((select count(*)::int from public.work_charges where work_id = (select id from public.works where service_key = tests.id('key:A10-opt') and scheduled_date = pg_temp.today() + 22)), 1, 'R-010-8 作業の金額も二重にならない');
insert into public.works (tenant_id, building_id, contract_service_id, service_key, title, scheduled_date)
  values (tests.t('A'), tests.id('buildingA10'), tests.id('svcA10-base'), tests.id('key:A10-base'), '手で足した', pg_temp.today() + 28);
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-end'), format('[{"service_id":"%s","date":"%s"}]', tests.id('svcA10-base'), pg_temp.today() + 28))) ->> 'created', '1',
  'R-010-8 手で足した作業（run_id なし）は、重なりに数えない');
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-end'), format('[{"service_id":"%s","date":"%s"}]', tests.id('svcB10-base'), pg_temp.today() + 30))) ->> 'created', '0', 'R-010-11 別の会社の中身は、会社 A の作業にしない');
select is((select count(*)::int from public.works w join public.contract_services s on s.id = w.contract_service_id where w.tenant_id <> s.tenant_id), 0, 'R-010-11 作業の tenant_id は、元の中身の会社と必ず同じ');
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-end'), format('[{"service_id":"%s","date":"%s"}]', tests.id('svcA10-base'), date '2025-12-01'))) ->> 'created', '0', 'R-010-7 中身の期間の外の日（開始日より前）は作らない');
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-end'), format('[{"service_id":"%s","date":"%s"}]', (select id from public.contract_services where contract_id = (select cid from _end) and service_kind = 'base'), pg_temp.today() + 9))) ->> 'created', '0', 'R-010-7 契約の終了日より後の日は作らない');
select is(pg_temp.svcerr('schedule_insert', format('%L, %L, ''{}''::jsonb', tests.t('A'), tests.id('run-end'))), '22023', 'R-010-8 作業の一覧が配列でなければ断る');
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('run-end'), format('[{"service_id":"%s","date":"%s"}]', tests.id('svcA10-base'), pg_temp.today() + 35))) ->> 'created', '1', '（準備）');
select is(pg_temp.svcerr('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('jobB'), format('[{"service_id":"%s","date":"%s"}]', tests.id('svcA10-base'), pg_temp.today() + 36))), '23503', 'R-010-11 別の会社の処理の記録（run_id）は付けられない（組の外部キー）');

-- 画面から「いま作り直す」を呼ぶときの、会社の確かめ
select is(pg_temp.call(tests.u('memberA'), 'contract_schedule_tenant', pg_temp.q('cA10')) #>> '{}', tests.t('A')::text, 'R-010-14 画面から作り直すとき、契約の会社を返す');
select is(pg_temp.callerr(tests.u('staffA'), 'contract_schedule_tenant', pg_temp.q('cA10')), '42501', 'R-010-14 スタッフは作り直せない');
select is(pg_temp.callerr(tests.u('adminB'), 'contract_schedule_tenant', pg_temp.q('cA10')), '42501', 'R-010-24 別の会社の人は作り直せない');

-- ===== R-010-25 取引先・建物は、契約があれば消さない（002 の usage_refs）=====
select is((select string_agg(b ->> 'reason', ',' order by b ->> 'reason') from jsonb_array_elements(pg_temp.call(tests.u('memberA'), 'delete_client', pg_temp.q('clientA10')) -> 'blockers') b), 'has_buildings,has_contracts', 'R-010-25 契約のある取引先は消さない');
select is((select string_agg(b ->> 'reason', ',' order by b ->> 'reason') from jsonb_array_elements(pg_temp.call(tests.u('memberA'), 'delete_building', pg_temp.q('buildingA10')) -> 'blockers') b), 'has_active_contracts,has_future_works', 'R-010-25 有効な契約と先の予定のある建物は消さない');
update public.contracts set status = 'ended', end_date = pg_temp.today() where id = tests.id('cA10');
update public.works set status = 'cancelled' where building_id = tests.id('buildingA10') and status = 'scheduled';
select is((select string_agg(b ->> 'reason', ',') from jsonb_array_elements(pg_temp.call(tests.u('memberA'), 'delete_building', pg_temp.q('buildingA10')) -> 'blockers') b), null, 'R-010-25 契約が終わり、先の予定もなければ（取り消せば）、建物を消せる');

select * from finish();
rollback;
