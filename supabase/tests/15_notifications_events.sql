-- 機能 015：出来事ごとのお知らせ（R-015-29〜40）
--   予定の変更（012 の RPC から）・明日の作業・出ていない報告書・請求の入金の遅れ（毎日の定時の処理。service_role だけ）
--   期限の近い案件（R-003-24〜26）と見積の承認（R-004-15・17・18）は、003・004 のテストで確かめている。
begin;
select * from no_plan();
select tests.seed();

select tests.make_user('staff2A');
select tests.make_member('A', 'staff2A', 'staff');

-- ---- 道具 ----
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Tokyo')::date $$;
create or replace function pg_temp.q(p text) returns text language sql as $$ select quote_literal(tests.id(p)::text) $$;
create or replace function pg_temp.call(p_uid uuid, p_fn text, p_args text) returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.svc(p_fn text, p_args text) returns jsonb language sql as $$
  select tests.run_as_service(format('select public.%I(%s) as r', p_fn, p_args)) -> 'rows' -> 0 -> 'r'
$$;
-- 作業を RLS を通らずに作る（担当は所属名の配列。建物は A10）
create or replace function pg_temp.mkwork(p_name text, p_status text default 'scheduled', p_date date default null, p_start time default null, p_end time default null,
                                          p_members text[] default '{}', p_tenant text default 'A') returns uuid language plpgsql as $$
declare m text;
begin
  insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, start_time, end_time, status)
  values (tests.id(p_name), tests.t(p_tenant), tests.id(case when p_tenant = 'A' then 'buildingA10' else 'buildingB10' end),
          tests.id(case when p_tenant = 'A' then 'svcA10-base' else 'svcB10-base' end), tests.id('key:' || p_name), '作業' || p_name,
          coalesce(p_date, pg_temp.today() + 3), p_start, p_end, p_status);
  foreach m in array p_members loop
    insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('wa:' || p_name || ':' || m), tests.t(p_tenant), tests.id(p_name), tests.id('m:' || p_tenant || ':' || m));
  end loop;
  return tests.id(p_name);
end $$;
create or replace function pg_temp.version(p_name text) returns int language sql as $$ select version from public.works where id = tests.id(p_name) $$;
-- ある作業の work_changed の件数（一覧の行。dedupe_key は work_changed:<種別>:<作業>:...）
create or replace function pg_temp.wc(p_work text, p_member text default null) returns bigint language sql as $$
  select count(*) from public.notifications
  where kind = 'work_changed' and channel = 'app' and dedupe_key like 'work_changed:%:' || tests.id(p_work)::text || ':%'
    and (p_member is null or membership_id = tests.id('m:A:' || p_member))
$$;
create or replace function pg_temp.wc_all() returns bigint language sql as $$
  select count(*) from public.notifications where kind = 'work_changed' and channel = 'app' and dedupe_key is not null
$$;

-- ===== R-015-29 日時の変更 =====
select pg_temp.mkwork('wc1', 'scheduled', pg_temp.today() + 3, time '09:00', time '12:00', array['staffA', 'staff2A', 'memberA']);
select is(pg_temp.call(tests.u('adminA'), 'reschedule_work', pg_temp.q('wc1') || ', ' || pg_temp.version('wc1') || ', ' || quote_literal((pg_temp.today() + 5)::text) || ', ''10:00'', ''13:00'''), '{"ok": true, "status": "scheduled", "version": 2}'::jsonb, '（準備）日時を動かせる');
select is(pg_temp.wc('wc1'), 3::bigint, 'R-015-29 日時を動かすと、担当の3人にお知らせを作る');
select is(pg_temp.wc('wc1', 'staffA'), 1::bigint, 'R-015-29 スタッフの担当に作る');
select is(pg_temp.wc('wc1', 'memberA'), 1::bigint, 'R-015-29 社員の担当にも作る');
select is((select count(*) from public.notifications where kind = 'work_changed' and channel = 'app' and dedupe_key like 'work_changed:%:' || tests.id('wc1')::text || ':%' and title like '%作業wc1%'), 3::bigint, 'R-015-29 題名に作業の名前が入る');
select is((select body like '%' || to_char(pg_temp.today() + 3, 'MM/DD') || '%' and body like '%' || to_char(pg_temp.today() + 5, 'MM/DD') || '%' and body like '%10:00%'
           from public.notifications where kind = 'work_changed' and dedupe_key like 'work_changed:%:' || tests.id('wc1')::text || ':%' limit 1), true, 'R-015-29 本文に、変更の前と後の日付・時刻が入る');
select is((select distinct link from public.notifications where kind = 'work_changed' and dedupe_key like 'work_changed:%:' || tests.id('wc1')::text || ':%'), '/schedule/mine/', 'R-015-29 リンクは自分の予定の画面');
-- 操作した本人には作らない（社員 A が自分で動かす）
select pg_temp.mkwork('wc2', 'scheduled', pg_temp.today() + 3, null, null, array['staffA', 'memberA']);
select is(pg_temp.call(tests.u('memberA'), 'reschedule_work', pg_temp.q('wc2') || ', 1, ' || quote_literal((pg_temp.today() + 4)::text) || ', null, null') ->> 'ok', 'true', '（準備）社員 A が日付を動かす');
select is(pg_temp.wc('wc2', 'staffA'), 1::bigint, 'R-015-29 ほかの担当（スタッフ）には作る');
select is(pg_temp.wc('wc2', 'memberA'), 0::bigint, 'R-015-29 操作した本人（社員 A）には作らない');
-- 続けて動かすと、変更ごとに1件ずつ
select is(pg_temp.call(tests.u('adminA'), 'reschedule_work', pg_temp.q('wc2') || ', ' || pg_temp.version('wc2') || ', ' || quote_literal((pg_temp.today() + 6)::text) || ', null, null') ->> 'ok', 'true', '（準備）もう一度動かす');
select is(pg_temp.wc('wc2', 'staffA'), 2::bigint, 'R-015-29 もう一度動かせば、新しい変更として、もう1件作る');
select is(pg_temp.wc('wc2', 'memberA'), 1::bigint, 'R-015-29 管理者が動かしたときは、社員 A に作る');

-- ===== R-015-30 行わず・取消 =====
select pg_temp.mkwork('wc3', 'scheduled', pg_temp.today() + 3, null, null, array['staffA', 'staff2A']);
select is(pg_temp.call(tests.u('adminA'), 'skip_work', pg_temp.q('wc3') || ', 1') ->> 'ok', 'true', '（準備）行わずにする');
select is(pg_temp.wc('wc3'), 2::bigint, 'R-015-30 行わずにすると、担当の2人に作る');
select is((select title from public.notifications where kind = 'work_changed' and dedupe_key like 'work_changed:%:' || tests.id('wc3')::text || ':%' limit 1), '作業は行わないことになりました：作業wc3', 'R-015-30 題名に「行わない」と作業の名前');
select pg_temp.mkwork('wc4', 'scheduled', pg_temp.today() + 3, null, null, array['staffA', 'memberA']);
select is(pg_temp.call(tests.u('adminA'), 'cancel_work', pg_temp.q('wc4') || ', 1') ->> 'ok', 'true', '（準備）取り消す');
select is(pg_temp.wc('wc4'), 2::bigint, 'R-015-30 取り消すと、担当の2人に作る');
select is((select title from public.notifications where kind = 'work_changed' and dedupe_key like 'work_changed:%:' || tests.id('wc4')::text || ':%' limit 1), '作業が取り消されました：作業wc4', 'R-015-30 題名に「取り消し」と作業の名前');
select pg_temp.mkwork('wc4b', 'scheduled', pg_temp.today() + 3, null, null, array['staffA', 'memberA']);
select is(pg_temp.call(tests.u('memberA'), 'cancel_work', pg_temp.q('wc4b') || ', 1') ->> 'ok', 'true', '（準備）社員 A が取り消す');
select is(pg_temp.wc('wc4b'), 1::bigint, 'R-015-30 操作した本人には作らない（取消）');

-- ===== R-015-31 担当の入れ替え =====
select pg_temp.mkwork('wc5', 'scheduled', pg_temp.today() + 3, null, null, array['staffA', 'memberA']);
select is(pg_temp.call(tests.u('adminA'), 'swap_assignment', pg_temp.q('wc5') || ', ' || pg_temp.q('m:A:staffA') || ', ' || pg_temp.q('m:A:staff2A')) ->> 'ok', 'true', '（準備）スタッフ A をスタッフ 2 に入れ替える');
select is((select title from public.notifications where kind = 'work_changed' and channel = 'app' and membership_id = tests.id('m:A:staff2A') and dedupe_key like 'work_changed:%:' || tests.id('wc5')::text || ':%'), '担当になりました：作業wc5', 'R-015-31 新しい担当に「担当になった」');
select is((select title from public.notifications where kind = 'work_changed' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key like 'work_changed:%:' || tests.id('wc5')::text || ':%'), '担当から外れました：作業wc5', 'R-015-31 外れた人に「担当から外れた」');
select is(pg_temp.wc('wc5', 'memberA'), 0::bigint, 'R-015-31 ほかの担当（社員 A）には作らない');
select is(pg_temp.wc('wc5'), 2::bigint, 'R-015-31 作るのは2件だけ');

-- ===== R-015-32 作らないとき =====
select is(pg_temp.call(tests.u('adminA'), 'skip_work', pg_temp.q('wc3') || ', null') ->> 'already', 'true', '（準備）行わずを二度目');
select is(pg_temp.wc('wc3'), 2::bigint, 'R-015-32 同じ状況の二度目（already）は、作らない');
select pg_temp.mkwork('wc6', 'done', pg_temp.today() - 1, null, null, array['staffA']);
select is(pg_temp.call(tests.u('adminA'), 'skip_work', pg_temp.q('wc6') || ', null') ->> 'reason', 'not_scheduled', '（準備）完了した作業は行わずにできない');
select is(pg_temp.call(tests.u('adminA'), 'cancel_work', pg_temp.q('wc6') || ', null') ->> 'reason', 'not_scheduled', '（準備）完了した作業は取り消せない');
select is(pg_temp.call(tests.u('adminA'), 'reschedule_work', pg_temp.q('wc6') || ', null, ' || quote_literal(pg_temp.today()::text) || ', null, null') ->> 'reason', 'not_scheduled', '（準備）完了した作業は動かせない');
select is(pg_temp.wc('wc6'), 0::bigint, 'R-015-32 断られた操作では、作らない');
select pg_temp.mkwork('wc7', 'scheduled', pg_temp.today() + 3, null, null, array['staffA']);
select is(pg_temp.call(tests.u('adminA'), 'reschedule_work', pg_temp.q('wc7') || ', 99, ' || quote_literal((pg_temp.today() + 4)::text) || ', null, null') ->> 'reason', 'conflict', '（準備）版が古いと断られる');
select is(pg_temp.call(tests.u('adminA'), 'reschedule_work', pg_temp.q('wc7') || ', 1, ' || quote_literal((pg_temp.today() + 4)::text) || ', ''10:00'', ''09:00''') ->> 'reason', 'invalid_time', '（準備）時刻が逆だと断られる');
select is(pg_temp.wc('wc7'), 0::bigint, 'R-015-32 版が古い・時刻が不正で断られたときも作らない');
select is(pg_temp.call(tests.u('adminA'), 'swap_assignment', pg_temp.q('wc7') || ', ' || pg_temp.q('m:A:memberA') || ', ' || pg_temp.q('m:A:staff2A')) ->> 'reason', 'not_assigned', '（準備）担当でない人は外せない');
select is(pg_temp.wc('wc7'), 0::bigint, 'R-015-32 入れ替えが断られたときも作らない');
select pg_temp.mkwork('wc7b', 'scheduled', pg_temp.today() + 3, time '09:00', time '10:00', array['staffA']);
select is(pg_temp.call(tests.u('adminA'), 'reschedule_work', pg_temp.q('wc7b') || ', 1, ' || quote_literal((pg_temp.today() + 3)::text) || ', ''09:00'', ''10:00''') ->> 'ok', 'true', '（準備）日付も時刻も変わらない変更は通る');
select is(pg_temp.wc('wc7b'), 0::bigint, 'R-015-32 日付も時刻も変わらない変更では、作らない');
-- 担当のいない作業・止められた担当
select pg_temp.mkwork('wc8', 'scheduled', pg_temp.today() + 3, null, null, array[]::text[]);
select is(pg_temp.call(tests.u('adminA'), 'cancel_work', pg_temp.q('wc8') || ', 1') ->> 'ok', 'true', '（準備）担当のいない作業を取り消す');
select is(pg_temp.wc('wc8'), 0::bigint, 'R-015-32 担当のいない作業では、だれにも作らない（取消は通る）');
select pg_temp.mkwork('wc9', 'scheduled', pg_temp.today() + 3, null, null, array['staffA', 'staff2A']);
update public.memberships set status = 'suspended' where id = tests.id('m:A:staff2A');
select is(pg_temp.call(tests.u('adminA'), 'cancel_work', pg_temp.q('wc9') || ', 1') ->> 'ok', 'true', '（準備）担当の1人が止められているときに取り消す');
select is(pg_temp.wc('wc9', 'staffA'), 1::bigint, 'R-015-32 有効な担当には作る');
select is(pg_temp.wc('wc9', 'staff2A'), 0::bigint, 'R-015-32 止められた担当には作らない');
update public.memberships set status = 'active' where id = tests.id('m:A:staff2A');
-- ほかの会社には作らない
select pg_temp.mkwork('wcB', 'scheduled', pg_temp.today() + 3, null, null, array['staffB'], 'B');
select is(pg_temp.call(tests.u('adminA'), 'cancel_work', pg_temp.q('wcB') || ', 1') -> 'ok' is null, true, '（準備）A の管理者は B の作業を操作できない（42501。結果は返らない）');
select is((select count(*) from public.notifications where tenant_id = tests.t('B') and kind = 'work_changed' and dedupe_key is not null), 0::bigint, 'R-015-32 ほかの会社（B）には作らない');
select is((select count(*) from public.notifications n where n.kind = 'work_changed' and n.dedupe_key is not null
           and n.tenant_id <> (select w.tenant_id from public.works w where w.id = (regexp_match(n.dedupe_key, '^work_changed:[a-z]+:([0-9a-f-]+):'))[1]::uuid)), 0::bigint, 'R-015-32 お知らせの会社は、作業の会社と同じ');
-- スタッフは操作できない（呼べないので何も作らない）
select pg_temp.mkwork('wc10', 'scheduled', pg_temp.today() + 3, null, null, array['staffA']);
select is(tests.run_as(tests.u('staffA'), format('select public.cancel_work(%L, 1) as r', tests.id('wc10'))) ->> 'error', '42501', '（準備）スタッフは取り消せない');
select is(pg_temp.wc('wc10'), 0::bigint, 'R-015-32 権限がなく断られたときも作らない');

-- ===== 毎日の定時の処理の記録（R-015-39・40）=====
select is(tests.err(tests.u('adminA'), $q$select public.daily_notify_tenants()$q$), '42501', 'R-015-40 管理者は、定時の処理の会社の一覧を呼べない');
select is(tests.err(tests.u('memberA'), format($q$select public.daily_notify_start(%L, 'work_tomorrow')$q$, tests.t('A'))), '42501', 'R-015-40 ログインした利用者は、処理の記録を始められない');
select is(tests.err(tests.u('adminA'), format($q$select public.work_tomorrow_notify(%L, null)$q$, tests.t('A'))), '42501', 'R-015-40 管理者は、明日の作業の処理を呼べない');
select is(tests.err(tests.u('adminA'), format($q$select public.report_missing_notify(%L, null, 14)$q$, tests.t('A'))), '42501', 'R-015-40 管理者は、出ていない報告書の処理を呼べない');
select is(tests.err(tests.u('adminA'), format($q$select public.invoice_overdue_notify(%L, null)$q$, tests.t('A'))), '42501', 'R-015-40 管理者は、入金の遅れの処理を呼べない');
select is(tests.err(tests.u('adminA'), format($q$select public.daily_notify_finish(%L, %L, 'work_tomorrow', 'success', '{}'::jsonb, null)$q$, tests.t('A'), tests.id('jobA'))), '42501', 'R-015-40 管理者は、処理の記録を閉じられない');
select is(tests.run_as_anon(format($q$select public.work_tomorrow_notify(%L, null)$q$, tests.t('A'))) ->> 'error', '42501', 'R-015-40 anon は呼べない');
select is(tests.run_as_anon($q$select public.daily_notify_tenants()$q$) ->> 'error', '42501', 'R-015-40 anon は会社の一覧も呼べない');
select is(jsonb_array_length(tests.run_as_service($q$select public.daily_notify_tenants() as r$q$) -> 'rows') >= 2, true, 'R-015-40 service_role は、会社の一覧を取れる（A・B）');
select is((select count(*) from jsonb_array_elements(tests.run_as_service($q$select public.daily_notify_tenants() as r$q$) -> 'rows') e where e ->> 'r' = tests.t('A')::text), 1::bigint, 'R-015-40 会社の一覧に会社 A が入る');
update public.tenants set status = 'suspended' where id = tests.t('B');
select is((select count(*) from jsonb_array_elements(tests.run_as_service($q$select public.daily_notify_tenants() as r$q$) -> 'rows') e where e ->> 'r' = tests.t('B')::text), 0::bigint, 'R-015-40 止めた会社は、会社の一覧に入らない');
update public.tenants set status = 'active' where id = tests.t('B');

create temp table _run as select (pg_temp.svc('daily_notify_start', format('%L, ''work_tomorrow''', tests.t('A'))) #>> '{}')::uuid as id;
select isnt((select id from _run), null, 'R-015-39 処理の記録を始められる');
select is((select kind || ',' || status from public.job_runs where id = (select id from _run)), 'notify_work_tomorrow,running', 'R-015-39 記録は、処理の名前・実行中で作られる');
select is(pg_temp.svc('daily_notify_start', format('%L, ''work_tomorrow''', tests.t('A'))), 'null'::jsonb, 'R-015-39 同じ会社・同じ処理が動いている間は、もう一度始めない');
select isnt((select pg_temp.svc('daily_notify_start', format('%L, ''report_missing''', tests.t('A')))), 'null'::jsonb, 'R-015-39 別の処理は、同じ会社でも始められる');
select isnt((select pg_temp.svc('daily_notify_start', format('%L, ''work_tomorrow''', tests.t('B')))), 'null'::jsonb, 'R-015-39 同じ処理でも、別の会社は始められる');
select is(tests.run_as_service(format($q$select public.daily_notify_start(%L, 'bogus') as r$q$, tests.t('A'))) ->> 'error', '22023', 'R-015-39 知らない処理の名前は断る');
update public.job_runs set started_at = now() - interval '31 minutes' where id = (select id from _run);
create temp table _run2 as select (pg_temp.svc('daily_notify_start', format('%L, ''work_tomorrow''', tests.t('A'))) #>> '{}')::uuid as id;
select isnt((select id from _run2), null, 'R-015-39 30分を過ぎて止まったままの記録があっても、始め直せる');
select is((select status || ',' || error from public.job_runs where id = (select id from _run)), 'failure,timeout', 'R-015-39 古い記録は、失敗（timeout）で閉じられる');
select is(pg_temp.svc('daily_notify_finish', format('%L, %L, ''work_tomorrow'', ''success'', ''{"works": 1}''::jsonb, null', tests.t('B'), (select id from _run2))), 'false'::jsonb, 'R-015-39 別の会社の記録は閉じられない');
select is(pg_temp.svc('daily_notify_finish', format('%L, %L, ''report_missing'', ''success'', ''{}''::jsonb, null', tests.t('A'), (select id from _run2))), 'false'::jsonb, 'R-015-39 別の処理の名前では閉じられない');
select is(pg_temp.svc('daily_notify_finish', format('%L, %L, ''work_tomorrow'', ''success'', ''{"works": 1}''::jsonb, null', tests.t('A'), (select id from _run2))), 'true'::jsonb, 'R-015-39 記録を閉じられる');
select is((select status || ',' || (counts ->> 'works') from public.job_runs where id = (select id from _run2)), 'success,1', 'R-015-39 記録に結果と件数が残る');
select is(tests.run_as_service(format($q$select public.daily_notify_finish(%L, %L, 'work_tomorrow', 'bogus', '{}'::jsonb, null) as r$q$, tests.t('A'), (select id from _run2))) ->> 'error', '22023', 'R-015-39 結果の値は success か failure だけ');
select is(pg_temp.svc('daily_notify_start', format('%L, ''work_tomorrow''', tests.t('A'))) <> 'null'::jsonb, true, 'R-015-39 閉じたあとは、また始められる（次の日の処理）');

-- ===== R-015-33・34 明日の作業 =====
select pg_temp.mkwork('wt1', 'scheduled', pg_temp.today() + 1, time '09:00', time '12:00', array['staffA', 'memberA']);
select pg_temp.mkwork('wt2', 'scheduled', pg_temp.today() + 1, time '13:30', time '15:00', array['staffA']);
select pg_temp.mkwork('wt3', 'scheduled', pg_temp.today() + 1, null, null, array['staffA']);
select pg_temp.mkwork('wt4', 'done', pg_temp.today() + 1, time '08:00', time '09:00', array['staffA']);
select pg_temp.mkwork('wt5', 'cancelled', pg_temp.today() + 1, time '08:30', time '09:00', array['staffA']);
select pg_temp.mkwork('wt6', 'scheduled', pg_temp.today(), time '07:00', time '09:00', array['staffA']);
select pg_temp.mkwork('wt7', 'scheduled', pg_temp.today() + 2, time '07:30', time '09:00', array['staffA']);
select pg_temp.mkwork('wt8', 'scheduled', pg_temp.today() + 1, time '10:00', time '11:00', array[]::text[]);
select pg_temp.mkwork('wt9', 'scheduled', pg_temp.today() + 1, time '10:00', time '11:00', array['staff2A']);
select pg_temp.mkwork('wt10', 'skipped', pg_temp.today() + 1, time '06:00', time '07:00', array['staffA']);
select pg_temp.mkwork('wt11', 'in_progress', pg_temp.today() + 1, time '06:30', time '07:00', array['staffA']);
select pg_temp.mkwork('wtB', 'scheduled', pg_temp.today() + 1, time '09:00', time '10:00', array['staffB'], 'B');
update public.memberships set status = 'suspended' where id = tests.id('m:A:staff2A');
create or replace function pg_temp.wtn(p_member text, p_tenant text default 'A') returns bigint language sql as $$
  select count(*) from public.notifications where kind = 'work_tomorrow' and channel = 'app' and dedupe_key is not null and membership_id = tests.id('m:' || p_tenant || ':' || p_member)
$$;
select is(pg_temp.svc('work_tomorrow_notify', format('%L, null', tests.t('A'))) ->> 'notified', '2', 'R-015-33 明日の作業の担当（スタッフ A・社員 A）の2人に作る');
select is(pg_temp.svc('work_tomorrow_notify', format('%L, null', tests.t('A'))) ->> 'notified', '0', 'R-015-34 同じ日にもう一度呼んでも、作らない');
select is(pg_temp.wtn('staffA'), 1::bigint, 'R-015-33 スタッフ A に1件（作業が複数あっても1件にまとめる）');
select is(pg_temp.wtn('memberA'), 1::bigint, 'R-015-33 社員 A に1件');
select is((select title from public.notifications where kind = 'work_tomorrow' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key is not null), '明日の作業：3件', 'R-015-33 題名に件数（予定の3件だけ。完了・取消・行わず・実施中は数えない）');
select is((select title from public.notifications where kind = 'work_tomorrow' and channel = 'app' and membership_id = tests.id('m:A:memberA') and dedupe_key is not null), '明日の作業：1件', 'R-015-33 社員 A は1件');
select is((select position('09:00' in body) > 0 and position('09:00' in body) < position('13:30' in body) and position('13:30' in body) < position('作業wt3' in body)
           from public.notifications where kind = 'work_tomorrow' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key is not null), true, 'R-015-33 本文は時刻順（時刻のないものは最後）');
select is((select body like '%作業wt1%' and body like '%作業wt2%' and body like '%作業wt3%' and body not like '%作業wt4%' and body not like '%作業wt5%' and body not like '%作業wt6%' and body not like '%作業wt7%' and body not like '%作業wt10%' and body not like '%作業wt11%'
           from public.notifications where kind = 'work_tomorrow' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key is not null), true, 'R-015-33 完了・取消・今日・あさって・行わず・実施中の作業は本文に入れない');
select is((select body like '%テスト契約ビルA10%' from public.notifications where kind = 'work_tomorrow' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key is not null), true, 'R-015-33 本文に建物の名前が入る');
select is((select distinct link from public.notifications where kind = 'work_tomorrow' and channel = 'app' and dedupe_key is not null and tenant_id = tests.t('A')), '/schedule/mine/', 'R-015-33 リンクは自分の予定の画面');
select is((select length(body) <= 500 from public.notifications where kind = 'work_tomorrow' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key is not null), true, 'R-015-33 本文は500字までに収める');
select is(pg_temp.wtn('staff2A'), 0::bigint, 'R-015-34 止められた担当には作らない');
select is((select count(*) from public.notifications where kind = 'work_tomorrow' and dedupe_key is not null and tenant_id = tests.t('B')), 0::bigint, 'R-015-34 A の処理は、ほかの会社（B）に作らない');
update public.memberships set status = 'active' where id = tests.id('m:A:staff2A');
select is(pg_temp.svc('work_tomorrow_notify', format('%L, null', tests.t('B'))) ->> 'notified', '1', 'R-015-34 B の処理は、B の担当だけに作る');
select is(pg_temp.wtn('staffB', 'B'), 1::bigint, 'R-015-34 B のスタッフに1件');
select is((select count(*) from public.notifications where kind = 'work_tomorrow' and channel = 'app' and dedupe_key is not null and tenant_id = tests.t('A')), 2::bigint, 'R-015-34 B の処理のあとも、A の件数は増えない');
-- 長い一覧：作業が多くても本文は500字までに収め、件数は正しく数える
do $$
declare i int;
begin
  for i in 1..40 loop
    perform pg_temp.mkwork('wtL' || i, 'scheduled', pg_temp.today() + 1, time '16:00', time '17:00', array['multi']);
  end loop;
end $$;
select is(pg_temp.svc('work_tomorrow_notify', format('%L, null', tests.t('A'))) ->> 'notified', '2', 'R-015-33 作業が多い担当（multi）にも、1件にまとめて作る（止めを戻したスタッフ 2 の分と合わせて2人）');
select is((select title from public.notifications where kind = 'work_tomorrow' and channel = 'app' and membership_id = tests.id('m:A:multi') and dedupe_key is not null), '明日の作業：40件', 'R-015-33 件数は本文を切っても40件と正しい');
select is((select length(body) <= 500 and body like '%ほか%' from public.notifications where kind = 'work_tomorrow' and channel = 'app' and membership_id = tests.id('m:A:multi') and dedupe_key is not null), true, 'R-015-33 多いときの本文は500字までで、「ほか」と続きを示す');

-- ===== R-015-35・36 出ていない報告書 =====
create or replace function pg_temp.rm(p_work text, p_member text default null) returns bigint language sql as $$
  select count(*) from public.notifications where kind = 'report_missing' and channel = 'app' and dedupe_key like 'report_missing:' || tests.id(p_work)::text || ':%'
    and (p_member is null or membership_id = tests.id('m:A:' || p_member))
$$;
select pg_temp.mkwork('wr1', 'done', pg_temp.today() - 1, time '09:00', time '12:00', array['staffA']);
select pg_temp.mkwork('wr2', 'done', pg_temp.today() - 2, null, null, array['staffA']);
select pg_temp.mkwork('wr3', 'done', pg_temp.today() - 3, null, null, array['staffA']);
select pg_temp.mkwork('wr3b', 'done', pg_temp.today() - 3, null, null, array['staffA']);
select pg_temp.mkwork('wr4', 'done', pg_temp.today(), null, null, array['staffA']);
select pg_temp.mkwork('wr5', 'done', pg_temp.today() - 15, null, null, array['staffA']);
select pg_temp.mkwork('wr6', 'done', pg_temp.today() - 14, null, null, array['staffA']);
select pg_temp.mkwork('wr7', 'scheduled', pg_temp.today() - 2, null, null, array['staffA']);
select pg_temp.mkwork('wr8', 'cancelled', pg_temp.today() - 2, null, null, array['staffA']);
select pg_temp.mkwork('wr9', 'in_progress', pg_temp.today() - 2, null, null, array['staffA']);
select pg_temp.mkwork('wrB', 'done', pg_temp.today() - 1, null, null, array['staffB'], 'B');
-- 報告書：wr2 は提出済み、wr3 は下書き、wr3b は確認済み
insert into public.reports (id, tenant_id, work_id, status, checked_by, checked_at, submitted_by, submitted_at) values
  (tests.id('rep-wr2'), tests.t('A'), tests.id('wr2'), 'submitted', tests.id('m:A:memberA'), now(), tests.id('m:A:memberA'), now());
insert into public.reports (id, tenant_id, work_id, status) values (tests.id('rep-wr3'), tests.t('A'), tests.id('wr3'), 'draft');
insert into public.reports (id, tenant_id, work_id, status, checked_by, checked_at) values (tests.id('rep-wr3b'), tests.t('A'), tests.id('wr3b'), 'checked', tests.id('m:A:memberA'), now());
-- 取り消した作業の報告書・提出済みの作業は対象外。報告書を消した（deleted_at）作業は、報告書がないものとして数える
select is(pg_temp.svc('report_missing_notify', format('%L, null, 14', tests.t('A'))) ->> 'notified' is not null, true, '（準備）出ていない報告書の処理を呼ぶ');
select is(pg_temp.rm('wr1'), 4::bigint, 'R-015-35 報告書がない作業は、担当（スタッフ A）と work.assign を持つ3人（管理者 A・社員 A・multi）の4人に作る');
select is(pg_temp.rm('wr1', 'staffA'), 1::bigint, 'R-015-35 担当に作る');
select is(pg_temp.rm('wr1', 'adminA'), 1::bigint, 'R-015-35 確認する人（work.assign を持つ管理者）に作る');
select is(pg_temp.rm('wr1', 'memberA'), 1::bigint, 'R-015-35 確認する人（work.assign を持つ社員）に作る');
select is(pg_temp.rm('wr1', 'staff2A'), 0::bigint, 'R-015-35 担当でも work.assign でもないスタッフには作らない');
select is(pg_temp.rm('wr3'), 4::bigint, 'R-015-35 下書きの報告書も「出ていない」ので作る');
select is(pg_temp.rm('wr3b'), 4::bigint, 'R-015-35 確認済みで提出前の報告書も作る');
select is(pg_temp.rm('wr6'), 4::bigint, 'R-015-35 14日前の作業までは作る');
select is((select title from public.notifications where kind = 'report_missing' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key like 'report_missing:' || tests.id('wr1')::text || ':%'), '報告書がまだ出ていません：作業wr1', 'R-015-35 題名に作業の名前');
select is((select link from public.notifications where kind = 'report_missing' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key like 'report_missing:' || tests.id('wr1')::text || ':%'), '/reports/edit/?work=' || tests.id('wr1')::text, 'R-015-35 リンクはその作業の報告書');
select is((select body like '%' || to_char(pg_temp.today() - 1, 'MM/DD') || '%' and body like '%テスト契約ビルA10%' from public.notifications where kind = 'report_missing' and channel = 'app' and membership_id = tests.id('m:A:staffA') and dedupe_key like 'report_missing:' || tests.id('wr1')::text || ':%'), true, 'R-015-35 本文に作業の日と建物の名前');
select is(pg_temp.rm('wr2'), 0::bigint, 'R-015-36 提出済みの報告書は作らない');
select is(pg_temp.rm('wr4'), 0::bigint, 'R-015-36 今日の作業は作らない（今日中に出せる）');
select is(pg_temp.rm('wr5'), 0::bigint, 'R-015-36 15日前の作業は作らない');
select is(pg_temp.rm('wr7'), 0::bigint, 'R-015-36 完了していない作業（予定）は作らない');
select is(pg_temp.rm('wr8'), 0::bigint, 'R-015-36 取消の作業は作らない');
select is(pg_temp.rm('wr9'), 0::bigint, 'R-015-36 実施中の作業は作らない');
select is((select count(*) from public.notifications where kind = 'report_missing' and dedupe_key like 'report_missing:' || tests.id('wrB')::text || ':%'), 0::bigint, 'R-015-36 A の処理は、ほかの会社の作業に作らない');
select is(pg_temp.svc('report_missing_notify', format('%L, null, 14', tests.t('A'))) ->> 'notified', '0', 'R-015-36 もう一度呼んでも、同じ作業・同じ人には作らない');
-- 提出された後に、別の作業が出ていなければ新しく作る
select pg_temp.mkwork('wr10', 'done', pg_temp.today() - 1, null, null, array['staffA']);
select is(pg_temp.svc('report_missing_notify', format('%L, null, 14', tests.t('A'))) ->> 'notified', '4', 'R-015-36 あとから完了した作業は、次の処理で作る（4人）');
select is(pg_temp.svc('report_missing_notify', format('%L, null, 14', tests.t('B'))) ->> 'notified', '3', 'R-015-35 B の処理は B の担当と work.assign を持つ人に作る（スタッフ B・管理者 B・multi（B では管理者）で3人。範囲は 14 日・日付は今日より前）');
select is((select count(*) from public.notifications where kind = 'report_missing' and channel = 'app' and dedupe_key like 'report_missing:' || tests.id('wrB')::text || ':%' and tenant_id = tests.t('B')), 3::bigint, 'R-015-36 B のお知らせは、B の人だけ');
select is((select count(*) from public.notifications where kind = 'report_missing' and dedupe_key like 'report_missing:' || tests.id('wrB')::text || ':%' and tenant_id <> tests.t('B')), 0::bigint, 'R-015-36 B の作業のお知らせは、ほかの会社に作らない');

-- ===== R-015-37・38 請求の入金の遅れ =====
create or replace function pg_temp.mkinv(p_name text, p_status text, p_due date, p_total bigint, p_paid bigint, p_created_by text, p_period date, p_tenant text default 'A') returns void language plpgsql as $$
begin
  insert into public.invoices (id, tenant_id, client_id, period, number, issue_date, due_date, tax_rate, subtotal, tax, total, status, issued_at, created_by, cancelled_at, cancel_reason)
  values (tests.id(p_name), tests.t(p_tenant), tests.id('client' || p_tenant || '11'), p_period,
          case when p_status = 'draft' then null else 'T-' || p_name end,
          case when p_status = 'draft' then null else p_due - 30 end,
          case when p_status = 'draft' then null else p_due end,
          0, p_total, 0, p_total, p_status, case when p_status = 'draft' then null else now() end,
          case when p_created_by is null then null else tests.u(p_created_by) end,
          case when p_status = 'cancelled' then now() end, case when p_status = 'cancelled' then 'x' end);
  if p_paid > 0 then insert into public.payments (tenant_id, invoice_id, paid_on, amount) values (tests.t(p_tenant), tests.id(p_name), p_due, p_paid); end if;
end $$;
create or replace function pg_temp.io(p_inv text, p_member text default null, p_tenant text default 'A') returns bigint language sql as $$
  select count(*) from public.notifications where kind = 'invoice_overdue' and channel = 'app' and dedupe_key like 'invoice_overdue:' || tests.id(p_inv)::text || ':%'
    and (p_member is null or membership_id = tests.id('m:' || p_tenant || ':' || p_member))
$$;
select pg_temp.mkinv('od1', 'issued', pg_temp.today() - 1, 10000, 0, 'memberA', date '2030-01-01');
select pg_temp.mkinv('od2', 'sent', pg_temp.today(), 10000, 0, 'memberA', date '2030-02-01');
select pg_temp.mkinv('od3', 'partial', pg_temp.today() - 5, 10000, 3000, 'memberA', date '2030-03-01');
select pg_temp.mkinv('od4', 'sent', pg_temp.today() - 5, 10000, 10000, 'memberA', date '2030-04-01');
select pg_temp.mkinv('od5', 'draft', pg_temp.today() - 5, 10000, 0, 'memberA', date '2030-05-01');
select pg_temp.mkinv('od6', 'cancelled', pg_temp.today() - 5, 10000, 0, 'memberA', date '2030-06-01');
select pg_temp.mkinv('od7', 'issued', pg_temp.today() - 3, 20000, 0, 'staffA', date '2030-07-01');
select pg_temp.mkinv('od8', 'paid', pg_temp.today() - 9, 10000, 10000, 'memberA', date '2030-08-01');
select pg_temp.mkinv('od9', 'sent', pg_temp.today() + 7, 10000, 0, 'memberA', date '2030-09-01');
select pg_temp.mkinv('od10', 'issued', pg_temp.today() - 2, 10000, 0, null, date '2030-10-01');
select pg_temp.mkinv('odB', 'issued', pg_temp.today() - 2, 15000, 0, null, date '2030-01-01', 'B');
select is(pg_temp.svc('invoice_overdue_notify', format('%L, null', tests.t('A'))) ->> 'notified' is not null, true, '（準備）入金の遅れの処理を呼ぶ');
select is(pg_temp.io('od1'), 2::bigint, 'R-015-37 期日を過ぎて残高がある請求書は、作った人（社員 A）と管理者の2人に作る');
select is(pg_temp.io('od1', 'memberA'), 1::bigint, 'R-015-37 請求書を作った人に作る');
select is(pg_temp.io('od1', 'adminA'), 1::bigint, 'R-015-37 管理者に作る');
select is(pg_temp.io('od1', 'multi'), 0::bigint, 'R-015-37 作った人でも管理者でもない社員には作らない');
select is(pg_temp.io('od3'), 2::bigint, 'R-015-37 一部入金でも、残高があれば作る');
select is((select body like '%7,000%' from public.notifications where kind = 'invoice_overdue' and channel = 'app' and membership_id = tests.id('m:A:adminA') and dedupe_key like 'invoice_overdue:' || tests.id('od3')::text || ':%'), true, 'R-015-37 本文に残高（入金を引いた金額）');
select is((select body like '%' || to_char(pg_temp.today() - 5, 'YYYY/MM/DD') || '%' and body like '%5 日%' from public.notifications where kind = 'invoice_overdue' and channel = 'app' and membership_id = tests.id('m:A:adminA') and dedupe_key like 'invoice_overdue:' || tests.id('od3')::text || ':%'), true, 'R-015-37 本文に期日と、超えた日数');
select is((select title from public.notifications where kind = 'invoice_overdue' and channel = 'app' and membership_id = tests.id('m:A:adminA') and dedupe_key like 'invoice_overdue:' || tests.id('od3')::text || ':%'), '入金が遅れています：T-od3 テスト請求先A', 'R-015-37 題名に請求書の番号と取引先');
select is((select link from public.notifications where kind = 'invoice_overdue' and channel = 'app' and membership_id = tests.id('m:A:adminA') and dedupe_key like 'invoice_overdue:' || tests.id('od3')::text || ':%'), '/invoices/edit/?id=' || tests.id('od3')::text, 'R-015-37 リンクは請求書の画面');
select is(pg_temp.io('od7', 'staffA'), 0::bigint, 'R-015-37 作った人でも、金額を見る権限（amount.read）のないスタッフには作らない');
select is(pg_temp.io('od7', 'adminA'), 1::bigint, 'R-015-37 その場合も、管理者には作る');
select is(pg_temp.io('od10', 'adminA'), 1::bigint, 'R-015-37 作った人が分からない請求書は、管理者だけに作る');
select is(pg_temp.io('od10'), 1::bigint, 'R-015-37 作った人が分からないときの件数');
select is(pg_temp.io('od2'), 0::bigint, 'R-015-38 期日が今日の請求書は作らない');
select is(pg_temp.io('od9'), 0::bigint, 'R-015-38 期日がこれからの請求書は作らない');
select is(pg_temp.io('od4'), 0::bigint, 'R-015-38 入金で残高が0の請求書は、状況が送付のままでも作らない');
select is(pg_temp.io('od5'), 0::bigint, 'R-015-38 下書きは作らない');
select is(pg_temp.io('od6'), 0::bigint, 'R-015-38 取消は作らない');
select is(pg_temp.io('od8'), 0::bigint, 'R-015-38 入金済みは作らない');
select is(pg_temp.io('odB'), 0::bigint, 'R-015-38 A の処理は、ほかの会社の請求書に作らない');
select is(pg_temp.svc('invoice_overdue_notify', format('%L, null', tests.t('A'))) ->> 'notified', '0', 'R-015-38 もう一度呼んでも、同じ請求書・同じ期日には作らない');
update public.invoices set due_date = pg_temp.today() - 2, issue_date = pg_temp.today() - 32 where id = tests.id('od1');
select is(pg_temp.svc('invoice_overdue_notify', format('%L, null', tests.t('A'))) ->> 'notified', '2', 'R-015-38 期日を直したときは、新しい期日として作る');
select is(pg_temp.io('od1', 'adminA'), 2::bigint, 'R-015-38 同じ人に、期日ごとに1件');
select is(pg_temp.svc('invoice_overdue_notify', format('%L, null', tests.t('B'))) ->> 'notified', '4', 'R-015-37 B の処理は B の請求書だけ（B の管理者 B・multi（B では管理者）に、seed の請求書と合わせて）');
select is((select count(*) from public.notifications where kind = 'invoice_overdue' and channel = 'app' and dedupe_key like 'invoice_overdue:' || tests.id('odB')::text || ':%' and tenant_id = tests.t('B')), 2::bigint, 'R-015-37 B の請求書は、B の管理者2人に作る');
select is((select count(*) from public.notifications n where n.kind = 'invoice_overdue' and n.dedupe_key is not null
           and n.tenant_id <> (select i.tenant_id from public.invoices i where i.id = (regexp_match(n.dedupe_key, '^invoice_overdue:([0-9a-f-]+):'))[1]::uuid)), 0::bigint, 'R-015-38 お知らせの会社は、請求書の会社と同じ');

-- ===== 通知の送る前の行（種類の設定・端末。R-015-10・11 と同じ決まりが出来事にも効く）=====
-- staffA は端末を登録し、work_changed の通知を切っている（種）。work_tomorrow は初めの値（通知は入）
select is((select count(*) from public.notifications where kind = 'work_tomorrow' and channel = 'push' and membership_id = tests.id('m:A:staffA') and dedupe_key is not null), 1::bigint, 'R-015-33 端末のある人には、明日の作業の通知の「送る前」の行も作る（R-015-11）');
select is((select count(*) from public.notifications where kind = 'work_changed' and channel = 'push' and membership_id = tests.id('m:A:staffA') and dedupe_key is not null), 0::bigint, 'R-015-29 通知を切っている種類（予定の変更）は、通知の行を作らず、一覧の行だけ作る（R-015-10）');

select * from finish();
rollback;
