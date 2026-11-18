-- 会社をまたがない守り（R-001-19、R-001-2、R-001-4、R-001-23）を、登録されたすべての表に流す。
-- 後の機能は、tests.seed() に自分の表の会社ごとの行を足すと、この確かめに自動で入る。
begin;
select * from no_plan();
select tests.seed();

-- 表ごとに：自分の会社の行は A の人から見える/見えない、別の会社 B の行は見えない・書けない・消せない。
create or replace function pg_temp.leak(p_uid uuid, p_other uuid) returns jsonb language plpgsql as $$
declare r record; v jsonb := '{}'; n bigint; res jsonb;
begin
  for r in select table_name, tenant_col from app.policy_registry
           where split_part(policy_type, '+', 1) not in ('M', 'P') order by 1 loop
    res := tests.run_as(p_uid, format('select 1 from public.%I where %I = %L', r.table_name, r.tenant_col, p_other));
    n := coalesce(jsonb_array_length(res -> 'rows'), 0);
    if n > 0 then v := v || jsonb_build_object(r.table_name || ':select', n); end if;
    res := tests.run_as(p_uid, format('update public.%I set %I = %I where %I = %L', r.table_name, r.tenant_col, r.tenant_col, r.tenant_col, p_other));
    if coalesce((res ->> 'count')::bigint, 0) > 0 then v := v || jsonb_build_object(r.table_name || ':update', res -> 'count'); end if;
    res := tests.run_as(p_uid, format('delete from public.%I where %I = %L', r.table_name, r.tenant_col, p_other));
    if coalesce((res ->> 'count')::bigint, 0) > 0 then v := v || jsonb_build_object(r.table_name || ':delete', res -> 'count'); end if;
  end loop;
  return v;
end $$;

-- 種が足りているか（空の表は、確かめにならない）
create or replace function pg_temp.empty_seed_tables(p_tenant uuid) returns text language plpgsql as $$
declare r record; n bigint; v text := '';
begin
  for r in select table_name, tenant_col from app.policy_registry where split_part(policy_type, '+', 1) not in ('M', 'P') order by 1 loop
    execute format('select count(*) from public.%I where %I = %L', r.table_name, r.tenant_col, p_tenant) into n;
    if n = 0 then v := v || r.table_name || ','; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.empty_seed_tables(tests.t('B')), '', 'R-001-19 すべての表に、別の会社（B）の種の行がある（なければ tests.seed() に足す）');
select is(pg_temp.empty_seed_tables(tests.t('A')), '', 'R-001-19 すべての表に、会社 A の種の行がある');

select is(pg_temp.leak(tests.u('adminA'), tests.t('B')), '{}'::jsonb, 'R-001-19 A の管理者は、B の行をどの表でも読めず・直せず・消せない');
select is(pg_temp.leak(tests.u('memberA'), tests.t('B')), '{}'::jsonb, 'R-001-19 A の社員は、B の行をどの表でも読めず・直せず・消せない');
select is(pg_temp.leak(tests.u('staffA'), tests.t('B')), '{}'::jsonb, 'R-001-19 A のスタッフは、B の行をどの表でも読めず・直せず・消せない');
select is(pg_temp.leak(tests.u('extA'), tests.t('B')), '{}'::jsonb, 'R-001-19 A の外部の人は、B の行をどの表でも読めず・直せず・消せない');
select is(pg_temp.leak(tests.u('adminB'), tests.t('A')), '{}'::jsonb, 'R-001-19 B の管理者は、A の行をどの表でも読めず・直せず・消せない');
select is(pg_temp.leak(tests.u('nobody'), tests.t('A')), '{}'::jsonb, 'R-001-19 どの会社にも属さない人は、A の行をどの表でも読めない');
select is(pg_temp.leak(tests.u('nobody'), tests.t('B')), '{}'::jsonb, 'R-001-19 どの会社にも属さない人は、B の行をどの表でも読めない');

-- 数も分からない（count も 0）
select is(tests.run_as(tests.u('adminA'), 'select count(*)::int as c from public.offices where tenant_id = ''' || tests.t('B') || '''') -> 'rows' -> 0 ->> 'c',
          '0', 'R-001-19 別の会社の行の数も分からない（count が 0）');

-- anon は何も読めない
select is(tests.run_as_anon('select 1 from public.tenants') ->> 'error', '42501', 'R-001-19 ログインしていない人は、会社を読めない');
select is(tests.run_as_anon('select 1 from public.offices') ->> 'error', '42501', 'R-001-19 ログインしていない人は、拠点を読めない');

-- 運営：許しがなければ、会社の業務のデータは読めない
select is(pg_temp.leak(tests.u('operator'), tests.t('A')), '{}'::jsonb, 'R-001-2 運営は、許可がなければ A のデータをどの表でも読めない');
select is(pg_temp.leak(tests.u('operator'), tests.t('B')), '{}'::jsonb, 'R-001-2 運営は、許可がなければ B のデータをどの表でも読めない');

-- 運営：期間つきの許可の間だけ、読める（書けない）。期限が過ぎるか取り消せば、読めない
insert into public.support_access_grants (id, tenant_id, granted_by, reason, starts_at, ends_at)
values (tests.id('grantA-now'), tests.t('A'), tests.u('adminA'), '問い合わせ', now() - interval '1 hour', now() + interval '1 hour');

select is(tests.n(tests.u('operator'), 'select 1 from public.offices where tenant_id = ''' || tests.t('A') || ''''), 1::bigint,
          'R-001-3 許可の間、運営は A の拠点を読める');
select is(tests.n(tests.u('operator'), 'select 1 from public.offices where tenant_id = ''' || tests.t('B') || ''''), 0::bigint,
          'R-001-3 許可は A だけ。運営は B の拠点を読めない');
select is(tests.n(tests.u('operator'), 'select 1 from public.job_runs where tenant_id = ''' || tests.t('A') || ''''), 1::bigint,
          'R-001-3 許可の間、運営は A の処理の記録（型 E）も読める');
select is(tests.n(tests.u('operator'), 'select 1 from public.client_error_logs where tenant_id = ''' || tests.t('A') || ''''), 1::bigint,
          'R-001-3 許可の間、運営は A の端末のエラー（型 C）も読める');
select is(tests.cnt(tests.u('operator'), 'update public.offices set name = ''変更'' where tenant_id = ''' || tests.t('A') || ''''), 0::bigint,
          'R-001-3 許可の間も、運営は書けない（update が0行）');
select is(tests.err(tests.u('operator'), 'insert into public.offices (tenant_id, name) values (''' || tests.t('A') || ''', ''運営の拠点'')'), '42501',
          'R-001-3 許可の間も、運営は書けない（insert が拒否）');

update public.support_access_grants set revoked_at = now() where id = tests.id('grantA-now');
select is(tests.n(tests.u('operator'), 'select 1 from public.offices where tenant_id = ''' || tests.t('A') || ''''), 0::bigint,
          'R-001-4 管理者が取り消したら、運営はすぐ読めない');

update public.support_access_grants set revoked_at = null, starts_at = now() - interval '2 hours', ends_at = now() - interval '1 second'
where id = tests.id('grantA-now');
select is(tests.n(tests.u('operator'), 'select 1 from public.offices where tenant_id = ''' || tests.t('A') || ''''), 0::bigint,
          'R-001-4 期間が過ぎたら、運営は読めない');

-- 普通の利用者に operator の印を勝手に付けても、許可がなければ読めない（印は JWT の app_metadata。許可は別に要る）
select is(tests.n(tests.u('adminB'), 'select 1 from public.offices where tenant_id = ''' || tests.t('A') || ''''), 0::bigint,
          'R-001-2 運営でない人は、許可があっても別の会社を読めない');

select * from finish();
rollback;
