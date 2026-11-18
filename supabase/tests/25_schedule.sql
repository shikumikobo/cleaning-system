-- 機能 012：作業の予定と実績（R-012-1〜26）。表 work_records、開始・終了・行わず・取消・日時の変更・手で足す・入れ替えの RPC、
-- 重なり・予実・月ごとの集計の view。画面の部品と流れ（R-012-27〜34）は Vitest と e2e。
begin;
select * from no_plan();
select tests.seed();

select tests.make_user('staff2A');
select tests.make_member('A', 'staff2A', 'staff');

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
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
create or replace function pg_temp.q(p text) returns text language sql as $$ select quote_literal(tests.id(p)::text) $$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Tokyo')::date $$;
-- 作業を RLS を通らずに作る（担当は所属名の配列。run: 定時の処理が作ったものにする。建物は A10、元は svcA10-base）
create or replace function pg_temp.mkwork(p_name text, p_status text default 'scheduled', p_date date default null, p_start time default null, p_end time default null,
                                          p_members text[] default '{}', p_run boolean default false) returns uuid language plpgsql as $$
declare m text;
begin
  insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, start_time, end_time, status, run_id)
  values (tests.id(p_name), tests.t('A'), tests.id('buildingA10'), tests.id('svcA10-base'), tests.id('key:A10-base'), 'テスト作業：' || p_name,
          coalesce(p_date, pg_temp.today() + 1), p_start, p_end, p_status, case when p_run then tests.id('jobA') end);
  foreach m in array p_members loop
    insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('wa:' || p_name || ':' || m), tests.t('A'), tests.id(p_name), tests.id('m:A:' || m));
  end loop;
  return tests.id(p_name);
end $$;
create or replace function pg_temp.status(p_name text) returns text language sql as $$ select status from public.works where id = tests.id(p_name) $$;
create or replace function pg_temp.version(p_name text) returns int language sql as $$ select version from public.works where id = tests.id(p_name) $$;
create or replace function pg_temp.nrec(p_name text) returns bigint language sql as $$ select count(*) from public.work_records where work_id = tests.id(p_name) $$;
-- view は読む人の権限のまま（社内の人だけ）なので、社員 A として読む
create or replace function pg_temp.pa(p_work text, p_expr text) returns text language sql as $$
  select tests.run_as(tests.u('memberA'), format('select %s as v from public.work_plan_actual where work_id = %L', p_expr, tests.id(p_work))) -> 'rows' -> 0 ->> 'v'
$$;
create or replace function pg_temp.vn(p_view text, p_where text) returns bigint language sql as $$
  select tests.n(tests.u('memberA'), format('select 1 from public.%s where %s', p_view, p_where))
$$;
-- 開始・終了の呼び出し（引数は名前）
create or replace function pg_temp.start(p_uid uuid, p_rec text, p_work text, p_at text default 'null') returns jsonb language sql as $$
  select pg_temp.call(p_uid, 'start_work', format('%s, %s, %s', pg_temp.q(p_rec), pg_temp.q(p_work), p_at))
$$;
create or replace function pg_temp.finish(p_uid uuid, p_op text, p_work text, p_at text default 'null') returns jsonb language sql as $$
  select pg_temp.call(p_uid, 'finish_work', format('%s, %s, %s', pg_temp.q(p_op), pg_temp.q(p_work), p_at))
$$;

-- ===== R-012-26 種：012 の種の実績が、009・010・011 の種の件数を変えない =====
select is((select count(*) from public.works where tenant_id = tests.t('A')), 3::bigint, 'R-012-26 会社 A の作業は、010 の種の 3 件のまま');
select is((select count(*) from public.work_assignments where tenant_id = tests.t('A')), 2::bigint, 'R-012-26 会社 A の担当は、010 の種の 2 件のまま');
select is((select count(*) from public.work_records where tenant_id = tests.t('A')), 1::bigint, 'R-012-26 会社 A の実績の種は 1 件');
select is((select count(*) from public.work_records where tenant_id = tests.t('B')), 1::bigint, 'R-012-26 会社 B の実績の種は 1 件');
select is((select count(*) from public.reports where tenant_id = tests.t('A')), 1::bigint, 'R-012-26 009 の下書きの報告書（wA10）の件数は変わらない');

-- ===== R-012-1 実績の表 =====
select is((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'work_records'
           and column_name in ('work_id', 'membership_id', 'started_at', 'ended_at', 'start_lat', 'start_lng', 'end_lat', 'end_lng', 'distance_m', 'distance_warning', 'client_created_at', 'device_id', 'received_at')),
          13::bigint, 'R-012-1 実績は、作業・人・開始・終了・位置・距離と警告・端末の印・届いた時刻の列を持つ');
select pg_temp.mkwork('w1a', 'in_progress', null, null, null, array['staffA']);
select is(pg_temp.try(format($q$insert into public.work_records (tenant_id, work_id, membership_id, started_at, ended_at) values (%L, %L, %L, now(), now() - interval '1 hour')$q$, tests.t('A'), tests.id('w1a'), tests.id('m:A:staffA'))),
          '23514', 'R-012-1 終了は開始より前にならない');
select is(pg_temp.try(format($q$insert into public.work_records (tenant_id, work_id, membership_id, started_at) values (%L, %L, %L, now())$q$, tests.t('A'), tests.id('w1a'), tests.id('m:A:staffA'))),
          'ok', 'R-012-1 終わっていない実績を1つ作れる');
select is(pg_temp.try(format($q$insert into public.work_records (tenant_id, work_id, membership_id, started_at) values (%L, %L, %L, now())$q$, tests.t('A'), tests.id('w1a'), tests.id('m:A:staffA'))),
          '23505', 'R-012-1 同じ人の、終わっていない実績は、同時に1つだけ');
select is(pg_temp.try(format($q$insert into public.work_records (tenant_id, work_id, membership_id, started_at) values (%L, %L, %L, now())$q$, tests.t('B'), tests.id('w1a'), tests.id('m:B:staffB'))),
          '23503', 'R-012-1 別の会社の作業には、実績を作れない（組の外部キー）');

-- ===== R-012-2 開始 =====
select pg_temp.mkwork('w2a', 'scheduled', null, null, null, array['staffA', 'staff2A']);
select is(pg_temp.start(tests.u('staffA'), 'r2a', 'w2a') ->> 'ok', 'true', 'R-012-2 担当のスタッフが開始できる');
select is(pg_temp.status('w2a') || ',' || pg_temp.version('w2a'), 'in_progress,2', 'R-012-2 作業は実施中になり、版が 1 上がる');
select is((select membership_id from public.work_records where id = tests.id('r2a')), tests.id('m:A:staffA'), 'R-012-2 実績は、自分の所属で作られる');
select is((select count(*) from public.work_records where id = tests.id('r2a') and client_created_at is not null and received_at is not null), 1::bigint, 'R-012-2 端末の時刻と届いた時刻が入る');
select is(pg_temp.start(tests.u('staffA'), 'r2a', 'w2a') ->> 'already', 'true', 'R-012-2 同じ uuid の二度目は already を返す');
select is(pg_temp.nrec('w2a') || ',' || pg_temp.version('w2a'), '1,2', 'R-012-2 二度目は、実績も版も増やさない');
select is(pg_temp.start(tests.u('staff2A'), 'r2b', 'w2a', quote_literal('2030-01-01 09:03:00+09')) ->> 'ok', 'true', 'R-012-2 もう1人の担当も、続けて開始できる（実施中のまま）');
select is((select started_at from public.work_records where id = tests.id('r2b')), timestamptz '2030-01-01 09:03:00+09', 'R-012-2 開始の時刻は、端末の時刻を使う');
select is(pg_temp.status('w2a') || ',' || pg_temp.version('w2a'), 'in_progress,2', 'R-012-2 すでに実施中なら、状況も版も変えない');

-- ===== R-012-3 開始できない =====
select pg_temp.mkwork('w3a', 'scheduled', null, null, null, array['staffA']);
select is(pg_temp.callerr(tests.u('staff2A'), 'start_work', format('%s, %s, null', pg_temp.q('r3x'), pg_temp.q('w3a'))), '42501', 'R-012-3 担当でないスタッフは開始できない');
select is(pg_temp.callerr(tests.u('memberA'), 'start_work', format('%s, %s, null', pg_temp.q('r3x'), pg_temp.q('w3a'))), '42501', 'R-012-3 担当でない社員も開始できない');
select is(pg_temp.callerr(tests.u('extA'), 'start_work', format('%s, %s, null', pg_temp.q('r3x'), pg_temp.q('w3a'))), '42501', 'R-012-3 外部の人は開始できない');
select is(pg_temp.callerr(tests.u('adminB'), 'start_work', format('%s, %s, null', pg_temp.q('r3x'), pg_temp.q('w3a'))), '42501', 'R-012-3 別の会社の人は開始できない');
select is(pg_temp.callerr(tests.u('nobody'), 'start_work', format('%s, %s, null', pg_temp.q('r3x'), pg_temp.q('w3a'))), '42501', 'R-012-3 どこにも属さない人は開始できない');
select is(tests.run_as_anon(format('select public.start_work(%s, %s, null)', pg_temp.q('r3x'), pg_temp.q('w3a'))) ->> 'error', '42501', 'R-012-3 ログインしていない人は開始できない');
select is(pg_temp.callerr(tests.u('staffA'), 'start_work', format('%s, %L, null', pg_temp.q('r3x'), gen_random_uuid())), '42501', 'R-012-3 存在しない作業は、権限がないのと同じ扱い');
select pg_temp.mkwork('w3d', 'done', null, null, null, array['staffA']);
select pg_temp.mkwork('w3s', 'skipped', null, null, null, array['staffA']);
select pg_temp.mkwork('w3c', 'cancelled', null, null, null, array['staffA']);
select is(pg_temp.start(tests.u('staffA'), 'r3d', 'w3d') ->> 'reason', 'not_startable', 'R-012-3 完了した作業は開始できない');
select is(pg_temp.start(tests.u('staffA'), 'r3s', 'w3s') ->> 'reason', 'not_startable', 'R-012-3 行わずの作業は開始できない');
select is(pg_temp.start(tests.u('staffA'), 'r3c', 'w3c') ->> 'reason', 'not_startable', 'R-012-3 取消の作業は開始できない');
select is(pg_temp.start(tests.u('staffA'), 'r3a', 'w3a') ->> 'ok', 'true', 'R-012-3 （前提）担当は開始できる');
select is(pg_temp.start(tests.u('staffA'), 'r3b', 'w3a') ->> 'reason', 'already_started', 'R-012-3 自分の終わっていない実績があれば、別の uuid では開始できない');
select is(pg_temp.callerr(tests.u('staff2A'), 'start_work', format('%s, %s, null', pg_temp.q('r3a'), pg_temp.q('w3a'))), '42501', 'R-012-3 ほかの人の実績の uuid を使い回して、作業に触れることはできない');
select is(pg_temp.nrec('w3d') + pg_temp.nrec('w3s') + pg_temp.nrec('w3c'), 0::bigint, 'R-012-3 断ったときは、実績を作らない');

-- ===== R-012-4・5 終了 =====
select pg_temp.mkwork('w4a', 'scheduled', null, null, null, array['staffA', 'staff2A']);
select pg_temp.start(tests.u('staffA'), 'r4a', 'w4a', quote_literal(now() - interval '2 hours'));
select pg_temp.start(tests.u('staff2A'), 'r4b', 'w4a', quote_literal(now() - interval '2 hours'));
select is(pg_temp.finish(tests.u('staffA'), 'op4a', 'w4a') ->> 'ok', 'true', 'R-012-4 担当が終了できる');
select is((select ended_at is not null from public.work_records where id = tests.id('r4a')), true, 'R-012-4 自分の実績に終了の時刻が入る');
select is(pg_temp.status('w4a'), 'in_progress', 'R-012-4 ほかの人がまだ作業中なら、作業は実施中のまま');
select is(pg_temp.finish(tests.u('staffA'), 'op4a2', 'w4a') ->> 'already', 'true', 'R-012-4 もう一度終了しても、何も変えず already を返す');
select is(pg_temp.finish(tests.u('staff2A'), 'op4b', 'w4a', quote_literal(now())) ->> 'ok', 'true', 'R-012-4 最後の人が終了できる');
select is(pg_temp.status('w4a'), 'done', 'R-012-4 開いた実績がなくなれば、作業は完了になる');
select is(pg_temp.version('w4a'), 3, 'R-012-4 開始で 2、完了で 3（版が上がる）');
select is((select ended_at from public.work_records where id = tests.id('r4b')) >= (select started_at from public.work_records where id = tests.id('r4b')), true, 'R-012-4 終了は開始以後');
select pg_temp.mkwork('w5a', 'scheduled', null, null, null, array['staffA', 'staff2A']);
select is(pg_temp.finish(tests.u('staff2A'), 'op5a', 'w5a') ->> 'reason', 'not_started', 'R-012-5 開始していなければ終了できない');
select pg_temp.start(tests.u('staffA'), 'r5a', 'w5a', quote_literal(now()));
select is(pg_temp.finish(tests.u('staffA'), 'op5b', 'w5a', quote_literal(now() - interval '1 hour')) ->> 'reason', 'end_before_start', 'R-012-5 終了が開始より前なら終えない');
select is((select ended_at is null from public.work_records where id = tests.id('r5a')), true, 'R-012-5 断ったときは、実績を変えない');
select is(pg_temp.finish(tests.u('staff2A'), 'op5c', 'w5a') ->> 'reason', 'not_started', 'R-012-5 ほかの人の実績は終えられない（自分の実績がない）');
select is(pg_temp.callerr(tests.u('memberA'), 'finish_work', format('%s, %s, null', pg_temp.q('op5d'), pg_temp.q('w5a'))), '42501', 'R-012-5 担当でない社員は終了できない');
select is(pg_temp.callerr(tests.u('extA'), 'finish_work', format('%s, %s, null', pg_temp.q('op5e'), pg_temp.q('w5a'))), '42501', 'R-012-5 外部の人は終了できない');
select is(pg_temp.callerr(tests.u('adminB'), 'finish_work', format('%s, %s, null', pg_temp.q('op5f'), pg_temp.q('w5a'))), '42501', 'R-012-5 別の会社の人は終了できない');
select is(pg_temp.status('w5a'), 'in_progress', 'R-012-5 断ったあとも、作業は実施中のまま');

-- ===== R-012-6 実績を読める人・直接書けない =====
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.work_records where work_id = %L$q$, tests.id('w4a'))), 1::bigint, 'R-012-6 スタッフは、自分の実績だけ読める（同じ作業のほかの人の分は読めない）');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.work_records where work_id = %L$q$, tests.id('w4a'))), 2::bigint, 'R-012-6 work.assign を持つ社員は、全員の実績を読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.work_records'), 0::bigint, 'R-012-6 外部の人は実績を読めない');
select is(tests.n(tests.u('adminB'), format($q$select 1 from public.work_records where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-012-6 別の会社の人は読めない');
select is(tests.run_as_anon('select 1 from public.work_records') ->> 'error', '42501', 'R-012-6 ログインしていない人は読めない');
select is(tests.err(tests.u('staffA'), format($q$insert into public.work_records (tenant_id, work_id, membership_id, started_at) values (%L, %L, %L, now())$q$, tests.t('A'), tests.id('w3d'), tests.id('m:A:staffA'))), '42501', 'R-012-6 実績は、画面や API から直接作れない');
select is(tests.err(tests.u('staffA'), format($q$update public.work_records set ended_at = now() where id = %L$q$, tests.id('r5a'))), '42501', 'R-012-6 実績は、直接直せない');
select is(tests.err(tests.u('memberA'), format($q$delete from public.work_records where id = %L$q$, tests.id('r5a'))), '42501', 'R-012-6 実績は、直接消せない');

-- ===== R-012-7 行わず =====
select pg_temp.mkwork('w7a', 'scheduled', null, null, null, array['staffA']);
select is(pg_temp.call(tests.u('memberA'), 'skip_work', format('%s, %s', pg_temp.q('w7a'), pg_temp.version('w7a'))) ->> 'ok', 'true', 'R-012-7 社員が予定の作業を「行わず」にできる');
select is(pg_temp.status('w7a') || ',' || pg_temp.version('w7a'), 'skipped,2', 'R-012-7 状況が行わずになり、版が 1 上がる');
select is(pg_temp.call(tests.u('memberA'), 'skip_work', format('%s', pg_temp.q('w7a'))) ->> 'already', 'true', 'R-012-7 すでに行わずなら already');
select is(pg_temp.call(tests.u('memberA'), 'skip_work', format('%s', pg_temp.q('w2a'))) ->> 'reason', 'not_scheduled', 'R-012-7 実施中の作業は「行わず」にできない');
select pg_temp.mkwork('w7b', 'scheduled', null, null, null, array['staffA']);
select is(pg_temp.callerr(tests.u('staffA'), 'skip_work', format('%s', pg_temp.q('w7b'))), '42501', 'R-012-7 スタッフは「行わず」にできない');
select is(pg_temp.callerr(tests.u('extA'), 'skip_work', format('%s', pg_temp.q('w7b'))), '42501', 'R-012-7 外部の人は「行わず」にできない');
select is(pg_temp.callerr(tests.u('adminB'), 'skip_work', format('%s', pg_temp.q('w7b'))), '42501', 'R-012-7 別の会社の人は「行わず」にできない');
select is(pg_temp.status('w7b'), 'scheduled', 'R-012-7 断ったあとも、予定のまま');

-- ===== R-012-8 取消 =====
select pg_temp.mkwork('w8a', 'scheduled', pg_temp.today() + 20, time '09:00', time '10:00', array['staffA'], true);
select is(pg_temp.call(tests.u('memberA'), 'cancel_work', format('%s', pg_temp.q('w8a'))) ->> 'ok', 'true', 'R-012-8 社員が予定の作業を取り消せる');
select is(pg_temp.status('w8a') || ',' || (select deleted_at is null from public.works where id = tests.id('w8a'))::text || ',' || pg_temp.version('w8a'), 'cancelled,true,2', 'R-012-8 行は残り（deleted_at なし）、版が 1 上がる');
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('jobA'), jsonb_build_array(jsonb_build_object('service_id', tests.id('svcA10-base'), 'date', pg_temp.today() + 20))::text)) ->> 'created', '0',
          'R-012-8 定時の処理は、取り消した日の作業を作り直さない');
select is(pg_temp.call(tests.u('memberA'), 'cancel_work', format('%s', pg_temp.q('w8a'))) ->> 'already', 'true', 'R-012-8 すでに取消なら already');
select is(pg_temp.call(tests.u('memberA'), 'cancel_work', format('%s', pg_temp.q('w2a'))) ->> 'reason', 'not_scheduled', 'R-012-8 実施中の作業は取り消せない');
select pg_temp.mkwork('w8b', 'scheduled', null, null, null, array['staffA']);
insert into public.invoices (id, tenant_id, client_id, period, tax_rate) values (tests.id('inv8'), tests.t('A'), tests.id('clientA10'), date '2041-01-01', 0.1);
insert into public.invoice_lines (tenant_id, invoice_id, work_id, name, qty, unit_price, sort) values (tests.t('A'), tests.id('inv8'), tests.id('w8b'), '載った作業', 1, 5000, 1);
select is(pg_temp.call(tests.u('memberA'), 'cancel_work', format('%s', pg_temp.q('w8b'))) ->> 'reason', 'invoiced', 'R-012-8 請求書に載った作業の金額があれば、取り消せない');
select is(pg_temp.callerr(tests.u('staffA'), 'cancel_work', format('%s', pg_temp.q('w7b'))), '42501', 'R-012-8 スタッフは取り消せない');
select is(pg_temp.callerr(tests.u('adminB'), 'cancel_work', format('%s', pg_temp.q('w7b'))), '42501', 'R-012-8 別の会社の人は取り消せない');
select is(pg_temp.callerr(tests.u('extA'), 'cancel_work', format('%s', pg_temp.q('w7b'))), '42501', 'R-012-8 外部の人は取り消せない');

-- ===== R-012-9・10 日時の変更・版 =====
select pg_temp.mkwork('w9a', 'scheduled', pg_temp.today() + 30, time '09:00', time '10:00', array['staffA']);
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', format('%s, %s, %L, %L, %L', pg_temp.q('w9a'), pg_temp.version('w9a'), pg_temp.today() + 31, '13:00', '15:30')) ->> 'ok', 'true', 'R-012-9 社員が、予定の作業の日付と時刻を動かせる');
select is((select scheduled_date || ' ' || start_time || '-' || end_time from public.works where id = tests.id('w9a')), (pg_temp.today() + 31)::text || ' 13:00:00-15:30:00', 'R-012-9 日付と時刻が変わる');
select is(pg_temp.version('w9a'), 2, 'R-012-9 版が 1 上がる');
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', format('%s, %s, %L, %L, %L', pg_temp.q('w9a'), 1, pg_temp.today() + 32, '13:00', '15:30')) ->> 'reason', 'conflict', 'R-012-9 古い版からの変更は conflict');
select is((select scheduled_date from public.works where id = tests.id('w9a')), pg_temp.today() + 31, 'R-012-9 conflict のときは、変えない');
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', format('%s, %s, %L, %L, %L', pg_temp.q('w9a'), 2, pg_temp.today() + 31, '15:00', '14:00')) ->> 'reason', 'invalid_time', 'R-012-9 終了が開始より前なら invalid_time');
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', format('%s, %s, null, null, null', pg_temp.q('w9a'), 2)) ->> 'reason', 'date_required', 'R-012-9 日付がなければ date_required');
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', format('%s, null, %L, null, null', pg_temp.q('w2a'), pg_temp.today() + 5)) ->> 'reason', 'not_scheduled', 'R-012-9 予定でない作業は動かせない');
select is(pg_temp.callerr(tests.u('staffA'), 'reschedule_work', format('%s, null, %L, null, null', pg_temp.q('w9a'), pg_temp.today() + 5)), '42501', 'R-012-9 スタッフは動かせない');
-- 定時の処理が作った作業を動かす：元の日は作り直さない・動かした先に同じ中身があれば duplicate_date
select pg_temp.mkwork('w9g1', 'scheduled', pg_temp.today() + 40, null, null, '{}', true);
select pg_temp.mkwork('w9g2', 'scheduled', pg_temp.today() + 41, null, null, '{}', true);
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', format('%s, null, %L, null, null', pg_temp.q('w9g1'), pg_temp.today() + 42)) ->> 'ok', 'true', 'R-012-9 定時の処理が作った作業も動かせる');
select is(pg_temp.svc('schedule_insert', format('%L, %L, %L::jsonb', tests.t('A'), tests.id('jobA'), jsonb_build_array(jsonb_build_object('service_id', tests.id('svcA10-base'), 'date', pg_temp.today() + 40))::text)) ->> 'created', '0',
          'R-012-9 動かした元の日は、定時の処理が作り直さない');
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', format('%s, null, %L, null, null', pg_temp.q('w9g2'), pg_temp.today() + 42)) ->> 'reason', 'duplicate_date', 'R-012-9 動かした先に同じ中身の作業があれば duplicate_date');
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', format('%s, null, %L, null, null', pg_temp.q('w9g1'), pg_temp.today() + 40)) ->> 'ok', 'true', 'R-012-9 元の日に戻せる');
select is((select moved_from from public.works where id = tests.id('w9g1')), '{}'::date[], 'R-012-9 元の日に戻したら、作り直さない日の印も消える');
select ok((select count(*) from public.audit_logs where table_name = 'works' and action = 'update' and source = 'rpc' and changed ? 'status') >= 4, 'R-012-10 状況を変えたことが、source が rpc で履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'works' and action = 'update' and source = 'rpc' and changed ? 'scheduled_date') >= 1, 'R-012-10 日付を動かしたことが履歴に残る');
select is(pg_temp.call(tests.u('memberA'), 'skip_work', format('%s, %s', pg_temp.q('w7b'), 99)) ->> 'reason', 'conflict', 'R-012-10 行わずも、古い版なら conflict');
select is(pg_temp.call(tests.u('memberA'), 'cancel_work', format('%s, %s', pg_temp.q('w7b'), 99)) ->> 'reason', 'conflict', 'R-012-10 取消も、古い版なら conflict');
select is(pg_temp.status('w7b'), 'scheduled', 'R-012-10 conflict のときは、状況を変えない');

-- ===== R-012-11・12 手で作業を足す =====
insert into public.requests (id, tenant_id, client_id, building_id, title, status) values
  (tests.id('req12'), tests.t('A'), tests.id('clientA10'), tests.id('buildingA10'), '臨時の窓清掃', 'new'),
  (tests.id('req12-done'), tests.t('A'), tests.id('clientA10'), tests.id('buildingA10'), '終わった案件', 'done'),
  (tests.id('req12-B'), tests.t('B'), tests.id('clientB10'), tests.id('buildingB10'), 'B の案件', 'new');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cw1'), pg_temp.today() + 10, pg_temp.q('svcA10-base'), format('{%s}', tests.id('m:A:staffA')))) ->> 'ok', 'true',
          'R-012-11 契約の中身を選んで、作業を足せる');
select is((select building_id || '/' || title || '/' || start_time || '/' || end_time || '/' || status || '/' || (run_id is null)::text from public.works where id = tests.id('cw1')),
          tests.id('buildingA10') || '/定期清掃/09:00:00/12:00:00/scheduled/true', 'R-012-11 建物・名前・時刻を中身から写す。手で足した作業（run_id なし）になる');
select is((select count(*) from public.work_assignments where work_id = tests.id('cw1') and membership_id = tests.id('m:A:staffA') and deleted_at is null), 1::bigint, 'R-012-11 初めの担当が付く');
select is((select count(*) from public.work_charges where work_id = tests.id('cw1')), 0::bigint, 'R-012-11 毎月請求の中身は、作業の金額を作らない');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, %L, %L, %s, null, null, %L::uuid[]', pg_temp.q('cw2'), pg_temp.today() + 10, '14:00', '15:00', pg_temp.q('svcA10-opt'), '{}')) ->> 'ok', 'true', 'R-012-11 行った回ごとの中身で足せる');
select is((select amount from public.work_charges where work_id = tests.id('cw2')), 12000::bigint, 'R-012-11 行った回ごとの中身は、作業の金額（中身の金額）も作る');
select is((select start_time || '-' || end_time from public.works where id = tests.id('cw2')), '14:00:00-15:00:00', 'R-012-11 時刻を渡せば、その時刻になる');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, null, %s, %L, %L::uuid[]', pg_temp.q('cw3'), pg_temp.today() + 11, pg_temp.q('req12'), '臨時の窓', '{}')) ->> 'ok', 'true', 'R-012-11 案件を選んで、作業を足せる');
select is((select building_id || '/' || title || '/' || (contract_service_id is null)::text || '/' || (request_id = tests.id('req12'))::text from public.works where id = tests.id('cw3')), tests.id('buildingA10') || '/臨時の窓/true/true', 'R-012-11 案件の建物を写し、名前は渡した名前になる');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cw1'), pg_temp.today() + 10, pg_temp.q('svcA10-base'), '{}')) ->> 'already', 'true', 'R-012-11 同じ uuid の二度目は already');
select is((select count(*) from public.works where id = tests.id('cw1')), 1::bigint, 'R-012-11 二度目は増やさない');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, null, null, null, %L::uuid[]', pg_temp.q('cw4'), pg_temp.today() + 10, '{}')) ->> 'reason', 'source_required', 'R-012-11 どちらも選ばなければ source_required');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, %s, %s, null, %L::uuid[]', pg_temp.q('cw4'), pg_temp.today() + 10, pg_temp.q('svcA10-base'), pg_temp.q('req12'), '{}')) ->> 'reason', 'source_required', 'R-012-11 両方選んでも source_required');
select is((select count(*) from public.works where id = tests.id('cw4')), 0::bigint, 'R-012-11 断ったときは、作業を作らない');
-- 作れない
insert into public.contracts (id, tenant_id, client_id, building_id, source, quote_id, kind, start_date, end_date, status) values
  (tests.id('cEnd'), tests.t('A'), tests.id('clientA10'), tests.id('buildingA10'), 'import', null, 'recurring', date '2025-01-01', date '2025-06-30', 'ended');
insert into public.contract_services (id, tenant_id, contract_id, service_key, service_kind, name, amount, billing, recurrence, valid_from) values
  (tests.id('svcEnd'), tests.t('A'), tests.id('cEnd'), tests.id('key:end'), 'base', '終わった契約', 1000, 'monthly', 'FREQ=WEEKLY;BYDAY=MO', date '2025-01-01');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cw5'), date '2025-03-01', pg_temp.q('svcEnd'), '{}')) ->> 'reason', 'contract_ended', 'R-012-12 終わった契約の中身は contract_ended');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cw6'), date '2025-12-01', pg_temp.q('svcA10-base'), '{}')) ->> 'reason', 'out_of_contract', 'R-012-12 契約の期間より前の日付は out_of_contract');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, null, %s, null, %L::uuid[]', pg_temp.q('cw7'), pg_temp.today() + 10, pg_temp.q('req12-done'), '{}')) ->> 'reason', 'request_closed', 'R-012-12 完了した案件は request_closed');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, %L, %L, %s, null, null, %L::uuid[]', pg_temp.q('cw8'), pg_temp.today() + 10, '15:00', '14:00', pg_temp.q('svcA10-base'), '{}')) ->> 'reason', 'invalid_time', 'R-012-12 終了が開始より前なら invalid_time');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cw9'), pg_temp.today() + 10, pg_temp.q('svcA10-base'), format('{%s}', tests.id('m:A:extA')))) ->> 'reason', 'invalid_member', 'R-012-12 外部の人は担当にできない（invalid_member）');
select is(pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cw9'), pg_temp.today() + 10, pg_temp.q('svcA10-base'), format('{%s}', tests.id('m:B:staffB')))) ->> 'reason', 'invalid_member', 'R-012-12 別の会社の所属は担当にできない');
select is((select count(*) from public.works where id in (tests.id('cw5'), tests.id('cw6'), tests.id('cw7'), tests.id('cw8'), tests.id('cw9'))), 0::bigint, 'R-012-12 断ったときは、作業を作らない');
select is(pg_temp.callerr(tests.u('staffA'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cwx'), pg_temp.today() + 10, pg_temp.q('svcA10-base'), '{}')), '42501', 'R-012-12 スタッフは作業を足せない');
select is(pg_temp.callerr(tests.u('extA'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cwx'), pg_temp.today() + 10, pg_temp.q('svcA10-base'), '{}')), '42501', 'R-012-12 外部の人は作業を足せない');
select is(pg_temp.callerr(tests.u('adminB'), 'create_work', format('%s, %L, null, null, %s, null, null, %L::uuid[]', pg_temp.q('cwx'), pg_temp.today() + 10, pg_temp.q('svcA10-base'), '{}')), '42501', 'R-012-12 別の会社の中身では、作業を足せない');
select is(pg_temp.callerr(tests.u('adminA'), 'create_work', format('%s, %L, null, null, null, %s, null, %L::uuid[]', pg_temp.q('cwx'), pg_temp.today() + 10, pg_temp.q('req12-B'), '{}')), '42501', 'R-012-12 別の会社の案件では、作業を足せない');
select is((select count(*) from public.works where id = tests.id('cwx')), 0::bigint, 'R-012-12 権限がなければ、作業を作らない');
-- 手で足した作業は、契約の変更で取り消されない（010。run_id がないので対象外）
select is((select count(*) from public.works where id in (tests.id('cw1'), tests.id('cw2'), tests.id('cw3')) and run_id is not null), 0::bigint, 'R-012-12 手で足した作業には run_id が付かない（契約の変更で取り消されない）');

-- ===== R-012-13 担当を付ける・外す =====
select pg_temp.mkwork('w13', 'scheduled', null, null, null, array['staffA']);
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.work_assignments where work_id = %L$q$, tests.id('w13'))), 1::bigint, 'R-012-13 スタッフは自分の担当の行を読める');
select is(tests.n(tests.u('staff2A'), format($q$select 1 from public.work_assignments where work_id = %L$q$, tests.id('w13'))), 0::bigint, 'R-012-13 スタッフはほかの人の担当の行を読めない');
select is(tests.err(tests.u('staffA'), format($q$insert into public.work_assignments (tenant_id, work_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('w13'), tests.id('m:A:staff2A'))), '42501', 'R-012-13 スタッフは担当を付けられない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.work_assignments (tenant_id, work_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('w13'), tests.id('m:A:staff2A'))), null, 'R-012-13 社員は担当を付けられる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.work_assignments set deleted_at = now() where work_id = %L and membership_id = %L$q$, tests.id('w13'), tests.id('m:A:staff2A'))), 1::bigint, 'R-012-13 社員は担当を外せる（論理削除）');
select is(tests.err(tests.u('memberA'), format($q$insert into public.work_assignments (tenant_id, work_id, membership_id) values (%L, %L, %L)$q$, tests.t('A'), tests.id('w13'), tests.id('m:A:extA'))), '42501', 'R-012-13 外部の人は担当にできない');

-- ===== R-012-14 担当の入れ替え =====
select pg_temp.mkwork('w14', 'scheduled', null, null, null, array['staffA']);
select is(pg_temp.call(tests.u('memberA'), 'swap_assignment', format('%s, %s, %s', pg_temp.q('w14'), pg_temp.q('m:A:staffA'), pg_temp.q('m:A:staff2A'))) ->> 'ok', 'true', 'R-012-14 担当を別の人に入れ替えられる');
select is((select string_agg(membership_id::text, ',') from public.work_assignments where work_id = tests.id('w14') and deleted_at is null), tests.id('m:A:staff2A')::text, 'R-012-14 外した人は担当でなくなり、付けた人が担当になる');
select is(pg_temp.call(tests.u('memberA'), 'swap_assignment', format('%s, %s, %s', pg_temp.q('w14'), pg_temp.q('m:A:staffA'), pg_temp.q('m:A:memberA'))) ->> 'reason', 'not_assigned', 'R-012-14 外す人が担当でなければ not_assigned');
select pg_temp.mkwork('w14b', 'scheduled', null, null, null, array['staffA', 'staff2A']);
select is(pg_temp.call(tests.u('memberA'), 'swap_assignment', format('%s, %s, %s', pg_temp.q('w14b'), pg_temp.q('m:A:staffA'), pg_temp.q('m:A:staff2A'))) ->> 'reason', 'already_assigned', 'R-012-14 付ける人がすでに担当なら already_assigned');
select is(pg_temp.call(tests.u('memberA'), 'swap_assignment', format('%s, %s, %s', pg_temp.q('w14b'), pg_temp.q('m:A:staffA'), pg_temp.q('m:A:extA'))) ->> 'reason', 'invalid_member', 'R-012-14 社内の人でなければ invalid_member');
select is(pg_temp.call(tests.u('memberA'), 'swap_assignment', format('%s, %s, %s', pg_temp.q('w3d'), pg_temp.q('m:A:staffA'), pg_temp.q('m:A:staff2A'))) ->> 'reason', 'work_closed', 'R-012-14 完了した作業は work_closed');
select is(pg_temp.call(tests.u('memberA'), 'swap_assignment', format('%s, %s, %s', pg_temp.q('w5a'), pg_temp.q('m:A:staffA'), pg_temp.q('m:A:memberA'))) ->> 'reason', 'has_record', 'R-012-14 外す人の実績がすでにあれば has_record');
select is(pg_temp.callerr(tests.u('staffA'), 'swap_assignment', format('%s, %s, %s', pg_temp.q('w14b'), pg_temp.q('m:A:staffA'), pg_temp.q('m:A:memberA'))), '42501', 'R-012-14 スタッフは入れ替えられない');
select is(pg_temp.callerr(tests.u('adminB'), 'swap_assignment', format('%s, %s, %s', pg_temp.q('w14b'), pg_temp.q('m:A:staffA'), pg_temp.q('m:A:memberA'))), '42501', 'R-012-14 別の会社の人は入れ替えられない');

-- ===== R-012-15 担当にできる人の一覧 =====
select is((select string_agg(distinct r ->> 'role_code', ',' order by r ->> 'role_code') from jsonb_array_elements(tests.run_as(tests.u('memberA'), format('select * from public.work_staff(%L)', tests.t('A'))) -> 'rows') r), 'admin,member,staff', 'R-012-15 社員は、担当にできる人（社内）の一覧を読める。外部の人は出ない');
select is(jsonb_array_length(tests.run_as(tests.u('memberA'), format('select * from public.work_staff(%L)', tests.t('A'))) -> 'rows') >= 5, true, 'R-012-15 一覧には、所属・表示名・役割が入る');
select is(tests.err(tests.u('staffA'), format('select * from public.work_staff(%L)', tests.t('A'))), '42501', 'R-012-15 スタッフは読めない');
select is(tests.err(tests.u('extA'), format('select * from public.work_staff(%L)', tests.t('A'))), '42501', 'R-012-15 外部の人は読めない');
select is(tests.err(tests.u('adminB'), format('select * from public.work_staff(%L)', tests.t('A'))), '42501', 'R-012-15 別の会社の人は読めない');

-- ===== R-012-16 重なり =====
-- 2031-05-10：スタッフ A に 9-11・10-12（重なる）、12-13（11-12 と隣り合うだけ）、時刻なし、行わず（10-11）、スタッフ 2A に 9-10
select pg_temp.mkwork('o1', 'scheduled', date '2031-05-10', time '09:00', time '11:00', array['staffA']);
select pg_temp.mkwork('o2', 'scheduled', date '2031-05-10', time '10:00', time '12:00', array['staffA']);
select pg_temp.mkwork('o3', 'scheduled', date '2031-05-10', time '12:00', time '13:00', array['staffA']);
select pg_temp.mkwork('o4', 'scheduled', date '2031-05-10', null, null, array['staffA']);
select pg_temp.mkwork('o5', 'skipped', date '2031-05-10', time '10:00', time '11:00', array['staffA']);
select pg_temp.mkwork('o6', 'scheduled', date '2031-05-10', time '09:00', time '10:00', array['staff2A']);
select is(pg_temp.vn('work_overlaps', 'scheduled_date = date ''2031-05-10'''), 2::bigint, 'R-012-16 同じ人の重なる2つの作業が出る（各作業から見て相手が1つずつ）');
select is(pg_temp.vn('work_overlaps', format('work_id = %L and other_work_id = %L and membership_id = %L', tests.id('o1'), tests.id('o2'), tests.id('m:A:staffA'))), 1::bigint, 'R-012-16 o1 の相手は o2');
select is(pg_temp.vn('work_overlaps', format('work_id in (%1$L, %2$L, %3$L, %4$L) or other_work_id in (%1$L, %2$L, %3$L, %4$L)', tests.id('o3'), tests.id('o4'), tests.id('o5'), tests.id('o6'))), 0::bigint,
          'R-012-16 隣り合う・時刻のない・行わず・別の人の作業は、重ならない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.work_overlaps where scheduled_date = date ''2031-05-10'''), 2::bigint, 'R-012-16 スタッフは、自分の分の重なりを読める');
select is(tests.n(tests.u('staff2A'), 'select 1 from public.work_overlaps where scheduled_date = date ''2031-05-10'''), 0::bigint, 'R-012-16 ほかの人の分は読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.work_overlaps'), 0::bigint, 'R-012-16 外部の人は読めない');
select is(tests.run_as_anon('select 1 from public.work_overlaps') ->> 'error', '42501', 'R-012-16 ログインしていない人は読めない');

-- ===== R-012-17 担当を付ける前の確かめ =====
select is((select string_agg(r ->> 'work_id', ',') from jsonb_array_elements(tests.run_as(tests.u('memberA'), format('select * from public.assign_conflicts(%L, %L)', tests.id('o1'), tests.id('m:A:staffA'))) -> 'rows') r), tests.id('o2')::text,
          'R-012-17 担当の候補（スタッフ A）の同じ日の、時刻が重なる別の作業を調べられる');
select is(jsonb_array_length(tests.run_as(tests.u('memberA'), format('select * from public.assign_conflicts(%L, %L)', tests.id('o3'), tests.id('m:A:staffA'))) -> 'rows'), 0, 'R-012-17 重なりがなければ空');
select is(tests.err(tests.u('staffA'), format('select * from public.assign_conflicts(%L, %L)', tests.id('o1'), tests.id('m:A:staffA'))), '42501', 'R-012-17 スタッフは調べられない');
select is(tests.err(tests.u('adminB'), format('select * from public.assign_conflicts(%L, %L)', tests.id('o1'), tests.id('m:A:staffA'))), '42501', 'R-012-17 別の会社の人は調べられない');

-- ===== R-012-18〜22 予実 =====
-- 18：取消を除く・金額の列がない・見える範囲
select is(pg_temp.vn('work_plan_actual', format('work_id = %L', tests.id('w8a'))), 0::bigint, 'R-012-18 取消の作業は出ない');
select is(pg_temp.vn('work_plan_actual', format('work_id = %L', tests.id('w2a'))), 1::bigint, 'R-012-18 取消でない作業ごとに1行');
select is((select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('work_plan_actual', 'work_monthly') and column_name ~ 'amount|price|charge'), 0::bigint, 'R-012-18 金額は出さない');
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.work_plan_actual where work_id in (%L, %L)$q$, tests.id('w2a'), tests.id('w5a'))), 2::bigint, 'R-012-18 スタッフは、自分の担当の作業の分だけ読める');
select is(tests.n(tests.u('staff2A'), format($q$select 1 from public.work_plan_actual where work_id = %L$q$, tests.id('w3a'))), 0::bigint, 'R-012-18 担当でない作業は読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.work_plan_actual'), 0::bigint, 'R-012-18 外部の人は、許された建物の作業でも、予実は読めない');
select is(tests.run_as_anon('select 1 from public.work_plan_actual') ->> 'error', '42501', 'R-012-18 ログインしていない人は読めない');
-- 19：行っていない作業・終わっていない作業
select pg_temp.mkwork('p19a', 'scheduled', pg_temp.today() - 3, null, null, array['staffA']);
select pg_temp.mkwork('p19b', 'in_progress', pg_temp.today() - 3, null, null, array['staffA']);
select pg_temp.mkwork('p19c', 'scheduled', pg_temp.today(), null, null, array['staffA']);
select pg_temp.mkwork('p19d', 'done', pg_temp.today() - 3, null, null, array['staffA']);
select is(pg_temp.pa('p19a', 'not_done::text || '','' || unfinished::text'), 'true,false', 'R-012-19 日付が過ぎて予定のままの作業は「行っていない」');
select is(pg_temp.pa('p19b', 'not_done::text || '','' || unfinished::text'), 'false,true', 'R-012-19 日付が過ぎて実施中のままの作業は「終わっていない」');
select is(pg_temp.pa('p19c', 'not_done::text || '','' || unfinished::text'), 'false,false', 'R-012-19 今日の予定は「行っていない」ではない');
select is(pg_temp.pa('p19d', 'not_done::text || '','' || unfinished::text'), 'false,false', 'R-012-19 完了した作業はどちらでもない');
-- 20：時刻のずれ
select pg_temp.mkwork('p20a', 'done', pg_temp.today() - 2, time '09:00', time '12:00', array['staffA']);
select pg_temp.mkwork('p20b', 'done', pg_temp.today() - 2, null, null, array['staffA']);
insert into public.work_records (id, tenant_id, work_id, membership_id, started_at, ended_at) values
  (tests.id('rec20a'), tests.t('A'), tests.id('p20a'), tests.id('m:A:staffA'), ((pg_temp.today() - 2) + time '09:20') at time zone 'Asia/Tokyo', ((pg_temp.today() - 2) + time '11:50') at time zone 'Asia/Tokyo'),
  (tests.id('rec20b'), tests.t('A'), tests.id('p20b'), tests.id('m:A:staffA'), ((pg_temp.today() - 2) + time '09:20') at time zone 'Asia/Tokyo', ((pg_temp.today() - 2) + time '11:50') at time zone 'Asia/Tokyo');
select is(pg_temp.pa('p20a', 'start_gap_min::text || '','' || end_gap_min::text'), '20,-10', 'R-012-20 開始は 20 分遅れ、終了は 10 分早い');
select is(pg_temp.pa('p20a', format('first_started_at = %L::timestamptz', ((pg_temp.today() - 2) + time '09:20') at time zone 'Asia/Tokyo')), 'true', 'R-012-20 最初の開始の時刻が出る');
select is(pg_temp.pa('p20b', 'start_gap_min is null and end_gap_min is null'), 'true', 'R-012-20 予定の時刻がなければ、ずれは空');
select is(pg_temp.pa('p19a', 'start_gap_min is null'), 'true', 'R-012-20 実績がなければ、ずれは空');
-- 21：行わなかった項目
select pg_temp.mkwork('p21a', 'done', pg_temp.today() - 2, null, null, array['staffA']);
insert into public.reports (id, tenant_id, work_id, status) values (tests.id('rep21'), tests.t('A'), tests.id('p21a'), 'draft');
insert into public.report_items (tenant_id, report_id, name, sort, done) values
  (tests.t('A'), tests.id('rep21'), '床', 1, true), (tests.t('A'), tests.id('rep21'), '窓', 2, false), (tests.t('A'), tests.id('rep21'), 'ゴミ置き場', 3, false);
select is(pg_temp.pa('p21a', 'items_total::text || '','' || items_skipped::text'), '3,2', 'R-012-21 項目 3 つのうち、チェックのないのは 2 つ');
select is(pg_temp.pa('p19d', 'items_total::text || '','' || items_skipped::text'), '0,0', 'R-012-21 報告書がなければ、項目は 0');
-- 22：出ていない報告書
select pg_temp.mkwork('p22a', 'done', pg_temp.today() - 2, null, null, array['staffA']);
insert into public.reports (id, tenant_id, work_id, status, checked_by, checked_at, submitted_by, submitted_at) values
  (tests.id('rep22'), tests.t('A'), tests.id('p22a'), 'submitted', tests.id('m:A:memberA'), now(), tests.id('m:A:memberA'), now());
select is(pg_temp.pa('p19d', 'report_status || '','' || report_missing::text'), 'none,true', 'R-012-22 完了して報告書がなければ「出ていない」（状況は none）');
select is(pg_temp.pa('p21a', 'report_status || '','' || report_missing::text'), 'draft,true', 'R-012-22 下書きのままなら「出ていない」');
select is(pg_temp.pa('p22a', 'report_status || '','' || report_missing::text'), 'submitted,false', 'R-012-22 提出になれば「出ていない」ではない');
select is(pg_temp.pa('p19a', 'report_missing::text'), 'false', 'R-012-22 完了していない作業は「出ていない」ではない');

-- ===== R-012-23 月ごとの集計 =====
-- 2020-05（過去）：a 完了（予定 60 分・実績 90 分・報告書なし）、b 予定のまま、c 行わず、d 取消、e 完了（予定 60 分・実績 60 分・提出済み）
select pg_temp.mkwork('m23a', 'done', date '2020-05-10', time '09:00', time '10:00');
select pg_temp.mkwork('m23b', 'scheduled', date '2020-05-11');
select pg_temp.mkwork('m23c', 'skipped', date '2020-05-12');
select pg_temp.mkwork('m23d', 'cancelled', date '2020-05-13');
select pg_temp.mkwork('m23e', 'done', date '2020-05-14', time '09:00', time '10:00');
insert into public.work_records (id, tenant_id, work_id, membership_id, started_at, ended_at) values
  (tests.id('rec23a'), tests.t('A'), tests.id('m23a'), tests.id('m:A:staffA'), (date '2020-05-10' + time '09:00') at time zone 'Asia/Tokyo', (date '2020-05-10' + time '10:30') at time zone 'Asia/Tokyo'),
  (tests.id('rec23e'), tests.t('A'), tests.id('m23e'), tests.id('m:A:staffA'), (date '2020-05-14' + time '09:00') at time zone 'Asia/Tokyo', (date '2020-05-14' + time '10:00') at time zone 'Asia/Tokyo');
insert into public.reports (id, tenant_id, work_id, status, checked_by, checked_at, submitted_by, submitted_at) values
  (tests.id('rep23e'), tests.t('A'), tests.id('m23e'), 'submitted', tests.id('m:A:memberA'), now(), tests.id('m:A:memberA'), now());
select is(tests.run_as(tests.u('memberA'), format($q$select planned::text || ',' || done::text || ',' || skipped::text || ',' || cancelled::text || ',' || not_done::text || ',' || report_missing::text || ',' || planned_minutes::text || ',' || actual_minutes::text as v
           from public.work_monthly where building_id = %L and month = date '2020-05-01'$q$, tests.id('buildingA10'))) -> 'rows' -> 0 ->> 'v', '4,2,1,1,1,1,120,150', 'R-012-23 月・建物ごとの件数と時間（予定 4・完了 2・行わず 1・取消 1・行っていない 1・出ていない報告書 1・予定 120 分・実績 150 分）');
select is(pg_temp.vn('work_monthly', 'month = date ''2020-05-01'''), 1::bigint, 'R-012-23 その月に作業のある建物ごとに1行');
select is(tests.n(tests.u('memberA'), 'select 1 from public.work_monthly where month = date ''2020-05-01'''), 1::bigint, 'R-012-23 社員は読める');
select is(tests.n(tests.u('adminB'), 'select 1 from public.work_monthly where month = date ''2020-05-01'''), 0::bigint, 'R-012-23 別の会社の人は、この会社の集計を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.work_monthly'), 0::bigint, 'R-012-23 外部の人は読めない');

-- ===== R-012-24 外部の人・別の会社 =====
select is(tests.n(tests.u('extA'), 'select 1 from public.works'), 1::bigint, 'R-012-24 外部の人は、作業の日と状況（許された建物の分）だけ読める（010）');
select is(tests.n(tests.u('extA'), 'select 1 from public.work_records') + tests.n(tests.u('extA'), 'select 1 from public.work_plan_actual') + tests.n(tests.u('extA'), 'select 1 from public.work_monthly') + tests.n(tests.u('extA'), 'select 1 from public.work_overlaps'),
          0::bigint, 'R-012-24 外部の人は、実績・予実・集計・重なりを読めない');
select is(tests.n(tests.u('adminB'), format($q$select 1 from public.work_plan_actual where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-012-24 別の会社の人は、予実を読めない');
select is(pg_temp.callerr(tests.u('adminB'), 'reschedule_work', format('%s, null, %L, null, null', pg_temp.q('w9a'), pg_temp.today() + 5)), '42501', 'R-012-24 別の会社の人は、作業を動かせない');

-- ===== R-012-25 使われているものは消さない（002 の usage_refs）=====
insert into public.clients (id, tenant_id, kind, name) values (tests.id('clientU'), tests.t('A'), 'management_company', 'テスト012先');
insert into public.buildings (id, tenant_id, client_id, name, address) values (tests.id('buildingU'), tests.t('A'), tests.id('clientU'), 'テスト012ビル', '東京都U');
insert into public.requests (id, tenant_id, client_id, building_id, title, status) values (tests.id('reqU'), tests.t('A'), tests.id('clientU'), tests.id('buildingU'), 'U の案件', 'new');
select pg_temp.call(tests.u('memberA'), 'create_work', format('%s, %L, null, null, null, %s, null, %L::uuid[]', pg_temp.q('wU'), pg_temp.today() + 3, pg_temp.q('reqU'), '{}'));
update public.requests set status = 'done' where id = tests.id('reqU'); -- 案件が開いていると、そちらで止まるので、終わらせておく
select is((select string_agg(b ->> 'reason', ',') from jsonb_array_elements(pg_temp.call(tests.u('memberA'), 'delete_building', pg_temp.q('buildingU')) -> 'blockers') b), 'has_future_works', 'R-012-25 予定の作業のある建物は消さない');
select pg_temp.call(tests.u('memberA'), 'cancel_work', pg_temp.q('wU'));
select is((select string_agg(b ->> 'reason', ',') from jsonb_array_elements(pg_temp.call(tests.u('memberA'), 'delete_building', pg_temp.q('buildingU')) -> 'blockers') b), null, 'R-012-25 作業が取消だけになれば、建物を消せる');
select is((select string_agg(distinct status, ',' order by status) from public.works where status not in ('scheduled', 'in_progress', 'done', 'skipped', 'cancelled')), null, 'R-012-25 状況の値は、予定・実施中・完了・行わず・取消のどれか');

select * from finish();
rollback;
