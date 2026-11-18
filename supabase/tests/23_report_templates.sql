-- 機能 009：ひな形と項目（R-009-1〜7）。型 A（書くのは master.edit）
begin;
select * from no_plan();
select tests.seed();

create or replace function pg_temp.rpc(p_uid uuid, p_fn text, p_id uuid) returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%L) as r', p_fn, p_id)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.rpc_err(p_uid uuid, p_fn text, p_id uuid) returns text language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%L) as r', p_fn, p_id)) ->> 'error'
$$;
create or replace function pg_temp.reasons(p jsonb) returns text language sql as $$
  select coalesce(string_agg(b ->> 'reason', ',' order by b ->> 'reason'), '') from jsonb_array_elements(coalesce(p -> 'blockers', '[]')) b
$$;
create or replace function pg_temp.deleted(p_table text, p_id uuid) returns boolean language plpgsql as $$
declare v boolean;
begin
  execute format('select deleted_at is not null from public.%I where id = %L', p_table, p_id) into v;
  return v;
end $$;

-- ===== R-009-1 ひな形 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.report_templates (tenant_id, building_id, name) values (%L, %L, 'テスト新規ひな形')$q$,
  tests.t('A'), tests.id('buildingA2'))), 1::bigint, 'R-009-1 社員は、建物を選んでひな形を作れる');
select is(tests.cnt(tests.u('adminA'), format($q$insert into public.report_templates (tenant_id, building_id, name) values (%L, %L, '管理者のひな形')$q$,
  tests.t('A'), tests.id('buildingA2'))), 1::bigint, 'R-009-1 管理者もひな形を作れる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.report_templates (tenant_id, building_id, name) values (%L, %L, '')$q$, tests.t('A'), tests.id('buildingA2'))), '23514',
  'R-009-1 名前が空なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.report_templates (tenant_id, building_id, name) values (%L, %L, '   ')$q$, tests.t('A'), tests.id('buildingA2'))), '23514',
  'R-009-1 名前が空白だけなら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.report_templates (tenant_id, building_id, name) values (%L, %L, '別会社の建物')$q$, tests.t('A'), tests.id('buildingB1'))), '23503',
  'R-009-1 別の会社の建物を指すひな形は保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.report_templates (tenant_id, building_id, name) values (%L, %L, 'テスト新規ひな形')$q$, tests.t('A'), tests.id('buildingA2'))), '23505',
  'R-009-1 同じ建物で同じ名前（消していない）のひな形は、2つ作れない');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.report_templates (tenant_id, building_id, name) values (%L, %L, 'テスト新規ひな形')$q$, tests.t('A'), tests.id('buildingA1'))), 1::bigint,
  'R-009-1 別の建物なら、同じ名前でもよい');
select is(tests.cnt(tests.u('memberA'), format($q$update public.report_templates set name = '直した名前' where id = %L$q$, tests.id('tplA1'))), 1::bigint, 'R-009-1 名前を直せる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.report_templates set active = false where id = %L$q$, tests.id('tplA1'))), 1::bigint, 'R-009-1 「使わない」にできる');
select is(tests.err(tests.u('memberA'), format($q$update public.report_templates set building_id = %L where id = %L$q$, tests.id('buildingA2'), tests.id('tplA1'))), '42501',
  'R-009-1 建物は直せない（項目の場所との組み合わせが崩れるため）');
select is(tests.cnt(tests.u('memberA'), format($q$update public.report_templates set name = '' where id = %L$q$, tests.id('tplA1'))), -1::bigint, 'R-009-1 名前を空には直せない');

-- ===== R-009-2 項目 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.template_items (tenant_id, template_id, area_id, name, sort) values (%L, %L, %L, '階段', 4)$q$,
  tests.t('A'), tests.id('tplA10'), tests.id('areaA10'))), 1::bigint, 'R-009-2 社員は、場所つきで項目を作れる');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.template_items (tenant_id, template_id, name, sort) values (%L, %L, '場所なしの項目', 5)$q$,
  tests.t('A'), tests.id('tplA10'))), 1::bigint, 'R-009-2 場所はなくてもよい');
select is(tests.err(tests.u('memberA'), format($q$insert into public.template_items (tenant_id, template_id, name) values (%L, %L, '')$q$, tests.t('A'), tests.id('tplA10'))), '23514',
  'R-009-2 名前が空なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.template_items (tenant_id, template_id, area_id, name) values (%L, %L, %L, 'ひな形と別の建物の場所')$q$,
  tests.t('A'), tests.id('tplA10'), tests.id('areaA1'))), '42501', 'R-009-2 ひな形の建物と違う建物の場所は保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.template_items (tenant_id, template_id, area_id, name) values (%L, %L, %L, '別会社の場所')$q$,
  tests.t('A'), tests.id('tplA10'), tests.id('areaB1'))), '42501', 'R-009-2 別の会社の場所は保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.template_items (tenant_id, template_id, name) values (%L, %L, '別会社のひな形')$q$, tests.t('A'), tests.id('tplB10'))), '23503',
  'R-009-2 別の会社のひな形を指す項目は保存しない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.template_items set name = '直した項目', sort = 9 where id = %L$q$, tests.id('tiA10-2'))), 1::bigint, 'R-009-2 項目の名前と並び順を直せる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.template_items set area_id = %L where id = %L$q$, tests.id('areaA10'), tests.id('tiA10-2'))), 1::bigint, 'R-009-2 場所を付けられる');
select is(tests.err(tests.u('memberA'), format($q$update public.template_items set area_id = %L where id = %L$q$, tests.id('areaA1'), tests.id('tiA10-2'))), '42501', 'R-009-2 別の建物の場所には直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.template_items set active = false where id = %L$q$, tests.id('tiA10-2'))), 1::bigint, 'R-009-2 項目を「使わない」にできる');
select is(tests.err(tests.u('memberA'), format($q$update public.template_items set template_id = %L where id = %L$q$, tests.id('tplA1'), tests.id('tiA10-1'))), '42501', 'R-009-2 項目のひな形は付け替えられない');

-- ===== R-009-3 読める人・書ける人 =====
select is(tests.n(tests.u('staffA'), 'select 1 from public.report_templates'), (select count(*) from public.report_templates where tenant_id = tests.t('A') and deleted_at is null) + 0::bigint,
  'R-009-3 スタッフは、会社のひな形を読める');
select cmp_ok(tests.n(tests.u('staffA'), 'select 1 from public.template_items'), '>=', 3::bigint, 'R-009-3 スタッフは、項目も読める');
select is(tests.err(tests.u('staffA'), format($q$insert into public.report_templates (tenant_id, building_id, name) values (%L, %L, 'スタッフが作る')$q$, tests.t('A'), tests.id('buildingA2'))), '42501',
  'R-009-3 master.edit のないスタッフは、ひな形を作れない');
select is(tests.err(tests.u('staffA'), format($q$insert into public.template_items (tenant_id, template_id, name) values (%L, %L, 'スタッフが作る')$q$, tests.t('A'), tests.id('tplA10'))), '42501',
  'R-009-3 スタッフは、項目を作れない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.report_templates set name = 'x' where id = %L$q$, tests.id('tplA10'))), 0::bigint, 'R-009-3 スタッフは、ひな形を直せない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.template_items set name = 'x' where id = %L$q$, tests.id('tiA10-1'))), 0::bigint, 'R-009-3 スタッフは、項目を直せない');
select is(tests.n(tests.u('extA'), 'select 1 from public.report_templates'), 0::bigint, 'R-009-3 外部の人は、ひな形を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.template_items'), 0::bigint, 'R-009-3 外部の人は、項目を読めない');
select is(tests.n(tests.u('staffB'), format('select 1 from public.report_templates where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-009-3 別の会社のひな形は読めない');
select is(tests.n(tests.u('staffB'), 'select 1 from public.report_templates'), 1::bigint, 'R-009-3 自分の会社のひな形は読める（会社 B は 1 つ）');
select is(tests.err(tests.u('memberA'), format('delete from public.report_templates where id = %L', tests.id('tplA10'))), '42501', 'R-009-3 行は削除（delete）できない');

-- ===== R-009-4 ひな形を消す =====
-- 作業と契約の中身がひな形を使う（外部キーでつなぐ）
update public.works set report_template_id = tests.id('tplA10') where id = tests.id('wA10');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_report_template', tests.id('tplA10')) ->> 'deactivated', 'true', 'R-009-4 作業が使うひな形は、消さずに「使わない」にする');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_report_template', tests.id('tplA10'))), 'used_by_reports,used_by_works', 'R-009-4 理由は「作業が使っている」（種の報告書も写している）');
select is((select active from public.report_templates where id = tests.id('tplA10')), false, 'R-009-4 「使わない」になっている');
select is(pg_temp.deleted('report_templates', tests.id('tplA10')), false, 'R-009-4 使われているひな形の行は残る');
update public.contract_services set report_template_id = tests.id('tplA1') where id = tests.id('svcA1-base');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_report_template', tests.id('tplA1'))), 'used_by_contract_services', 'R-009-4 契約の中身が使うひな形も、消さず理由を返す');
insert into public.report_templates (id, tenant_id, building_id, name) values (tests.id('tplDel'), tests.t('A'), tests.id('buildingA2'), '消すひな形');
insert into public.template_items (id, tenant_id, template_id, name) values (tests.id('tiDel'), tests.t('A'), tests.id('tplDel'), '消す項目');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_report_template', tests.id('tplDel')) ->> 'deleted', 'true', 'R-009-4 使われていないひな形は、論理削除される');
select is(pg_temp.deleted('report_templates', tests.id('tplDel')) and pg_temp.deleted('template_items', tests.id('tiDel')), true, 'R-009-4 項目も一緒に論理削除される');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_report_template', tests.id('tplDel')) ->> 'already', 'true', 'R-009-4 二度目は何もしない');
select is(pg_temp.rpc_err(tests.u('staffA'), 'delete_report_template', tests.id('tplA10')), '42501', 'R-009-4 master.edit のないスタッフは呼べない');
select is(pg_temp.rpc_err(tests.u('extA'), 'delete_report_template', tests.id('tplA10')), '42501', 'R-009-4 外部の人は呼べない（R-009-21）');
select is(pg_temp.rpc_err(tests.u('memberA'), 'delete_report_template', tests.id('tplB10')), '42501', 'R-009-4 別の会社のひな形は、権限がないのと同じ 42501');
select is(pg_temp.rpc_err(tests.u('memberA'), 'delete_report_template', gen_random_uuid()), '42501', 'R-009-4 存在しないひな形も同じ 42501');
select is(coalesce(tests.run_as_anon(format('select public.delete_report_template(%L)', tests.id('tplA10'))) ->> 'error', 'ok'), '42501', 'R-009-4 ログインしていない人は呼べない');

-- ===== R-009-5 項目を消す =====
select is(pg_temp.rpc(tests.u('memberA'), 'delete_template_item', tests.id('tiA10-1')) ->> 'deactivated', 'true', 'R-009-5 報告書の項目に写されている項目は、消さずに「使わない」にする');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_template_item', tests.id('tiA10-1'))), 'used_by_report_items', 'R-009-5 理由は「報告書の項目が使っている」');
select is((select active from public.template_items where id = tests.id('tiA10-1')), false, 'R-009-5 「使わない」になっている');
insert into public.template_items (id, tenant_id, template_id, name) values (tests.id('tiFree'), tests.t('A'), tests.id('tplA1'), '使われていない項目');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_template_item', tests.id('tiFree')) ->> 'deleted', 'true', 'R-009-5 写されていない項目は、論理削除される');
select is(pg_temp.rpc_err(tests.u('staffA'), 'delete_template_item', tests.id('tiA1-1')), '42501', 'R-009-5 スタッフは呼べない');
select is(pg_temp.rpc_err(tests.u('memberA'), 'delete_template_item', tests.id('tiB10-1')), '42501', 'R-009-5 別の会社の項目は 42501');

-- ===== R-009-6 作業・契約の中身のひな形の外部キー =====
select is(coalesce(tests.run_as_service(format($q$update public.works set report_template_id = %L where id = %L$q$, tests.id('tplB10'), tests.id('wA10'))) ->> 'error', 'ok'), '23503',
  'R-009-6 作業は、別の会社のひな形を指せない');
select is(coalesce(tests.run_as_service(format($q$update public.works set report_template_id = %L where id = %L$q$, gen_random_uuid(), tests.id('wA10'))) ->> 'error', 'ok'), '23503',
  'R-009-6 作業は、存在しないひな形を指せない');
select is(coalesce(tests.run_as_service(format($q$update public.works set report_template_id = %L where id = %L$q$, tests.id('tplA10'), tests.id('wA10'))) ->> 'error', 'ok'), 'ok', 'R-009-6 作業は、自社のひな形を指せる');
select is(coalesce(tests.run_as_service(format($q$update public.works set report_template_id = null where id = %L$q$, tests.id('wA10'))) ->> 'error', 'ok'), 'ok', 'R-009-6 作業のひな形は空でもよい');
select is(coalesce(tests.run_as_service(format($q$update public.contract_services set report_template_id = %L where id = %L$q$, tests.id('tplB10'), tests.id('svcA1-base'))) ->> 'error', 'ok'), '23503',
  'R-009-6 契約の中身は、別の会社のひな形を指せない');
select is(coalesce(tests.run_as_service(format($q$update public.contract_services set report_template_id = %L where id = %L$q$, gen_random_uuid(), tests.id('svcA1-base'))) ->> 'error', 'ok'), '23503',
  'R-009-6 契約の中身は、存在しないひな形を指せない');
select is(coalesce(tests.run_as_service(format($q$update public.contract_services set report_template_id = %L where id = %L$q$, tests.id('tplA1'), tests.id('svcA1-base'))) ->> 'error', 'ok'), 'ok',
  'R-009-6 契約の中身は、自社のひな形を指せる');

-- ===== R-009-7 建物を消すと、ひな形と項目も消える =====
insert into public.buildings (id, tenant_id, client_id, name, address) values (tests.id('bT'), tests.t('A'), tests.id('clientA1'), 'テストひな形つきの建物', 'x');
insert into public.building_areas (id, tenant_id, building_id, name) values (tests.id('bT-area'), tests.t('A'), tests.id('bT'), 'ひな形の場所');
insert into public.report_templates (id, tenant_id, building_id, name) values (tests.id('bT-tpl'), tests.t('A'), tests.id('bT'), 'ひな形');
insert into public.template_items (id, tenant_id, template_id, area_id, name) values (tests.id('bT-item'), tests.t('A'), tests.id('bT-tpl'), tests.id('bT-area'), '項目');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_building_area', tests.id('bT-area'))), 'used_by_template_items', 'R-009-7 項目から使われている場所は、消さずに「使わない」にする');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_building', tests.id('bT')) ->> 'ok', 'true', 'R-009-7 社員は、ひな形のある建物を消せる');
select is(pg_temp.deleted('report_templates', tests.id('bT-tpl')) and pg_temp.deleted('template_items', tests.id('bT-item')), true, 'R-009-7 建物を消すと、ひな形と項目も一緒に論理削除される');

select * from finish();
rollback;
