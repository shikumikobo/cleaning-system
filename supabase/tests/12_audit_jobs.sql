-- 変更の履歴と処理の記録（R-001-26〜29）
begin;
select * from no_plan();
select tests.seed();

-- 種の insert でも、型 A・B・E は履歴が付く
select ok((select count(*) from public.audit_logs where table_name = 'offices' and row_id = tests.id('officeA') and action = 'insert') = 1,
          'R-001-26 型 A の表（拠点）の作成が履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'memberships' and action = 'insert') > 0, 'R-001-26 型 E の表（所属）の作成が履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'tenants' and row_id = tests.t('A')) = 1, 'R-001-26 会社（tenants。会社の id は row_id）の作成が履歴に残る');
select is((select tenant_id from public.audit_logs where table_name = 'tenants' and row_id = tests.t('A')), tests.t('A'), 'R-001-26 会社の履歴の tenant_id は会社自身');

-- 画面（直接）から拠点を直す：だれが・いつ・どこから・何を（前と後）
select is(tests.cnt(tests.u('adminA'), format('update public.offices set name = ''本社A（移転）'', address = ''東京'' where id = %L', tests.id('officeA'))), 1::bigint, 'R-001-26 管理者が拠点を直せる');
select is((select a.action from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.action = 'update'), 'update', 'R-001-26 直したことが履歴に残る');
select is((select a.actor from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.action = 'update'), tests.u('adminA'), 'R-001-26 だれが（actor）が残る');
select is((select a.source from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.action = 'update'), 'ui', 'R-001-26 どこから（source）：画面の直接の書き込みは ui');
select ok((select a.at from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.action = 'update') > now() - interval '1 minute', 'R-001-26 いつ（at）が残る');
select is((select a.changed -> 'name' from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.action = 'update'),
          '{"old": "本社A", "new": "本社A（移転）"}'::jsonb, 'R-001-26 何を：変わった列の前と後が残る');
select is((select a.changed -> 'address' from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.action = 'update'),
          '{"old": null, "new": "東京"}'::jsonb, 'R-001-26 何を：前が空の列も残る');
select ok(not (select a.changed ? 'tenant_id' from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.action = 'update'),
          'R-001-26 変わっていない列は履歴に入れない');
select ok(not (select a.changed ? 'updated_at' from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.action = 'update'),
          'R-001-26 updated_at だけの変化は列として残さない');
select is((select count(*)::int from public.audit_logs where table_name = 'offices' and row_id = tests.id('officeA') and action = 'update'), 1,
          'R-001-26 1回の直しで履歴は1件');

-- 論理削除（deleted_at を入れる）も update の履歴
select is(tests.cnt(tests.u('adminA'), format('update public.offices set deleted_at = now() where id = %L', tests.id('officeA'))), 1::bigint, 'R-001-26 論理削除ができる');
select ok((select a.changed ? 'deleted_at' from public.audit_logs a where a.table_name = 'offices' and a.row_id = tests.id('officeA') and a.changed ? 'deleted_at' and a.action = 'update'),
          'R-001-26 論理削除も履歴に残る');

-- 何も変わらない update は履歴を作らない
select is(tests.cnt(tests.u('adminA'), format('update public.offices set name = name where id = %L', tests.id('officeB'))), 0::bigint, '別の会社の拠点は、同じ値でも更新できない');
select is(tests.cnt(tests.u('adminB'), format('update public.offices set name = name where id = %L', tests.id('officeB'))), 1::bigint, '自分の会社の拠点');
select is((select count(*)::int from public.audit_logs where table_name = 'offices' and row_id = tests.id('officeB') and action = 'update'), 0, 'R-001-26 変わった列がなければ履歴を作らない');

-- RPC：source は rpc、1つの操作で変わった行は同じ request_id
select is(tests.err(tests.u('adminA'), format('select public.update_tenant_info(%L, ''会社A改'', ''住所'', null, null)', tests.t('A'))), null, 'R-001-26 RPC で会社の情報を直せる');
select is((select a.source from public.audit_logs a where a.table_name = 'tenants' and a.row_id = tests.t('A') and a.action = 'update' and a.changed ? 'name'), 'rpc', 'R-001-26 どこから：RPC は rpc');
select is((select a.actor from public.audit_logs a where a.table_name = 'tenants' and a.row_id = tests.t('A') and a.action = 'update' and a.changed ? 'name'), tests.u('adminA'), 'R-001-26 RPC でも、だれが（actor）が残る');
select is(tests.err(tests.u('adminA'), format('select public.grant_support_access(%L, ''調査'', now() + interval ''1 day'')', tests.t('A'))), null, 'R-001-26 運営の許可を作れる');
select ok((select count(distinct request_id) from public.audit_logs where table_name = 'support_access_grants' and action = 'insert' and source = 'rpc') = 1, 'R-001-26 RPC の変更は rpc として残る');

-- 運営（service_role）の直接の書き込みは job（新しい操作として始める）
select set_config('app.source', '', true);
select is(tests.run_as_service(format('insert into public.offices (tenant_id, name) values (%L, ''定時で作った'')', tests.t('A'))) ->> 'error', null, 'R-001-26 service_role は拠点を書ける');
select is((select a.source from public.audit_logs a where a.table_name = 'offices' and a.changed -> 'name' ->> 'new' = '定時で作った'), 'job', 'R-001-26 どこから：service_role は job');

-- 同じトランザクションの変更は request_id でまとまる
select is((select count(distinct request_id)::int from public.audit_logs where table_name = 'offices' and action = 'insert' and changed -> 'name' ->> 'new' in ('本社A', '本社B')),
          1, 'R-001-26 1つのトランザクションで作った行は、同じ request_id でまとまる');

-- R-001-27 履歴は、だれも直せず・消せない
select is(tests.cnt(tests.u('adminA'), format('update public.audit_logs set action = ''delete'' where tenant_id = %L', tests.t('A'))), -1::bigint, 'R-001-27 管理者も履歴を直せない');
select is(tests.cnt(tests.u('adminA'), format('delete from public.audit_logs where tenant_id = %L', tests.t('A'))), -1::bigint, 'R-001-27 管理者も履歴を消せない');
select is(tests.err(tests.u('adminA'), format('insert into public.audit_logs (tenant_id, table_name, action, changed, source, request_id) values (%L, ''x'', ''insert'', ''{}'', ''ui'', gen_random_uuid())', tests.t('A'))), '42501', 'R-001-27 管理者は履歴を直接は書き足せない');
select is(tests.run_as_service('update public.audit_logs set action = ''delete''') ->> 'error', '42501', 'R-001-27 運営（service_role）も履歴を直せない');
select is(tests.run_as_service('delete from public.audit_logs') ->> 'error', '42501', 'R-001-27 運営（service_role）も履歴を消せない');
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
select is(pg_temp.try('update public.audit_logs set action = ''delete'''), '42501', 'R-001-27 データベースの持ち主（postgres）も履歴を直せない');
select is(pg_temp.try('delete from public.audit_logs'), '42501', 'R-001-27 データベースの持ち主も履歴を消せない');
select is(pg_temp.try('truncate public.audit_logs'), '42501', 'R-001-27 データベースの持ち主も履歴を全部は消せない');

-- R-001-28 管理者でない人は読めない
select ok(tests.n(tests.u('adminA'), format('select 1 from public.audit_logs where tenant_id = %L', tests.t('A'))) > 0, 'R-001-28 管理者は自分の会社の履歴を読める');
select is(tests.n(tests.u('adminA'), format('select 1 from public.audit_logs where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-001-28 管理者も別の会社の履歴は読めない');
select is(tests.n(tests.u('memberA'), 'select 1 from public.audit_logs'), 0::bigint, 'R-001-28 社員は履歴を読めない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.audit_logs'), 0::bigint, 'R-001-28 スタッフは履歴を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.audit_logs'), 0::bigint, 'R-001-28 外部の人は履歴を読めない');
select is(tests.n(tests.u('nobody'), 'select 1 from public.audit_logs'), 0::bigint, 'R-001-28 どの会社にも属さない人は履歴を読めない');

-- R-001-29 処理の記録（Edge Function と定時の処理。会社ごと・1回ごと）
select is(tests.run_as_service(format('insert into public.job_runs (tenant_id, kind, status, counts) values (%L, ''create_works'', ''running'', ''{}'')', tests.t('A'))) ->> 'error', null,
          'R-001-29 処理が始まったとき、会社ごとに記録を作れる（service_role）');
select is(tests.run_as_service(format('update public.job_runs set status = ''success'', ended_at = now(), counts = ''{"created": 12}'' where tenant_id = %L and kind = ''create_works''', tests.t('A'))) ->> 'error', null,
          'R-001-29 処理が終わったとき、結果と件数を書ける');
select is((select counts ->> 'created' from public.job_runs where tenant_id = tests.t('A') and kind = 'create_works'), '12', 'R-001-29 件数が残る');
select ok((select started_at is not null and ended_at is not null and status = 'success' from public.job_runs where tenant_id = tests.t('A') and kind = 'create_works'), 'R-001-29 始まり・終わり・結果が残る');
select is(tests.run_as_service(format('insert into public.job_runs (tenant_id, kind, status, error) values (%L, ''notify'', ''failure'', ''送れなかった'')', tests.t('B'))) ->> 'error', null, 'R-001-29 失敗したときはエラーを記録できる');
select is((select error from public.job_runs where tenant_id = tests.t('B') and kind = 'notify'), '送れなかった', 'R-001-29 エラーが残る');
select is(tests.run_as_service('insert into public.job_runs (kind, status) values (''no-tenant'', ''success'')') ->> 'error', '23502', 'R-001-29 処理の記録は、必ず会社を持つ（会社ごとに分けて回す）');
select is(tests.n(tests.u('adminA'), format('select 1 from public.job_runs where tenant_id = %L and kind = ''create_works''', tests.t('A'))), 1::bigint, 'R-001-29 管理者は自分の会社の処理の記録を読める');
select is(tests.n(tests.u('adminA'), format('select 1 from public.job_runs where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-001-29 別の会社の処理の記録は読めない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.job_runs'), 0::bigint, 'R-001-29 管理者でない人は処理の記録を読めない');
select is(tests.err(tests.u('adminA'), format('insert into public.job_runs (tenant_id, kind) values (%L, ''x'')', tests.t('A'))), '42501', 'R-001-29 管理者も処理の記録を直接は書けない');

select * from finish();
rollback;
