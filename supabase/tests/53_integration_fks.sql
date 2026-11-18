-- 波 2 の取り込み：quotes.request_id・files.request_id・files.quote_id の外部キー（自社・別会社・存在しない・空）
begin;
select * from no_plan();
select tests.seed();

-- 自社・空は保存できる
select is(coalesce(tests.run_as(tests.u('memberA'), format(
  $q$insert into public.quotes (tenant_id, client_id, building_id, kind, request_id) values (%L, %L, %L, 'request', %L)$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'), tests.id('reqA-1')) ) ->> 'error', 'ok'), 'ok', 'FK quotes.request_id：自社の案件を指せる');
select is(coalesce(tests.run_as(tests.u('memberA'), format(
  $q$insert into public.quotes (tenant_id, client_id, building_id, kind, request_id) values (%L, %L, %L, 'request', null)$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4')) ) ->> 'error', 'ok'), 'ok', 'FK quotes.request_id：空でもよい');
-- 別会社・存在しない
select is(tests.err(tests.u('memberA'), format(
  $q$insert into public.quotes (tenant_id, client_id, building_id, kind, request_id) values (%L, %L, %L, 'request', %L)$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'), tests.id('reqB-1'))), '23503', 'FK quotes.request_id：別の会社の案件は指せない');
select is(tests.err(tests.u('memberA'), format(
  $q$insert into public.quotes (tenant_id, client_id, building_id, kind, request_id) values (%L, %L, %L, 'request', gen_random_uuid())$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), '23503', 'FK quotes.request_id：存在しない案件は指せない');

-- files.request_id
create or replace function pg_temp.fins(p_extra_cols text, p_extra_vals text, p_n text) returns text language sql as $$
  select coalesce(tests.run_as(tests.u('memberA'), format(
    'insert into public.files (tenant_id, building_id, name, mime, size, storage_path, %s) values (%L, %L, ''f.pdf'', ''application/pdf'', 1, %L, %s)',
    p_extra_cols, tests.t('A'), tests.id('buildingA1'), tests.t('A') || '/files/fk' || p_n || '/f.pdf', p_extra_vals)) ->> 'error', 'ok')
$$;
select is(pg_temp.fins('request_id', quote_literal(tests.id('reqA-1')), '1'), 'ok', 'FK files.request_id：自社の案件を指せる');
select is(pg_temp.fins('request_id', 'null', '2'), 'ok', 'FK files.request_id：空でもよい');
select is(pg_temp.fins('request_id', quote_literal(tests.id('reqB-1')), '3'), '23503', 'FK files.request_id：別の会社の案件は指せない');
select is(pg_temp.fins('request_id', 'gen_random_uuid()', '4'), '23503', 'FK files.request_id：存在しない案件は指せない');
-- files.quote_id
select is(pg_temp.fins('quote_id', quote_literal(tests.id('qA-sub')), '5'), 'ok', 'FK files.quote_id：自社の見積を指せる');
select is(pg_temp.fins('quote_id', 'null', '6'), 'ok', 'FK files.quote_id：空でもよい');
select is(pg_temp.fins('quote_id', quote_literal(tests.id('qB-sub')), '7'), '23503', 'FK files.quote_id：別の会社の見積は指せない');
select is(pg_temp.fins('quote_id', 'gen_random_uuid()', '8'), '23503', 'FK files.quote_id：存在しない見積は指せない');
-- 直すときも同じ
select is(tests.cnt(tests.u('memberA'), format('update public.files set quote_id = %L where id = %L', tests.id('qA-sub'), tests.id('fileA-private'))), 1::bigint, 'FK files.quote_id：自社の見積に付け替えられる');
select is(tests.err(tests.u('memberA'), format('update public.files set quote_id = %L where id = %L', tests.id('qB-sub'), tests.id('fileA-private'))), '23503', 'FK files.quote_id：別の会社の見積には付け替えられない');
select is(tests.cnt(tests.u('memberA'), format('update public.files set quote_id = null, request_id = null where id = %L', tests.id('fileA-private'))), 1::bigint, 'FK：つなぎを空に戻せる');

-- ===== 波 3：photos.work_id → works =====
create or replace function pg_temp.pins(p_uid uuid, p_name text, p_work text) returns text language sql as $$
  select coalesce(tests.run_as(p_uid, format(
    'insert into public.photos (id, tenant_id, building_id, kind, taken_at, taken_by, storage_path, thumb_path, width, height, bytes, work_id) values (%L, %L, %L, ''before'', now(), %L, %L, %L, 1600, 1200, 300000, %s)',
    tests.id(p_name), tests.t('A'), tests.id('buildingA1'), tests.id('m:A:memberA'),
    tests.photo_path('A', p_name), tests.photo_path('A', p_name, 'thumb.jpg'), p_work)) ->> 'error', 'ok')
$$;
-- 自社の作業・別会社の作業（会社 A の建物に付けても指せない）
insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status)
  values (tests.id('wFK-A2'), tests.t('A'), tests.id('buildingA1'), tests.id('svcA1-base'), tests.id('key:A1-base'), 'FK テスト用の作業', current_date + 31, 'scheduled');
select is(pg_temp.pins(tests.u('memberA'), 'fkp1', quote_literal(tests.id('wA10'))), 'ok', 'FK photos.work_id：自社の作業を指せる');
select is(pg_temp.pins(tests.u('memberA'), 'fkp2', 'null'), 'ok', 'FK photos.work_id：空でもよい');
-- 別の会社・存在しない作業は、利用者としては担当の判定で先に止まる（42501）。外部キーそのものは基盤の権限で確かめる
select is(pg_temp.pins(tests.u('memberA'), 'fkp3', quote_literal(tests.id('wB10'))), '42501', 'FK photos.work_id：別の会社の作業は、利用者からは指せない');
select is(pg_temp.pins(tests.u('memberA'), 'fkp4', 'gen_random_uuid()'), '42501', 'FK photos.work_id：存在しない作業は、利用者からは指せない');
select is(tests.run_as_service(format(
  'insert into public.photos (id, tenant_id, building_id, kind, taken_at, taken_by, storage_path, thumb_path, width, height, bytes, work_id) values (%L, %L, %L, ''before'', now(), %L, %L, %L, 1600, 1200, 300000, %L)',
  tests.id('fkp5'), tests.t('A'), tests.id('buildingA1'), tests.id('m:A:memberA'), tests.photo_path('A', 'fkp5'), tests.photo_path('A', 'fkp5', 'thumb.jpg'), tests.id('wB10'))) ->> 'error', '23503', 'FK photos.work_id：別の会社の作業は指せない（基盤の権限で外部キーを確かめる）');
select is(tests.run_as_service(format(
  'insert into public.photos (id, tenant_id, building_id, kind, taken_at, taken_by, storage_path, thumb_path, width, height, bytes, work_id) values (%L, %L, %L, ''before'', now(), %L, %L, %L, 1600, 1200, 300000, gen_random_uuid())',
  tests.id('fkp6'), tests.t('A'), tests.id('buildingA1'), tests.id('m:A:memberA'), tests.photo_path('A', 'fkp6'), tests.photo_path('A', 'fkp6', 'thumb.jpg'))) ->> 'error', '23503', 'FK photos.work_id：存在しない作業は指せない（基盤の権限で外部キーを確かめる）');
-- 付け替え：work_id は利用者からは直せない列（008 の列の権限）。直すのは基盤の権限（postgres）で、外部キーが効くかを確かめる
select is(tests.err(tests.u('memberA'), format('update public.photos set work_id = %L where id = %L', tests.id('wA10'), tests.id('fkp2'))), '42501', 'FK photos.work_id：利用者は作業のつなぎを直せない（列の権限）');
update public.photos set work_id = tests.id('wFK-A2') where id = tests.id('fkp2');
select is((select work_id from public.photos where id = tests.id('fkp2')), tests.id('wFK-A2'), 'FK photos.work_id：自社の作業に付け替えられる');
select is(tests.run_as_service(format('update public.photos set work_id = %L where id = %L', tests.id('wB10'), tests.id('fkp2'))) ->> 'error', '23503', 'FK photos.work_id：別の会社の作業には付け替えられない');
select is(tests.run_as_service(format('update public.photos set work_id = gen_random_uuid() where id = %L', tests.id('fkp2'))) ->> 'error', '23503', 'FK photos.work_id：存在しない作業には付け替えられない');
update public.photos set work_id = null where id = tests.id('fkp2');
select is((select work_id from public.photos where id = tests.id('fkp2')), null, 'FK photos.work_id：つなぎを空に戻せる');
-- 作業を取り消しても（論理削除）、写真の行は残り、つなぎも保たれる
update public.works set status = 'cancelled', deleted_at = now() where id = tests.id('wFK-A2');
update public.photos set work_id = tests.id('wFK-A2') where id = tests.id('fkp2');
select is((select count(*) from public.photos where id = tests.id('fkp2') and work_id = tests.id('wFK-A2') and deleted_at is null), 1::bigint, 'FK photos.work_id：作業を取り消しても、写真の行は残る');

-- ===== 波 3：cash_entries.work_id → works（006 の出入り）=====
create or replace function pg_temp.cins(p_name text, p_work text) returns text language sql as $$
  select coalesce(tests.run_as_service(format(
    'insert into public.cash_entries (id, tenant_id, account_id, holder_id, entry_date, direction, amount, purpose, work_id) values (%L, %L, %L, %L, date ''2026-10-07'', ''out'', 100, ''テスト'', %s)',
    tests.id(p_name), tests.t('A'), tests.id('cashA-staff'), tests.id('m:A:staffA'), p_work)) ->> 'error', 'ok')
$$;
select is(pg_temp.cins('fkc1', quote_literal(tests.id('wA10'))), 'ok', 'FK cash_entries.work_id：自社の作業を指せる');
select is(pg_temp.cins('fkc2', 'null'), 'ok', 'FK cash_entries.work_id：空でもよい');
select is(pg_temp.cins('fkc3', quote_literal(tests.id('wB10'))), '23503', 'FK cash_entries.work_id：別の会社の作業は指せない');
select is(pg_temp.cins('fkc4', 'gen_random_uuid()'), '23503', 'FK cash_entries.work_id：存在しない作業は指せない');
select is(tests.run_as_service(format('update public.cash_entries set work_id = %L where id = %L', tests.id('wA1'), tests.id('fkc2'))) ->> 'error', null, 'FK cash_entries.work_id：自社の作業に付け替えられる');
select is(tests.run_as_service(format('update public.cash_entries set work_id = %L where id = %L', tests.id('wB10'), tests.id('fkc2'))) ->> 'error', '23503', 'FK cash_entries.work_id：別の会社の作業には付け替えられない');

select * from finish();
rollback;
