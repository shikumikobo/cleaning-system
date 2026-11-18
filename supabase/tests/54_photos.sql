-- 機能 008：写真の行（R-008-1〜12）。型 C2（作業の担当。作業のない写真は撮った本人）＋D
begin;
select * from no_plan();
select tests.seed();

-- 写真を作る（その人として）。名前から id とパスが決まる。extra は 'カラム,…|値,…'
create or replace function pg_temp.ins(p_uid uuid, p_tenant text, p_name text, p_building text, p_member text, p_kind text default 'before',
  p_extra text default '', p_bytes int default 300000, p_width int default 1600, p_thumb text default null, p_path text default null) returns text language sql as $$
  select coalesce(tests.run_as(p_uid, format(
    'insert into public.photos (id, tenant_id, building_id, kind, taken_at, taken_by, storage_path, thumb_path, width, height, bytes%s) values (%L, %L, %L, %L, now(), %L, %L, %L, %s, 1200, %s%s)',
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '|', 1) end,
    tests.id(p_name), tests.t(p_tenant), tests.id(p_building), p_kind, tests.id('m:' || p_tenant || ':' || p_member),
    coalesce(p_path, tests.photo_path(p_tenant, p_name)), coalesce(p_thumb, tests.photo_path(p_tenant, p_name, 'thumb.jpg')), p_width, p_bytes,
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '|', 2) end)) ->> 'error', 'ok')
$$;
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

-- 二人目のスタッフ A（作業の担当・撮った本人の確かめに使う）
select tests.make_user('staff2A');
select tests.make_member('A', 'staff2A', 'staff');

-- ===== R-008-1 作る =====
select is(pg_temp.ins(tests.u('staffA'), 'A', 'n1', 'buildingA1', 'staffA', 'before'), 'ok', 'R-008-1 スタッフ（field.record）は、自分が撮った写真の行を作れる');
select is(pg_temp.ins(tests.u('memberA'), 'A', 'n2', 'buildingA1', 'memberA', 'observation'), 'ok', 'R-008-1 社員も作れる（気づき）');
select is(pg_temp.ins(tests.u('adminA'), 'A', 'n3', 'buildingA2', 'adminA', 'after'), 'ok', 'R-008-1 管理者も作れる（後）');
select is((select created_at is not null and created_at <= now() from public.photos where id = tests.id('n1')), true, 'R-008-1 届いた時刻（created_at）が入る');
select is((select kind || ',' || width || ',' || height || ',' || bytes from public.photos where id = tests.id('n1')), 'before,1600,1200,300000', 'R-008-1 種類・幅・高さ・大きさが保存される');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'n4', 'buildingA1', 'memberA', 'before'), '42501', 'R-008-1 他人を撮った人にした行は作れない');

-- ===== R-008-2 検査 =====
select is(pg_temp.ins(tests.u('staffA'), 'A', 'bad1', 'buildingA1', 'staffA', 'during'), '23514', 'R-008-2 種類が前・後・気づき以外なら保存しない');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'bad2', 'buildingA1', 'staffA', 'before', '', 300000, 1600, null, tests.t('A') || '/photos/' || tests.id('n1')::text || '/photo.jpg'), '23514', 'R-008-2 ほかの写真のパスを指す行は保存しない');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'bad3', 'buildingA1', 'staffA', 'before', '', 300000, 1600, null, tests.t('B') || '/photos/' || tests.id('bad3')::text || '/photo.jpg'), '23514', 'R-008-2 別の会社のフォルダのパスは保存しない');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'bad4', 'buildingA1', 'staffA', 'before', '', 300000, 1600, tests.t('A') || '/files/' || tests.id('bad4')::text || '/thumb.jpg'), '23514', 'R-008-2 小さな画像のパスが photos/<id>/thumb.jpg でなければ保存しない');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'bad5', 'buildingA1', 'staffA', 'before', '', 300000, 0), '23514', 'R-008-2 幅が 0 以下なら保存しない');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'bad6', 'buildingA1', 'staffA', 'before', '', 0), '23514', 'R-008-2 大きさが 0 以下なら保存しない');

-- ===== R-008-3 別の会社・別の建物を指さない =====
select is(pg_temp.ins(tests.u('staffA'), 'A', 'x1', 'buildingB1', 'staffA'), '23503', 'R-008-3 別の会社の建物を指す行は保存しない');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'x2', 'buildingA1', 'staffA', 'before', format('room_id|%L', tests.id('roomB1'))), '23503', 'R-008-3 別の会社の部屋を指す行は保存しない');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'x3', 'buildingA1', 'staffA', 'before', format('area_id|%L', tests.id('areaB1'))), '23503', 'R-008-3 別の会社の場所を指す行は保存しない');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'x4', 'buildingA1', 'staffA', 'before', format('request_id|%L', tests.id('reqB-1'))), '42501', 'R-008-3 別の会社の案件を指す行は保存しない（案件が読めない）');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'x5', 'buildingA1', 'staffA', 'before', format('request_id|%L', tests.id('reqA-2'))), '42501', 'R-008-3 自分が読めない案件（担当でないスタッフ）には、つなげない');

-- ===== R-008-4 任意の列 =====
select is(pg_temp.ins(tests.u('staffA'), 'A', 'o1', 'buildingA1', 'staffA', 'before', format('room_id, area_id, request_id|%L, %L, %L', tests.id('roomA1'), tests.id('areaA1'), tests.id('reqA-1'))), 'ok',
          'R-008-4 部屋・場所・案件を付けて保存できる');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'o2', 'buildingA1', 'staffA', 'before', format('report_item_id, work_id|%L, %L', tests.id('riA10-1'), tests.id('wA10'))), 'ok',
          'R-008-4 報告書の項目（009）を付けて保存できる（項目は、写真の作業の報告書のもの）');
select is((select count(*)::int from pg_constraint where conrelid = 'public.photos'::regclass and contype = 'f' and pg_get_constraintdef(oid) ~ '\(tenant_id, report_item_id\) REFERENCES report_items'), 1,
          'R-008-4 report_item_id には、報告書の項目（009）への (tenant_id, report_item_id) の外部キーがある（009 で足した。別の会社・存在しない項目は 24_reports で確かめる）');
select is((select count(*)::int from pg_constraint where conrelid = 'public.photos'::regclass and contype = 'f' and pg_get_constraintdef(oid) ~ '\(tenant_id, work_id\) REFERENCES works'), 1,
          'R-008-4 work_id には、作業（010）への (tenant_id, work_id) の外部キーがある（空は許す。存在しない・別の会社の作業は 53_integration_fks で確かめる）');
select is((select count(*)::int from pg_indexes where tablename = 'photos' and (indexdef ~ '\(tenant_id, work_id\)' or indexdef ~ '\(tenant_id, report_item_id\)')), 2,
          'R-008-4 work_id・report_item_id には索引がある');

-- ===== R-008-5 同じ uuid は1件 =====
select is(pg_temp.ins(tests.u('staffA'), 'A', 'n1', 'buildingA1', 'staffA'), '23505', 'R-008-5 同じ uuid で、ふつうに二度作ろうとすると断られる（一意）');
select is(tests.cnt(tests.u('staffA'), format(
  'insert into public.photos (id, tenant_id, building_id, kind, taken_at, taken_by, storage_path, thumb_path, width, height, bytes) values (%L, %L, %L, ''before'', now(), %L, %L, %L, 1600, 1200, 300000) on conflict (id) do nothing',
  tests.id('n1'), tests.t('A'), tests.id('buildingA1'), tests.id('m:A:staffA'), tests.photo_path('A', 'n1'), tests.photo_path('A', 'n1', 'thumb.jpg'))), 0::bigint,
  'R-008-5 端末の送り直し（既にあれば無視する書き方）は、二度送っても何も増えない');
select is((select count(*)::int from public.photos where id = tests.id('n1')), 1, 'R-008-5 同じ uuid の写真は1件だけ');

-- ===== R-008-6 直せる列 =====
select is(tests.cnt(tests.u('staffA'), format('update public.photos set kind = ''after'' where id = %L', tests.id('n1'))), 1::bigint, 'R-008-6 撮った本人は、種類を直せる');
select is(tests.cnt(tests.u('staffA'), format('update public.photos set room_id = %L, area_id = %L where id = %L', tests.id('roomA1'), tests.id('areaA1'), tests.id('n1'))), 1::bigint, 'R-008-6 部屋・場所を直せる');
select is(tests.cnt(tests.u('staffA'), format('update public.photos set room_id = null, area_id = null where id = %L', tests.id('n1'))), 1::bigint, 'R-008-6 部屋・場所を空にもできる');
select is(tests.err(tests.u('staffA'), format('update public.photos set building_id = %L where id = %L', tests.id('buildingA2'), tests.id('n1'))), '42501', 'R-008-6 建物は直せない');
select is(tests.err(tests.u('staffA'), format('update public.photos set taken_by = %L where id = %L', tests.id('m:A:memberA'), tests.id('n1'))), '42501', 'R-008-6 撮った人は直せない');
select is(tests.err(tests.u('staffA'), format('update public.photos set taken_at = now() where id = %L', tests.id('n1'))), '42501', 'R-008-6 撮った時刻は直せない');
select is(tests.err(tests.u('staffA'), format('update public.photos set storage_path = thumb_path where id = %L', tests.id('n1'))), '42501', 'R-008-6 置き場所は直せない');
select is(tests.err(tests.u('staffA'), format('update public.photos set request_id = %L where id = %L', tests.id('reqA-1'), tests.id('n1'))), '42501', 'R-008-6 案件のつなぎは直接は直せない（RPC だけ）');
select is(tests.err(tests.u('staffA'), format('update public.photos set kind = ''during'' where id = %L', tests.id('n1'))), '23514', 'R-008-6 種類は決まった値だけ');
select is(tests.cnt(tests.u('staffA'), format('update public.photos set deleted_at = now() where id = %L', tests.id('n1'))), 1::bigint, 'R-008-6 撮った本人は、消せる（論理削除）');
select is(tests.err(tests.u('staffA'), format('delete from public.photos where id = %L', tests.id('n1'))), '42501', 'R-008-6 行は削除（delete）できない');

-- ===== R-008-7 作業のない写真は、撮った本人だけが直せる =====
select is(pg_temp.ids(tests.u('staffA'), 'select id from public.photos where tenant_id = ''' || tests.t('A') || ''''),
          pg_temp.idlist('photoA-staff', 'photoA-obs-staff', 'photoA-b2', 'n1', 'o1', 'o2'), 'R-008-7 スタッフは、自分が撮った写真だけ読める');
select is(pg_temp.ids(tests.u('staff2A'), 'select id from public.photos'), '', 'R-008-7 同じ会社のほかのスタッフは、写真を読めない');
select is(tests.cnt(tests.u('staff2A'), format('update public.photos set kind = ''after'' where id = %L', tests.id('photoA-staff'))), 0::bigint, 'R-008-7 ほかのスタッフは直せない');
select is(tests.cnt(tests.u('staff2A'), format('update public.photos set deleted_at = now() where id = %L', tests.id('photoA-staff'))), 0::bigint, 'R-008-7 ほかのスタッフは消せない');
select is(tests.n(tests.u('memberA'), format('select 1 from public.photos where tenant_id = %L', tests.t('A'))), (select count(*) from public.photos where tenant_id = tests.t('A')), 'R-008-7 work.assign を持つ社員は、会社の写真を全部読める');
select is(tests.n(tests.u('adminA'), format('select 1 from public.photos where tenant_id = %L', tests.t('A'))), (select count(*) from public.photos where tenant_id = tests.t('A')), 'R-008-7 管理者も全部読める');
select is(tests.cnt(tests.u('memberA'), format('update public.photos set kind = ''after'' where id = %L', tests.id('photoA-staff'))), 0::bigint, 'R-008-7 読めるだけの人（撮った本人でない社員）は、直せない');
select is(tests.cnt(tests.u('adminA'), format('update public.photos set deleted_at = now() where id = %L', tests.id('photoA-staff'))), 0::bigint, 'R-008-7 管理者も、他人の写真は消せない');
select is(tests.cnt(tests.u('memberA'), format('update public.photos set kind = ''after'' where id = %L', tests.id('photoA-obs'))), 1::bigint, 'R-008-7 社員は、自分が撮った写真を直せる');

-- ===== R-008-8 作業の担当（010 の本物の作業 works・担当 work_assignments で確かめる）=====
-- 作業：建物 A1 の定期清掃（種の契約の中身 svcA1-base から）。担当は staff2A の 1 人だけ
insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status)
  values (tests.id('workW'), tests.t('A'), tests.id('buildingA1'), tests.id('svcA1-base'), tests.id('key:A1-base'), '写真テスト用の作業', current_date + 30, 'scheduled');
insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('waW-staff2A'), tests.t('A'), tests.id('workW'), tests.id('m:A:staff2A'));
select tests.make_photo('A', 'photoW', 'buildingA1', 'staffA', 'before', format('work_id|%L', tests.id('workW')));
select is(tests.n(tests.u('staff2A'), format('select 1 from public.photos where id = %L', tests.id('photoW'))), 1::bigint, 'R-008-8 作業の担当は、撮った人でなくても、その作業の写真を読める');
select is(tests.cnt(tests.u('staff2A'), format('update public.photos set kind = ''after'' where id = %L', tests.id('photoW'))), 1::bigint, 'R-008-8 作業の担当は、その作業の写真を直せる');
select is(tests.n(tests.u('staffA'), format('select 1 from public.photos where id = %L', tests.id('photoW'))), 0::bigint, 'R-008-8 作業の担当でない人は、自分が撮った写真でも、作業の写真は読めない（持ち主は作業の担当）');
select is(tests.cnt(tests.u('staffA'), format('update public.photos set kind = ''after'' where id = %L', tests.id('photoW'))), 0::bigint, 'R-008-8 作業の担当でない人は、作業の写真を直せない');
select is(tests.n(tests.u('memberA'), format('select 1 from public.photos where id = %L', tests.id('photoW'))), 1::bigint, 'R-008-8 work.assign を持つ人は、作業の写真を読める');
select is(pg_temp.ins(tests.u('staff2A'), 'A', 'w2', 'buildingA1', 'staff2A', 'before', format('work_id|%L', tests.id('workW'))), 'ok', 'R-008-8 作業の担当は、その作業の写真を作れる');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'w3', 'buildingA1', 'staffA', 'before', format('work_id|%L', tests.id('workW'))), '42501', 'R-008-8 作業の担当でない人は、その作業の写真を作れない');
-- 担当を外す（論理削除）と、その人はもう読めない。担当に加えた人は読める（担当の全員）
update public.work_assignments set deleted_at = now() where id = tests.id('waW-staff2A');
select is(tests.n(tests.u('staff2A'), format('select 1 from public.photos where id = %L', tests.id('photoW'))), 0::bigint, 'R-008-8 担当から外された（論理削除）人は、その作業の写真を読めなくなる');
select is(tests.n(tests.u('staffA'), format('select 1 from public.photos where id = %L', tests.id('photoW'))), 0::bigint, 'R-008-8 担当が1人もいない作業の写真は、撮った本人でも読めない（work.assign の人だけ）');
insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('waW-staffA'), tests.t('A'), tests.id('workW'), tests.id('m:A:staffA'));
select is(tests.n(tests.u('staffA'), format('select 1 from public.photos where id = %L', tests.id('photoW'))), 1::bigint, 'R-008-8 担当に加えられた人は、その作業の写真を読める（担当の全員）');
-- 作業のない写真は、今も撮った本人で決める（R-008-7）
select is(tests.n(tests.u('staff2A'), format('select 1 from public.photos where id = %L', tests.id('photoA-staff'))), 0::bigint, 'R-008-8 作業のない写真は、担当の表があっても撮った本人で決める');

-- ===== R-008-9 報告書が下書きの間だけ直せる =====
-- 009 の本物：報告書の項目 iLocked は提出済みの報告書、riA10-1 は下書きの報告書の項目
insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status)
  values (tests.id('workL'), tests.t('A'), tests.id('buildingA1'), tests.id('svcA1-base'), tests.id('key:A1-base'), '写真の固定のテスト用の作業', current_date + 31, 'scheduled');
insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('waL-staffA'), tests.t('A'), tests.id('workL'), tests.id('m:A:staffA'));
insert into public.reports (id, tenant_id, work_id, status, checked_by, checked_at, submitted_by, submitted_at)
  values (tests.id('rL'), tests.t('A'), tests.id('workL'), 'submitted', tests.id('m:A:memberA'), now(), tests.id('m:A:memberA'), now());
insert into public.report_items (id, tenant_id, report_id, name) values (tests.id('item-locked'), tests.t('A'), tests.id('rL'), '固定された項目');
select tests.make_photo('A', 'photoL', 'buildingA1', 'staffA', 'before', format('work_id, report_item_id|%L, %L', tests.id('workL'), tests.id('item-locked')));
select tests.make_photo('A', 'photoU', 'buildingA1', 'staffA', 'before', format('work_id, report_item_id|%L, %L', tests.id('wA10'), tests.id('riA10-1')));
select is(tests.cnt(tests.u('staffA'), format('update public.photos set kind = ''after'' where id = %L', tests.id('photoU'))), 1::bigint, 'R-008-9 下書きの報告書の写真は直せる');
select is(tests.cnt(tests.u('staffA'), format('update public.photos set kind = ''after'' where id = %L', tests.id('photoL'))), 0::bigint, 'R-008-9 提出・確認のあとの報告書の写真は直せない');
select is(tests.cnt(tests.u('staffA'), format('update public.photos set deleted_at = now() where id = %L', tests.id('photoL'))), 0::bigint, 'R-008-9 提出・確認のあとの報告書の写真は消せない');
select is(tests.n(tests.u('staffA'), format('select 1 from public.photos where id = %L', tests.id('photoL'))), 1::bigint, 'R-008-9 固定された写真も、読める');
select is(tests.cnt(tests.u('staffA'), format('update public.photos set kind = ''before'' where id = %L', tests.id('photoU'))), 1::bigint, 'R-008-9 下書きのほうは何度でも直せる');

-- ===== R-008-10 外部の人 =====
select is(pg_temp.ids(tests.u('extA'), 'select id from public.photos'), pg_temp.idlist('photoL'), 'R-008-10 外部の人が読める写真は、提出した報告書の項目につく写真（photoL）だけ（詳しくは 25_reports_external）');
select is(pg_temp.ins(tests.u('extA'), 'A', 'e1', 'buildingA1', 'extA'), '42501', 'R-008-10 外部の人は写真を作れない');
select is(tests.cnt(tests.u('extA'), format('update public.photos set deleted_at = now() where id = %L', tests.id('photoA-staff'))), 0::bigint, 'R-008-10 外部の人は写真を直せない・消せない');
select is((select policy_type from app.policy_registry where table_name = 'photos'), 'C2+D', 'R-008-10 写真は型 C2 に外部の型 D を足した形で登録されている');
-- 提出した報告書の写真は、外部の人が読める（009 の本物。詳しくは 25_reports_external で確かめる）
select is(tests.n(tests.u('extA'), 'select 1 from public.photos where id in (select id from public.photos where report_item_id is null)'), 0::bigint, 'R-008-10 項目につかない写真は、外部の人に見えない');
select is(tests.n(tests.u('extB'), format('select 1 from public.photos where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-008-10 別の会社の外部の人は、A の写真を読めない');

-- ===== R-008-11 別の会社 =====
select is(pg_temp.ids(tests.u('staffB'), 'select id from public.photos'), pg_temp.idlist('photoB-staff'), 'R-008-11 B のスタッフは、B の自分の写真だけ読める');
select is(tests.n(tests.u('staffA'), format('select 1 from public.photos where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-008-11 A のスタッフは、B の写真を読めない');
select is(pg_temp.ins(tests.u('staffA'), 'B', 'xb', 'buildingB1', 'staffB'), '42501', 'R-008-11 別の会社には、写真を作れない');
select is(tests.cnt(tests.u('adminA'), format('update public.photos set kind = ''after'' where id = %L', tests.id('photoB-staff'))), 0::bigint, 'R-008-11 別の会社の写真は、管理者も直せない');
select is(tests.n(tests.u('nobody'), 'select 1 from public.photos'), 0::bigint, 'R-008-11 どの会社にも属さない人は読めない');
select is(coalesce(tests.run_as_anon('select 1 from public.photos') ->> 'error', 'ok'), '42501', 'R-008-11 ログインしていない人は読めない');
select is(pg_temp.ids(tests.u('multi'), format('select id from public.photos where tenant_id = %L', tests.t('B'))), pg_temp.idlist('photoB-staff'), 'R-008-11 2つの会社の社員（B では管理者）は、B の写真を読める');

-- ===== R-008-12 使われているものは消さない =====
insert into public.rooms (id, tenant_id, building_id, room_no) values (tests.id('rP'), tests.t('A'), tests.id('buildingA1'), 'P');
select tests.make_photo('A', 'photoR', 'buildingA1', 'staffA', 'before', format('room_id|%L', tests.id('rP')));
select is(tests.run_as(tests.u('memberA'), format('select public.delete_room(%L) as r', tests.id('rP'))) -> 'rows' -> 0 -> 'r' ->> 'deactivated', 'true', 'R-008-12 写真が使っている部屋は、消さずに「使わない」にする');
select is((select deleted_at is null and not active from public.rooms where id = tests.id('rP')), true, 'R-008-12 部屋の行は残り、使わないになる');
insert into public.buildings (id, tenant_id, client_id, name, address) values (tests.id('bX'), tests.t('A'), tests.id('clientA1'), 'テスト写真つきの建物', 'x');
select tests.make_photo('A', 'photoX', 'bX', 'staffA', 'before');
select set_config('app.request_id', '', true), set_config('app.source', '', true);
select is(tests.run_as(tests.u('memberA'), format('select public.delete_building(%L) as r', tests.id('bX'))) -> 'rows' -> 0 -> 'r' ->> 'ok', 'true', 'R-008-12 社員は、写真のある建物を消せる');
select is((select deleted_at is not null from public.photos where id = tests.id('photoX')), true, 'R-008-12 建物を消すと、その建物の写真の行も一緒に論理削除される');
select is((select deleted_at is null from public.photos where id = tests.id('photoA-staff')), true, 'R-008-12 ほかの建物の写真は消えない');

select * from finish();
rollback;
