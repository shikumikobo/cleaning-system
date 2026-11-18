-- 機能 009：報告書・項目・確認と提出の RPC・写真の固定（R-009-8〜18・21・23）。型 C2（作業の担当）
begin;
select * from no_plan();
select tests.seed();

select tests.make_user('staff2A');
select tests.make_member('A', 'staff2A', 'staff');

-- ---- 道具 ----
create or replace function pg_temp.rpc(p_uid uuid, p_fn text, p_id uuid) returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%L) as r', p_fn, p_id)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.rpc_err(p_uid uuid, p_fn text, p_id uuid) returns text language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%L) as r', p_fn, p_id)) ->> 'error'
$$;
-- 作業を作る（担当の所属名を渡す。建物は A10 の定期清掃）
create or replace function pg_temp.mkwork(p_name text, p_members text[] default '{}', p_building text default 'buildingA10', p_svc text default 'svcA10-base') returns uuid language plpgsql as $$
declare m text;
begin
  insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status)
  values (tests.id(p_name), tests.t('A'), tests.id(p_building), tests.id(p_svc), tests.id('key:' || p_name), '報告書のテスト：' || p_name, current_date - 1, 'done');
  foreach m in array p_members loop
    insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('wa:' || p_name || ':' || m), tests.t('A'), tests.id(p_name), tests.id('m:A:' || m));
  end loop;
  return tests.id(p_name);
end $$;
-- 報告書を RLS を通らずに作る（状況つき）
create or replace function pg_temp.mkreport(p_name text, p_work text, p_status text default 'draft') returns uuid language plpgsql as $$
begin
  insert into public.reports (id, tenant_id, work_id, template_id, status, checked_by, checked_at, submitted_by, submitted_at)
  values (tests.id(p_name), tests.t('A'), tests.id(p_work), tests.id('tplA10'), p_status,
          case when p_status <> 'draft' then tests.id('m:A:memberA') end, case when p_status <> 'draft' then now() end,
          case when p_status = 'submitted' then tests.id('m:A:memberA') end, case when p_status = 'submitted' then now() end);
  return tests.id(p_name);
end $$;
create or replace function pg_temp.mkitem(p_name text, p_report text, p_sort int default 1) returns uuid language plpgsql as $$
begin
  insert into public.report_items (id, tenant_id, report_id, name, sort) values (tests.id(p_name), tests.t('A'), tests.id(p_report), p_name, p_sort);
  return tests.id(p_name);
end $$;
-- 報告書を、その人として作る。結果は 'ok' か SQLSTATE
create or replace function pg_temp.rins(p_uid uuid, p_name text, p_work text, p_extra_cols text default '', p_extra_vals text default '', p_tenant text default 'A') returns text language sql as $$
  select coalesce(tests.run_as(p_uid, format(
    'insert into public.reports (id, tenant_id, work_id%s) values (%L, %L, %L%s)',
    case when p_extra_cols = '' then '' else ', ' || p_extra_cols end,
    tests.id(p_name), tests.t(p_tenant), tests.id(p_work), case when p_extra_vals = '' then '' else ', ' || p_extra_vals end)) ->> 'error', 'ok')
$$;
create or replace function pg_temp.iins(p_uid uuid, p_name text, p_report text, p_extra_cols text default '', p_extra_vals text default '', p_tenant text default 'A', p_item_name text default '項目') returns text language sql as $$
  select coalesce(tests.run_as(p_uid, format(
    'insert into public.report_items (id, tenant_id, report_id, name%s) values (%L, %L, %L, %L%s)',
    case when p_extra_cols = '' then '' else ', ' || p_extra_cols end,
    tests.id(p_name), tests.t(p_tenant), tests.id(p_report), p_item_name, case when p_extra_vals = '' then '' else ', ' || p_extra_vals end)) ->> 'error', 'ok')
$$;
-- 写真を、その人として作る（項目つき）
create or replace function pg_temp.pins(p_uid uuid, p_name text, p_work text, p_item text, p_member text, p_kind text default 'before') returns text language sql as $$
  select coalesce(tests.run_as(p_uid, format(
    'insert into public.photos (id, tenant_id, building_id, work_id, report_item_id, kind, taken_at, taken_by, storage_path, thumb_path, width, height, bytes) values (%L, %L, %L, %s, %s, %L, now(), %L, %L, %L, 1600, 1200, 300000)',
    tests.id(p_name), tests.t('A'), tests.id('buildingA10'), coalesce(quote_literal(tests.id(p_work)), 'null'), coalesce(quote_literal(tests.id(p_item)), 'null'), p_kind,
    tests.id('m:A:' || p_member), tests.photo_path('A', p_name), tests.photo_path('A', p_name, 'thumb.jpg'))) ->> 'error', 'ok')
$$;

select pg_temp.mkwork('wR1', array['staffA']);
select pg_temp.mkwork('wR2', array['staff2A']);
select pg_temp.mkwork('wR3', array['staffA', 'staff2A']);
select pg_temp.mkwork('wRn', array[]::text[]);
select pg_temp.mkwork('wRx', array['staffA']);
select pg_temp.mkwork('wRc', array['staffA']);
select pg_temp.mkwork('wRd', array['staffA']);
select pg_temp.mkwork('wRf', array['staffA']);
select pg_temp.mkwork('wRg', array['staffA']);

-- ===== R-009-8 報告書を作る =====
select is(pg_temp.rins(tests.u('staffA'), 'r1', 'wR1', 'template_id, client_created_at, device_id', format('%L, now(), %L', tests.id('tplA10'), 'dev-1')), 'ok', 'R-009-8 担当のスタッフは、自分の作業の報告書（下書き）を作れる');
select is((select status || ',' || version::text from public.reports where id = tests.id('r1')), 'draft,1', 'R-009-8 状況は下書き・版は 1');
select is(pg_temp.rins(tests.u('staff2A'), 'x1', 'wR1'), '42501', 'R-009-8 担当でない人は、報告書を作れない');
select is(pg_temp.rins(tests.u('staffA'), 'x2', 'wRn'), '42501', 'R-009-8 担当が1人もいない作業にも、スタッフは作れない');
select is(pg_temp.rins(tests.u('memberA'), 'x3', 'wR1'), '42501', 'R-009-8 担当でない社員も、作れない（work.assign は読み・確認のための権限）');
select is(pg_temp.rins(tests.u('extA'), 'x4', 'wR1'), '42501', 'R-009-8 外部の人は作れない');
select is(pg_temp.rins(tests.u('nobody'), 'x5', 'wR1'), '42501', 'R-009-8 どの会社にも属さない人は作れない');
select is(coalesce(tests.run_as_anon(format('insert into public.reports (tenant_id, work_id) values (%L, %L)', tests.t('A'), tests.id('wR1'))) ->> 'error', 'ok'), '42501', 'R-009-8 ログインしていない人は作れない');
select is(pg_temp.rins(tests.u('staffB'), 'x6', 'wR1', '', '', 'A'), '42501', 'R-009-8 別の会社のスタッフは、A の作業の報告書を作れない');
select is(pg_temp.rins(tests.u('staffB'), 'x7', 'wA10', '', '', 'B'), '42501', 'R-009-8 別の会社の作業を指して、自分の会社の報告書は作れない（担当でない）');
select is(pg_temp.rins(tests.u('staffA'), 'x8', 'wRx', 'template_id', quote_literal(tests.id('tplB10'))), '23503', 'R-009-8 別の会社のひな形は指せない');
select is(pg_temp.rins(tests.u('staffA'), 'x9', 'wRx', 'template_id', 'null'), 'ok', 'R-009-8 ひな形は空でもよい（ひな形のない作業）');
insert into public.work_assignments (id, tenant_id, work_id, membership_id, deleted_at) values (gen_random_uuid(), tests.t('A'), tests.id('wR2'), tests.id('m:A:staffA'), now());
select is(pg_temp.rins(tests.u('staffA'), 'x10', 'wR2'), '42501', 'R-009-8 担当を外された（論理削除）人は作れない');

-- ===== R-009-9 下書きで作る =====
select is(pg_temp.rins(tests.u('staffA'), 'y1', 'wRg', 'status, checked_by, checked_at', format('''checked'', %L, now()', tests.id('m:A:memberA'))), '42501', 'R-009-9 確認済みで作ることはできない');
select is(pg_temp.rins(tests.u('staffA'), 'y2', 'wRg', 'status, checked_by, checked_at, submitted_by, submitted_at', format('''submitted'', %L, now(), %L, now()', tests.id('m:A:memberA'), tests.id('m:A:memberA'))), '42501', 'R-009-9 提出で作ることはできない');
select is(pg_temp.rins(tests.u('staffA'), 'y3', 'wRg', 'checked_by', quote_literal(tests.id('m:A:memberA'))), '42501', 'R-009-9 確認した人を入れて作ることはできない');
select is(pg_temp.rins(tests.u('staffA'), 'y4', 'wRg', 'version', '5'), '42501', 'R-009-9 版が 1 でない報告書は作れない');
select is(pg_temp.rins(tests.u('staffA'), 'y5', 'wRg', 'status', '''done'''), '42501', 'R-009-9 決まった状況以外は保存しない');

-- ===== R-009-10 同じ uuid は1件・1つの作業に1つ =====
select is(pg_temp.rins(tests.u('staffA'), 'r1', 'wR1'), '23505', 'R-009-10 同じ uuid を、ふつうに二度作ろうとすると断られる');
select is(tests.cnt(tests.u('staffA'), format('insert into public.reports (id, tenant_id, work_id) values (%L, %L, %L) on conflict (id) do nothing', tests.id('r1'), tests.t('A'), tests.id('wR1'))), 0::bigint,
  'R-009-10 端末の送り直し（既にあれば無視する書き方）は、二度送っても何も増えない');
select is((select count(*)::int from public.reports where work_id = tests.id('wR1')), 1, 'R-009-10 同じ作業の報告書は1件');
select is(pg_temp.rins(tests.u('staffA'), 'r1b', 'wR1'), '23505', 'R-009-10 同じ作業に、別の uuid の報告書は作れない');
update public.reports set deleted_at = now() where id = tests.id('r1');
select is(pg_temp.rins(tests.u('staffA'), 'r1c', 'wR1'), 'ok', 'R-009-10 消した報告書（論理削除）がある作業には、作れる（消していない行で一意）');
update public.reports set deleted_at = now() where id = tests.id('r1c');
update public.reports set deleted_at = null where id = tests.id('r1');

-- ===== R-009-11 下書きの間だけ、メモと版を直せる =====
select is(tests.cnt(tests.u('staffA'), format($q$update public.reports set remarks = '気づきのメモ', version = 2 where id = %L$q$, tests.id('r1'))), 1::bigint, 'R-009-11 担当は、下書きのメモと版を直せる');
select is(tests.cnt(tests.u('staff2A'), format($q$update public.reports set remarks = '他人が直す' where id = %L$q$, tests.id('r1'))), 0::bigint, 'R-009-11 担当でない人は直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.reports set remarks = '社員が直す' where id = %L$q$, tests.id('r1'))), 0::bigint, 'R-009-11 担当でない社員も、直接は直せない（確認の RPC だけ）');
select is(tests.err(tests.u('staffA'), format($q$update public.reports set status = 'checked' where id = %L$q$, tests.id('r1'))), '42501', 'R-009-11 状況は直接は直せない');
select is(tests.err(tests.u('staffA'), format($q$update public.reports set work_id = %L where id = %L$q$, tests.id('wR3'), tests.id('r1'))), '42501', 'R-009-11 作業は直せない');
select is(tests.err(tests.u('staffA'), format($q$update public.reports set checked_by = %L where id = %L$q$, tests.id('m:A:memberA'), tests.id('r1'))), '42501', 'R-009-11 確認した人は直せない');
select is(tests.err(tests.u('staffA'), format($q$update public.reports set template_id = %L where id = %L$q$, tests.id('tplA1'), tests.id('r1'))), '42501', 'R-009-11 ひな形は直せない');
select is(tests.err(tests.u('staffA'), format($q$update public.reports set deleted_at = now() where id = %L$q$, tests.id('r1'))), '42501', 'R-009-11 報告書は消せない（論理削除もできない）');
select is(tests.err(tests.u('staffA'), format('delete from public.reports where id = %L', tests.id('r1'))), '42501', 'R-009-11 delete もできない');
select is(tests.err(tests.u('staffA'), format($q$update public.reports set remarks = repeat('あ', 4001) where id = %L$q$, tests.id('r1'))), '23514', 'R-009-11 メモは 4000 字まで');
select is(pg_temp.rins(tests.u('staffA'), 'r3', 'wR3'), 'ok', '（前提）2人が担当の作業の報告書');
select is(tests.cnt(tests.u('staff2A'), format($q$update public.reports set remarks = '2人目が直す' where id = %L$q$, tests.id('r3'))), 1::bigint, 'R-009-11 同じ作業の担当なら、別のスタッフも直せる');

-- ===== R-009-12 読める人 =====
select is(tests.n(tests.u('staffA'), format('select 1 from public.reports where id = %L', tests.id('r1'))), 1::bigint, 'R-009-12 担当のスタッフは読める');
select is(tests.n(tests.u('staff2A'), format('select 1 from public.reports where id = %L', tests.id('r1'))), 0::bigint, 'R-009-12 担当でないスタッフは読めない');
select is(tests.n(tests.u('staff2A'), format('select 1 from public.reports where id = %L', tests.id('r3'))), 1::bigint, 'R-009-12 同じ作業の担当なら、別のスタッフも読める');
select is(tests.n(tests.u('memberA'), format('select 1 from public.reports where tenant_id = %L', tests.t('A'))), (select count(*) from public.reports where tenant_id = tests.t('A')),
  'R-009-12 work.assign を持つ社員は、会社の報告書を全部読める');
select is(tests.n(tests.u('staffB'), format('select 1 from public.reports where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-009-12 別の会社の人は、読めず、数も分からない');
select is(tests.n(tests.u('staffB'), 'select 1 from public.reports'), 1::bigint, 'R-009-12 自分の会社の報告書は読める（会社 B は種の 1 件）');

-- ===== R-009-13 報告書の項目 =====
select is(pg_temp.iins(tests.u('staffA'), 'i1', 'r1', 'template_item_id, area_id, sort, done, note', format('%L, %L, 1, true, ''拭いた''', tests.id('tiA10-1'), tests.id('areaA10'))), 'ok', 'R-009-13 担当は、項目を作れる（ひな形から写した値つき）');
select is(pg_temp.iins(tests.u('staffA'), 'i2', 'r1', 'sort', '2'), 'ok', 'R-009-13 ひな形の項目・場所は空でもよい');
select is(pg_temp.iins(tests.u('staffA'), 'i3', 'r1', '', '', 'A', ''), '23514', 'R-009-13 名前が空なら保存しない');
select is(pg_temp.iins(tests.u('staffA'), 'i3', 'r1', 'note', quote_literal(repeat('あ', 2001))), '23514', 'R-009-13 メモは 2000 字まで');
select is(pg_temp.iins(tests.u('staffA'), 'i4', 'r1', 'template_item_id', quote_literal(tests.id('tiB10-1'))), '23503', 'R-009-13 別の会社のひな形の項目は指せない');
select is(pg_temp.iins(tests.u('staffA'), 'i5', 'r1', 'area_id', quote_literal(tests.id('areaB1'))), '23503', 'R-009-13 別の会社の場所は指せない');
select is(pg_temp.iins(tests.u('staffA'), 'i6', 'rB10'), '42501', 'R-009-13 別の会社の報告書には、項目を作れない');
select is(pg_temp.iins(tests.u('staffA'), 'i7', 'r3'), 'ok', 'R-009-13 担当の作業の別の報告書にも作れる');
select is(pg_temp.iins(tests.u('staff2A'), 'i8', 'r1'), '42501', 'R-009-13 担当でない人は、項目を作れない');
select is(pg_temp.iins(tests.u('staffA'), 'i1', 'r1'), '23505', 'R-009-13 同じ uuid を二度作ろうとすると断られる');
select is(tests.cnt(tests.u('staffA'), format('insert into public.report_items (id, tenant_id, report_id, name) values (%L, %L, %L, ''項目'') on conflict (id) do nothing', tests.id('i1'), tests.t('A'), tests.id('r1'))), 0::bigint,
  'R-009-13 送り直し（既にあれば無視する書き方）は、二度送っても増えない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.report_items set done = true, note = '直したメモ' where id = %L$q$, tests.id('i2'))), 1::bigint, 'R-009-13 担当は、チェックとメモを直せる');
select is(tests.cnt(tests.u('staff2A'), format($q$update public.report_items set done = false where id = %L$q$, tests.id('i2'))), 0::bigint, 'R-009-13 担当でない人は直せない');
select is(tests.err(tests.u('staffA'), format($q$update public.report_items set name = '名前を直す' where id = %L$q$, tests.id('i2'))), '42501', 'R-009-13 名前は直せない');
select is(tests.err(tests.u('staffA'), format($q$update public.report_items set sort = 9 where id = %L$q$, tests.id('i2'))), '42501', 'R-009-13 並び順は直せない');
select is(tests.err(tests.u('staffA'), format($q$update public.report_items set report_id = %L where id = %L$q$, tests.id('r3'), tests.id('i2'))), '42501', 'R-009-13 報告書は付け替えられない');
select is(tests.err(tests.u('staffA'), format('delete from public.report_items where id = %L', tests.id('i2'))), '42501', 'R-009-13 項目は消せない');
select is(tests.n(tests.u('staff2A'), format('select 1 from public.report_items where report_id = %L', tests.id('r1'))), 0::bigint, 'R-009-13 担当でない人は、項目を読めない');
select is(tests.n(tests.u('memberA'), format('select 1 from public.report_items where report_id = %L', tests.id('r1'))), 2::bigint, 'R-009-13 work.assign を持つ人は、項目を読める');

-- ===== R-009-14〜16・18 確認・差し戻し・提出 =====
select pg_temp.mkreport('rc', 'wRc', 'draft');
select pg_temp.mkitem('ic1', 'rc');
select is(pg_temp.rpc(tests.u('memberA'), 'submit_report', tests.id('rc')) ->> 'reason', 'not_checked', 'R-009-15 下書きのままの提出は、理由を返して断る');
select is(pg_temp.rpc_err(tests.u('staffA'), 'check_report', tests.id('rc')), '42501', 'R-009-14 スタッフは確認を呼べない（担当でも）');
select is(pg_temp.rpc_err(tests.u('extA'), 'check_report', tests.id('rc')), '42501', 'R-009-14 外部の人は呼べない');
select is(pg_temp.rpc_err(tests.u('adminB'), 'check_report', tests.id('rc')), '42501', 'R-009-14 別の会社の管理者は呼べない');
select is(pg_temp.rpc_err(tests.u('nobody'), 'check_report', tests.id('rc')), '42501', 'R-009-14 どの会社にも属さない人は呼べない');
select is(coalesce(tests.run_as_anon(format('select public.check_report(%L)', tests.id('rc'))) ->> 'error', 'ok'), '42501', 'R-009-14 ログインしていない人は呼べない');
select is(pg_temp.rpc_err(tests.u('memberA'), 'check_report', gen_random_uuid()), '42501', 'R-009-14 存在しない報告書は 42501');
select is(pg_temp.rpc(tests.u('memberA'), 'check_report', tests.id('rc')) ->> 'status', 'checked', 'R-009-14 社員は、下書きを確認済みにできる');
select is((select checked_by from public.reports where id = tests.id('rc')), tests.id('m:A:memberA'), 'R-009-14 確認した人（所属）が残る');
select is((select checked_at is not null from public.reports where id = tests.id('rc')), true, 'R-009-14 確認した時刻が残る');
select is((select version from public.reports where id = tests.id('rc')), 2, 'R-009-18 確認で版が 1 つ上がる');
select is(pg_temp.rpc(tests.u('adminA'), 'check_report', tests.id('rc')) ->> 'already', 'true', 'R-009-14 二度目は何もしないで、前の結果を返す');
select is((select version from public.reports where id = tests.id('rc')) || ',' || (select checked_by from public.reports where id = tests.id('rc')), '2,' || tests.id('m:A:memberA'), 'R-009-14 二度目は版も確認した人も変えない');
select is(pg_temp.rpc_err(tests.u('staffA'), 'submit_report', tests.id('rc')), '42501', 'R-009-15 スタッフは提出を呼べない');
select is(pg_temp.rpc_err(tests.u('extA'), 'submit_report', tests.id('rc')), '42501', 'R-009-21 外部の人は提出を呼べない');
select is(pg_temp.rpc(tests.u('memberA'), 'submit_report', tests.id('rc')) ->> 'status', 'submitted', 'R-009-15 確認済みを提出にできる');
select is((select (submitted_by = tests.id('m:A:memberA')) and submitted_at is not null from public.reports where id = tests.id('rc')), true, 'R-009-15 提出した人と時刻が残る');
select is((select version from public.reports where id = tests.id('rc')), 3, 'R-009-18 提出で版がもう 1 つ上がる');
select is(pg_temp.rpc(tests.u('memberA'), 'submit_report', tests.id('rc')) ->> 'already', 'true', 'R-009-15 提出の二度目は何もしない');
select is(pg_temp.rpc(tests.u('memberA'), 'check_report', tests.id('rc')) ->> 'reason', 'submitted', 'R-009-14 提出済みの確認は、理由を返す');
select is(pg_temp.rpc(tests.u('memberA'), 'reopen_report', tests.id('rc')) ->> 'reason', 'submitted', 'R-009-16 提出済みは、下書きに戻せない');
select is(pg_temp.rpc_err(tests.u('extA'), 'reopen_report', tests.id('rc')), '42501', 'R-009-21 外部の人は差し戻しを呼べない');

select pg_temp.mkreport('rd', 'wRd', 'draft');
select is(pg_temp.rpc(tests.u('memberA'), 'reopen_report', tests.id('rd')) ->> 'already', 'true', 'R-009-16 下書きの差し戻しは何もしない');
select is(pg_temp.rpc(tests.u('memberA'), 'check_report', tests.id('rd')) ->> 'ok', 'true', '（前提）確認済みにする');
select is(pg_temp.rpc_err(tests.u('staffA'), 'reopen_report', tests.id('rd')), '42501', 'R-009-16 スタッフは差し戻しを呼べない');
select is(pg_temp.rpc(tests.u('memberA'), 'reopen_report', tests.id('rd')) ->> 'status', 'draft', 'R-009-16 確認済みを下書きに戻せる');
select is((select checked_by is null and checked_at is null from public.reports where id = tests.id('rd')), true, 'R-009-16 確認した人と時刻が消える');
select is((select version from public.reports where id = tests.id('rd')), 3, 'R-009-18 差し戻しでも版が上がる（確認 2・差し戻し 3）');
select is(tests.cnt(tests.u('staffA'), format($q$update public.reports set remarks = '差し戻しのあと直す' where id = %L$q$, tests.id('rd'))), 1::bigint, 'R-009-16 差し戻したあとは、担当がまた直せる');

-- ===== R-009-17・23 固定と写真 =====
select pg_temp.mkreport('rf', 'wRf', 'checked');
select pg_temp.mkitem('if1', 'rf');
select pg_temp.mkreport('rs', 'wRg', 'submitted');
select pg_temp.mkitem('is1', 'rs');
select tests.make_photo('A', 'phF', 'buildingA10', 'staffA', 'before', format('work_id, report_item_id|%L, %L', tests.id('wRf'), tests.id('if1')));
select tests.make_photo('A', 'phS', 'buildingA10', 'staffA', 'before', format('work_id, report_item_id|%L, %L', tests.id('wRg'), tests.id('is1')));
select tests.make_photo('A', 'phD', 'buildingA10', 'staffA', 'before', format('work_id, report_item_id|%L, %L', tests.id('wR1'), tests.id('i1')));
select is(tests.cnt(tests.u('staffA'), format($q$update public.reports set remarks = '確認済みを直す' where id = %L$q$, tests.id('rf'))), 0::bigint, 'R-009-17 確認済みの報告書のメモは直せない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.reports set remarks = '提出済みを直す' where id = %L$q$, tests.id('rs'))), 0::bigint, 'R-009-17 提出済みの報告書のメモは直せない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.report_items set done = true where id = %L$q$, tests.id('if1'))), 0::bigint, 'R-009-17 確認済みの報告書の項目のチェックは直せない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.report_items set note = 'x' where id = %L$q$, tests.id('is1'))), 0::bigint, 'R-009-17 提出済みの報告書の項目のメモは直せない');
select is(pg_temp.iins(tests.u('staffA'), 'i9', 'rf'), '42501', 'R-009-17 確認済みの報告書に、項目は足せない');
select is(pg_temp.iins(tests.u('staffA'), 'i10', 'rs'), '42501', 'R-009-17 提出済みの報告書に、項目は足せない');
select is(tests.n(tests.u('staffA'), format('select 1 from public.report_items where id in (%L, %L)', tests.id('if1'), tests.id('is1'))), 2::bigint, 'R-009-17 固定された報告書と項目も、担当は読める');
select is(tests.cnt(tests.u('staffA'), format($q$update public.photos set kind = 'after' where id = %L$q$, tests.id('phF'))), 0::bigint, 'R-009-17 確認済みの報告書の写真は直せない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.photos set deleted_at = now() where id = %L$q$, tests.id('phS'))), 0::bigint, 'R-009-17 提出済みの報告書の写真は消せない');
select is(tests.n(tests.u('staffA'), format('select 1 from public.photos where id in (%L, %L)', tests.id('phF'), tests.id('phS'))), 2::bigint, 'R-009-17 固定された報告書の写真も、担当は読める');
select is(pg_temp.pins(tests.u('staffA'), 'phN1', 'wRf', 'if1', 'staffA'), '42501', 'R-009-17 確認済みの報告書の項目に、写真は足せない');
select is(pg_temp.pins(tests.u('staffA'), 'phN2', 'wRg', 'is1', 'staffA'), '42501', 'R-009-17 提出済みの報告書の項目に、写真は足せない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.photos set kind = 'after' where id = %L$q$, tests.id('phD'))), 1::bigint, 'R-009-17 下書きの報告書の写真は直せる');
select is(pg_temp.pins(tests.u('staffA'), 'phN3', 'wR1', 'i1', 'staffA', 'after'), 'ok', 'R-009-17 下書きの報告書の項目には、写真を足せる');
select is(pg_temp.pins(tests.u('staffA'), 'phN4', 'wR3', 'i1', 'staffA'), '42501', 'R-009-23 項目は、写真の作業の報告書の項目でなければならない');
select is(pg_temp.pins(tests.u('staffA'), 'phN5', null, 'i1', 'staffA'), '42501', 'R-009-23 項目つきの写真は、作業が要る');
select is(pg_temp.pins(tests.u('staffA'), 'phN6', 'wR1', null, 'staffA', 'observation'), 'ok', 'R-009-23 項目のない写真（気づき）は、そのまま作れる');
select is(app.photo_report_locked(tests.t('A'), tests.id('if1')) and app.photo_report_locked(tests.t('A'), tests.id('is1')), true, 'R-009-23 確認済み・提出済みの項目の写真は固定される（判定の関数）');
select is(app.photo_report_locked(tests.t('A'), tests.id('i1')) or app.photo_report_locked(tests.t('A'), null) or app.photo_report_locked(tests.t('A'), gen_random_uuid()), false, 'R-009-23 下書きの項目・項目なし・ない項目は固定されない');
select is(coalesce(tests.run_as_service(format($q$update public.photos set report_item_id = %L where id = %L$q$, tests.id('riB10-1'), tests.id('phD'))) ->> 'error', 'ok'), '23503', 'R-009-23 別の会社の報告書の項目は指せない');
select is(coalesce(tests.run_as_service(format($q$update public.photos set report_item_id = %L where id = %L$q$, gen_random_uuid(), tests.id('phD'))) ->> 'error', 'ok'), '23503', 'R-009-23 存在しない項目は指せない');
select is(coalesce(tests.run_as_service(format($q$update public.photos set report_item_id = null where id = %L$q$, tests.id('phD'))) ->> 'error', 'ok'), 'ok', 'R-009-23 空は許す');
select is((select count(*)::int from pg_constraint where conrelid = 'public.photos'::regclass and contype = 'f' and pg_get_constraintdef(oid) ~ '\(tenant_id, report_item_id\) REFERENCES report_items'), 1,
  'R-009-23 photos.report_item_id には、(tenant_id, report_item_id) の外部キーがある');

-- 建物 A10 の作業の報告書は、担当・社員が読めて、別の会社の人は読めない
select is(tests.n(tests.u('staffB'), format('select 1 from public.report_items where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-009-22 別の会社の項目は読めず、数も分からない');
select is(tests.cnt(tests.u('adminB'), format($q$update public.reports set remarks = 'x' where id = %L$q$, tests.id('rA10'))), 0::bigint, 'R-009-22 別の会社の報告書は、管理者も直せない');

select * from finish();
rollback;
