-- 機能 009：外部の人が読める報告書・項目・写真（R-009-19・20・22）。型 D（提出済みで、許された建物のものだけ）
begin;
select * from no_plan();
select tests.seed();

create or replace function pg_temp.ids(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
  v := tests.run_as(p_uid, p_sql);
  if v ? 'error' then return 'ERROR ' || (v ->> 'error'); end if;
  return coalesce((select string_agg(r ->> 'id', ',' order by r ->> 'id') from jsonb_array_elements(v -> 'rows') r), '');
end $$;
create or replace function pg_temp.idlist(variadic p_names text[]) returns text language sql as $$
  select coalesce(string_agg(tests.id(n)::text, ',' order by tests.id(n)::text), '') from unnest(p_names) n
$$;
-- 建物 A1（外部の人 extA が許された建物）と A2（許されていない建物）の作業・報告書・項目・写真
create or replace function pg_temp.mk(p_name text, p_building text, p_status text) returns void language plpgsql as $$
begin
  insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status)
  values (tests.id('w:' || p_name), tests.t('A'), tests.id(p_building), tests.id('svcA1-base'), tests.id('key:A1-base'), '外部のテスト：' || p_name, current_date - 5, 'done');
  insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('wa:' || p_name), tests.t('A'), tests.id('w:' || p_name), tests.id('m:A:staffA'));
  insert into public.reports (id, tenant_id, work_id, status, checked_by, checked_at, submitted_by, submitted_at)
  values (tests.id(p_name), tests.t('A'), tests.id('w:' || p_name), p_status,
          case when p_status <> 'draft' then tests.id('m:A:memberA') end, case when p_status <> 'draft' then now() end,
          case when p_status = 'submitted' then tests.id('m:A:memberA') end, case when p_status = 'submitted' then now() end);
  insert into public.report_items (id, tenant_id, report_id, name) values (tests.id('i:' || p_name), tests.t('A'), tests.id(p_name), '項目：' || p_name);
  perform tests.make_photo('A', 'p:' || p_name, p_building, 'staffA', 'after', format('work_id, report_item_id|%L, %L', tests.id('w:' || p_name), tests.id('i:' || p_name)));
end $$;
select pg_temp.mk('eSub', 'buildingA1', 'submitted');
select pg_temp.mk('eChk', 'buildingA1', 'checked');
select pg_temp.mk('eDra', 'buildingA1', 'draft');
select pg_temp.mk('eA2', 'buildingA2', 'submitted');
-- 提出した報告書の、項目につかない写真（気づき）
select tests.make_photo('A', 'p:eFree', 'buildingA1', 'staffA', 'observation', format('work_id|%L', tests.id('w:eSub')));

-- ===== R-009-19 報告書と項目 =====
select is(pg_temp.ids(tests.u('extA'), 'select id from public.reports'), pg_temp.idlist('eSub'), 'R-009-19 外部の人が読める報告書は、提出済みで、許された建物のものだけ（下書き・確認済み・許されていない建物は読めない）');
select is(pg_temp.ids(tests.u('extA'), 'select id from public.report_items'), pg_temp.idlist('i:eSub'), 'R-009-19 項目も、提出済みの報告書のものだけ');
select is(tests.n(tests.u('extB'), 'select 1 from public.reports'), 0::bigint, 'R-009-19 別の会社の外部の人は、A の報告書を読めない（B の許された建物 B1 には提出済みの報告書がない）');
select is(tests.n(tests.u('extB'), format('select 1 from public.report_items where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-009-19 別の会社の外部の人は、A の項目を読めない');
select is(pg_temp.ids(tests.u('extA'), format('select id from public.reports where id = %L', tests.id('eChk'))), '', 'R-009-19 確認済み（まだ提出していない）は読めない');
-- 報告書を提出した作業の建物が、許された建物でなくなると読めない
update public.external_building_access set deleted_at = now() where id = tests.id('ebaA');
select is(tests.n(tests.u('extA'), 'select 1 from public.reports'), 0::bigint, 'R-009-19 建物の許しを外されると、提出済みの報告書も読めなくなる');
update public.external_building_access set deleted_at = null where id = tests.id('ebaA');
-- 提出の状況を戻す（検査用）と、読めなくなる
update public.reports set status = 'checked', submitted_at = null, submitted_by = null where id = tests.id('eSub');
select is(tests.n(tests.u('extA'), 'select 1 from public.reports'), 0::bigint, 'R-009-19 提出でなくなれば（確認済みに戻れば）、読めなくなる');
update public.reports set status = 'submitted', submitted_at = now(), submitted_by = tests.id('m:A:memberA') where id = tests.id('eSub');
select is(pg_temp.ids(tests.u('extA'), 'select id from public.reports'), pg_temp.idlist('eSub'), '（前提）提出に戻すと、また読める');
update public.reports set deleted_at = now() where id = tests.id('eSub');
select is(tests.n(tests.u('extA'), 'select 1 from public.reports'), 0::bigint, 'R-009-19 消した報告書は、外部の人は読めない');
update public.reports set deleted_at = null where id = tests.id('eSub');

select is(coalesce(tests.run_as(tests.u('extA'), format('insert into public.reports (tenant_id, work_id) values (%L, %L)', tests.t('A'), tests.id('w:eDra'))) ->> 'error', 'ok'), '42501', 'R-009-19 外部の人は、報告書を作れない');
select is(coalesce(tests.run_as(tests.u('extA'), format('insert into public.report_items (tenant_id, report_id, name) values (%L, %L, ''x'')', tests.t('A'), tests.id('eSub'))) ->> 'error', 'ok'), '42501', 'R-009-19 外部の人は、項目を作れない');
select is(tests.cnt(tests.u('extA'), format($q$update public.reports set remarks = 'x' where id = %L$q$, tests.id('eSub'))), 0::bigint, 'R-009-19 外部の人は、報告書を直せない');
select is(tests.cnt(tests.u('extA'), format($q$update public.report_items set done = true where id = %L$q$, tests.id('i:eSub'))), 0::bigint, 'R-009-19 外部の人は、項目を直せない');
select is(tests.n(tests.u('extA'), format('select 1 from public.works where id = %L', tests.id('w:eSub'))), 1::bigint, '（010）外部の人は、許された建物の作業の日と状況を読める');

-- ===== R-009-20 写真 =====
select is(pg_temp.ids(tests.u('extA'), 'select id from public.photos'), pg_temp.idlist('p:eSub'), 'R-009-20 外部の人が読める写真は、提出済みの報告書の項目につく、許された建物の写真だけ');
select is(pg_temp.ids(tests.u('extA'), format('select id from public.photos where id in (%L, %L, %L)', tests.id('p:eChk'), tests.id('p:eDra'), tests.id('p:eA2'))), '',
  'R-009-20 確認済み・下書きの報告書の写真と、許されていない建物の写真は読めない');
select is(pg_temp.ids(tests.u('extA'), format('select id from public.photos where id = %L', tests.id('p:eFree'))), '', 'R-009-20 項目につかない写真（気づき）は、提出済みの報告書の作業でも読めない');
select is(tests.n(tests.u('extB'), format('select 1 from public.photos where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-009-20 別の会社の外部の人は読めない');
create or replace function pg_temp.vis(p_building text, p_item text) returns boolean language sql as $$
  select (tests.run_as(tests.u('extA'), format('select app.photo_external_visible(%L, %L, %s) as r', tests.t('A'), tests.id(p_building),
          coalesce(quote_literal(tests.id(p_item)), 'null'))) -> 'rows' -> 0 ->> 'r')::boolean
$$;
select is(pg_temp.vis('buildingA1', 'i:eSub'), true, 'R-009-20 判定の関数：提出済みの項目・許された建物は、真');
select is(pg_temp.vis('buildingA1', 'i:eChk') or pg_temp.vis('buildingA1', null) or pg_temp.vis('buildingA2', 'i:eSub') or pg_temp.vis('buildingA2', 'i:eA2'), false,
  'R-009-20 判定の関数：確認済みの項目・項目なし・項目と違う建物・許されていない建物は、偽');
select is(tests.cnt(tests.u('extA'), format($q$update public.photos set kind = 'before' where id = %L$q$, tests.id('p:eSub'))), 0::bigint, 'R-009-20 外部の人は、読める写真も直せない・消せない');
select is(coalesce(tests.run_as(tests.u('extA'), format(
  $q$insert into public.photos (tenant_id, building_id, kind, taken_at, taken_by, storage_path, thumb_path, width, height, bytes) values (%L, %L, 'before', now(), %L, 'x', 'y', 1, 1, 1)$q$,
  tests.t('A'), tests.id('buildingA1'), tests.id('m:A:extA'))) ->> 'error', 'ok'), '42501', 'R-009-20 外部の人は、写真を作れない');
select is((select policy_type from app.policy_registry where table_name = 'reports') || ',' || (select policy_type from app.policy_registry where table_name = 'report_items'), 'C2+D,C2+D',
  'R-009-19 報告書と項目は、型 C2 に外部の型 D を足した形で登録されている');

-- ===== R-009-22 別の会社 =====
select is(tests.n(tests.u('adminA'), format('select 1 from public.reports where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-009-22 別の会社の報告書は、管理者も読めない');
select is(tests.n(tests.u('adminA'), format('select 1 from public.report_templates where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-009-22 別の会社のひな形は、管理者も読めない');
select is(tests.n(tests.u('adminA'), format('select 1 from public.report_items where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-009-22 別の会社の項目は、管理者も読めない');
select is(tests.n(tests.u('adminA'), format('select 1 from public.template_items where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-009-22 別の会社のひな形の項目は、管理者も読めない');
select is((select string_agg(policy_type, ',' order by table_name) from app.policy_registry where table_name in ('report_templates', 'template_items')), 'A,A', 'R-009-22 ひな形と項目は型 A で登録されている（全部の表の漏れの確かめに入る）');

select * from finish();
rollback;
