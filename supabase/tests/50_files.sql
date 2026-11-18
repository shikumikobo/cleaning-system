-- 機能 005：ファイルの行の作る・読む・直す・置き場所（R-005-1〜8）
begin;
select * from no_plan();
select tests.seed();

create or replace function pg_temp.ins(p_uid uuid, p_tenant text, p_building text, p_name text, p_path text, p_extra text default '') returns text language sql as $$
  select coalesce(tests.run_as(p_uid, format(
    'insert into public.files (tenant_id, building_id, name, mime, size, storage_path%s) values (%L, %L, %L, ''application/pdf'', 10, %L%s)',
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '|', 1) end,
    tests.t(p_tenant), tests.id(p_building), p_name, p_path,
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '|', 2) end)) ->> 'error', 'ok')
$$;

-- R-005-1
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', '図面.pdf', tests.t('A') || '/files/n1/zumen.pdf'), 'ok', 'R-005-1 社員（master.edit）はファイルの行を作れる');
select is(pg_temp.ins(tests.u('adminA'), 'A', 'buildingA1', '図面2.pdf', tests.t('A') || '/files/n2/zumen.pdf'), 'ok', 'R-005-1 管理者もファイルの行を作れる');
select is((select shared_external from public.files where storage_path = tests.t('A') || '/files/n1/zumen.pdf'), false, 'R-005-1 共有の初めの値は、共有しない');

-- R-005-2
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', 'x.pdf', tests.t('A') || '/photos/x.pdf'), '23514', 'R-005-2 files/ で始まらないパス（photos/）は保存しない');
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', 'x.pdf', tests.t('B') || '/files/x/x.pdf'), '23514', 'R-005-2 別の会社の ID で始まるパスは保存しない');
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', 'x.pdf', 'files/x/x.pdf'), '23514', 'R-005-2 会社の ID で始まらないパスは保存しない');
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', 'x.pdf', tests.t('A') || '/files/'), '23514', 'R-005-2 files/ の下に何もないパスは保存しない');
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', '   ', tests.t('A') || '/files/e/e.pdf'), '23514', 'R-005-2 名前が空なら保存しない');
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', repeat('あ', 256), tests.t('A') || '/files/e/long.pdf'), '23514', 'R-005-2 名前が 255 字を超えるなら保存しない');
select is(tests.run_as(tests.u('memberA'), format(
  'insert into public.files (tenant_id, building_id, name, mime, size, storage_path) values (%L, %L, ''neg'', ''application/pdf'', -1, %L)',
  tests.t('A'), tests.id('buildingA1'), tests.t('A') || '/files/e/neg.pdf')) ->> 'error', '23514', 'R-005-2 大きさが負なら保存しない');
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', 'dup.pdf', tests.file_path('A', 'fileA-shared')), '23505', 'R-005-2 同じ会社の消していない行にあるパスは保存しない');
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', 'again.pdf', tests.file_path('A', 'fileA-deleted')), 'ok', 'R-005-2 消した行のパスは、一意の制約から外れる（消していない行だけ）');

-- R-005-3
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingB1', 'x.pdf', tests.t('A') || '/files/b/x.pdf'), '23503', 'R-005-3 別の会社の建物を指す行は保存しない');

-- R-005-4
select is(pg_temp.ins(tests.u('memberA'), 'A', 'buildingA1', 'q.pdf', tests.t('A') || '/files/q/q.pdf',
  format('request_id, quote_id|%L, %L', tests.id('reqA-1'), tests.id('qA-sub'))), 'ok', 'R-005-4 自社の案件・見積のつなぎを付けて保存できる');
select is((select request_id from public.files where storage_path = tests.t('A') || '/files/q/q.pdf'), tests.id('reqA-1'), 'R-005-4 つなぎは保存される');
select is((select count(*)::int from pg_constraint where conrelid = 'public.files'::regclass and contype = 'f' and conname in ('files_request_fk', 'files_quote_fk')),
  2, 'R-005-4 request_id・quote_id には (tenant_id, …) の外部キーがある（波 2 の取り込みで足した。詳しい確かめは 53）');

-- R-005-5
select is(tests.cnt(tests.u('memberA'), format('update public.files set name = ''新しい名前.pdf'' where id = %L', tests.id('fileA-private'))), 1::bigint, 'R-005-5 名前を直せる');
select is(tests.cnt(tests.u('memberA'), format('update public.files set shared_external = true where id = %L', tests.id('fileA-private'))), 1::bigint, 'R-005-5 共有をオンにできる');
select is(tests.cnt(tests.u('memberA'), format('update public.files set shared_external = false where id = %L', tests.id('fileA-private'))), 1::bigint, 'R-005-5 共有をオフにできる');
select is(tests.cnt(tests.u('memberA'), format('update public.files set request_id = %L, quote_id = %L where id = %L', tests.id('reqA-1'), tests.id('qA-sub'), tests.id('fileA-private'))), 1::bigint, 'R-005-5 つなぎを直せる');
select is(tests.cnt(tests.u('memberA'), format('update public.files set deleted_at = now() where id = %L', tests.id('fileA-b2'))), 1::bigint, 'R-005-5 消せる（論理削除）');
select is(tests.err(tests.u('memberA'), format('update public.files set storage_path = %L where id = %L', tests.t('A') || '/files/other/o.pdf', tests.id('fileA-private'))), '42501', 'R-005-5 置き場所のパスは直せない');
select is(tests.err(tests.u('memberA'), format('update public.files set building_id = %L where id = %L', tests.id('buildingA2'), tests.id('fileA-private'))), '42501', 'R-005-5 建物は直せない');
select is(tests.err(tests.u('memberA'), format('update public.files set size = 1 where id = %L', tests.id('fileA-private'))), '42501', 'R-005-5 大きさは直せない');
select is(tests.err(tests.u('memberA'), format('update public.files set mime = ''text/plain'' where id = %L', tests.id('fileA-private'))), '42501', 'R-005-5 種類は直せない');
select is(tests.err(tests.u('memberA'), format('update public.files set tenant_id = %L where id = %L', tests.t('B'), tests.id('fileA-private'))), '42501', 'R-005-5 会社は変えられない');

-- R-005-6
select is(tests.n(tests.u('staffA'), format('select 1 from public.files where tenant_id = %L', tests.t('A'))), (select count(*) from public.files where tenant_id = tests.t('A')), 'R-005-6 スタッフも会社のファイルの行を読める（消した行も含め全部）');
select is(tests.n(tests.u('memberA'), format('select 1 from public.files where tenant_id = %L', tests.t('A'))), (select count(*) from public.files where tenant_id = tests.t('A')), 'R-005-6 社員は会社のファイルの行を読める');
select is(pg_temp.ins(tests.u('staffA'), 'A', 'buildingA1', 's.pdf', tests.t('A') || '/files/s/s.pdf'), '42501', 'R-005-6 スタッフ（master.edit なし）はファイルの行を作れない');
select is(tests.cnt(tests.u('staffA'), format('update public.files set name = ''z'' where id = %L', tests.id('fileA-shared'))), 0::bigint, 'R-005-6 スタッフはファイルの行を直せない（0 行）');
select is(tests.err(tests.u('staffA'), format('delete from public.files where id = %L', tests.id('fileA-shared'))), '42501', 'R-005-6 行の削除（delete）はだれにもできない');

-- R-005-7
select is(tests.n(tests.u('memberA'), format('select 1 from public.files where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-005-7 別の会社のファイルの行は読めない');
select is(tests.n(tests.u('adminB'), format('select 1 from public.files where id = %L', tests.id('fileA-shared'))), 0::bigint, 'R-005-7 別の会社の管理者も、A のファイルの行は読めない');
select is(pg_temp.ins(tests.u('memberA'), 'B', 'buildingB1', 'x.pdf', tests.t('B') || '/files/x/x.pdf'), '42501', 'R-005-7 別の会社のファイルの行は作れない');
select is(tests.cnt(tests.u('memberA'), format('update public.files set name = ''z'' where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-005-7 別の会社のファイルの行は直せない');
select is(tests.cnt(tests.u('adminA'), format('update public.files set deleted_at = now() where id = %L', tests.id('fileB-shared'))), 0::bigint, 'R-005-7 別の会社のファイルの行は消せない');
select is((select policy_type from app.policy_registry where table_name = 'files'), 'A+D', 'R-005-7 files は型 A に外部の型 D を足した形で登録されている（型の漏れのテストが全部の表に流れる）');

-- R-005-8：置き場所
select is(tests.n(tests.u('extA'), format('select 1 from storage.objects where name = %L', tests.file_path('A', 'fileA-shared'))), 0::bigint, 'R-005-8 外部の人は、共有されたファイルの実体も、置き場所から直接は読めない');
select is(tests.err(tests.u('extA'), format('insert into storage.objects (bucket_id, name) values (''tenant-files'', %L)', tests.t('A') || '/files/' || tests.id('extUp')::text || '/e.pdf')), '42501', 'R-005-8 外部の人は上げられない');
select is(tests.err(tests.u('memberA'), format('insert into storage.objects (bucket_id, name) values (''tenant-files'', %L)', tests.t('A') || '/files/' || tests.id('memUp')::text || '/m.pdf')), null, 'R-005-8 社員は自分の会社の files/ に上げられる');
select is(tests.err(tests.u('memberA'), format('insert into storage.objects (bucket_id, name) values (''tenant-files'', %L)', tests.t('B') || '/files/' || tests.id('memUp2')::text || '/m.pdf')), '42501', 'R-005-8 別の会社の files/ には上げられない');
select is(tests.n(tests.u('memberA'), format('select 1 from storage.objects where name = %L', tests.file_path('A', 'fileA-shared'))), 1::bigint, 'R-005-8 社内の人は、置き場所のファイルを読める');
select is((select public from storage.buckets where id = 'tenant-files'), false, 'R-005-8 置き場所は非公開');

select * from finish();
rollback;
