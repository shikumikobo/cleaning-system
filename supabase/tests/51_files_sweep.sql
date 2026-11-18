-- 機能 005：ファイルの掃除（R-005-14〜18）。置き場所のファイルと行のずれを、定時の処理が直す
begin;
select * from no_plan();
select tests.seed();

-- 種のファイルの実体はいま作ったばかり。古いものと新しいものを作り分ける
create or replace function pg_temp.obj(p_path text, p_age interval) returns void language sql as $$
  insert into storage.objects (bucket_id, name, created_at) values ('tenant-files', p_path, now() - p_age)
$$;

-- 結果を文字の配列で取る（サービスの役割で呼ぶ）
create or replace function pg_temp.sweep_names(p_tenant text, p_grace text default '1 day') returns text language plpgsql as $$
declare v jsonb;
begin
  v := tests.run_as_service(format('select array_to_string(array(select n from unnest(public.file_sweep_orphans(%L, %L::interval, 1000)) n order by n), '','') as r', tests.t(p_tenant), p_grace));
  if v ? 'error' then return 'ERROR ' || (v ->> 'error'); end if;
  return coalesce(v -> 'rows' -> 0 ->> 'r', '');
end $$;

-- 実体：種の分は作ったばかり
select is(pg_temp.sweep_names('A'), '', 'R-005-14 作ったばかりの実体は（行がなくても）対象にしない・行のある実体も対象にしない');

-- 古い実体を作る
update storage.objects set created_at = now() - interval '3 days' where bucket_id = 'tenant-files';
select pg_temp.obj(tests.t('A') || '/files/' || tests.id('orphanOld')::text || '/orphan.pdf', interval '3 days');
select pg_temp.obj(tests.t('A') || '/files/' || tests.id('orphanNew')::text || '/new.pdf', interval '1 hour');
select pg_temp.obj(tests.t('A') || '/photos/' || tests.id('photoOld')::text || '.jpg', interval '3 days');
select pg_temp.obj(tests.t('A') || '/receipts/' || tests.id('rcpOld')::text || '.jpg', interval '3 days');
select pg_temp.obj(tests.t('B') || '/files/' || tests.id('orphanB')::text || '/b.pdf', interval '3 days');
select pg_temp.obj(tests.file_path('A', 'fileA-deleted'), interval '3 days');

select is(pg_temp.sweep_names('A'), tests.t('A') || '/files/' || tests.id('orphanOld')::text || '/orphan.pdf',
          'R-005-14 行のない古い実体だけが対象（行のある実体・猶予の間の新しい実体・消して間もない行の実体は対象にしない）');
select is(pg_temp.sweep_names('A', '30 minutes') like '%' || tests.id('orphanNew')::text || '%', true, 'R-005-14 猶予を短くすれば、新しい実体も対象になる（猶予は呼び出しで決まる）');

-- R-005-14（消した行）：猶予より前に消した行の実体も対象
update public.files set deleted_at = now() - interval '3 days' where id = tests.id('fileA-deleted');
select is(pg_temp.sweep_names('A') like '%' || tests.id('fileA-deleted')::text || '%', true, 'R-005-14 猶予より前に消した行の実体も、対象になる');
update public.files set deleted_at = now() where id = tests.id('fileA-deleted');
select is(pg_temp.sweep_names('A') like '%' || tests.id('fileA-deleted')::text || '%', false, 'R-005-14 消して間もない行の実体は、対象にしない');
update public.files set deleted_at = now() - interval '3 days' where id = tests.id('fileA-deleted');

-- R-005-16
select is(pg_temp.sweep_names('A') like '%/photos/%' or pg_temp.sweep_names('A') like '%/receipts/%', false, 'R-005-16 files/ の外（写真・レシート）は対象にしない');
select is(pg_temp.sweep_names('A') like '%' || tests.id('orphanB')::text || '%', false, 'R-005-16 ほかの会社のファイルは、この会社の掃除の対象にしない');
select is(pg_temp.sweep_names('B'), tests.t('B') || '/files/' || tests.id('orphanB')::text || '/b.pdf', 'R-005-16 B の掃除は B の行のない古い実体だけを返す');

-- R-005-15：ファイルのない行
update public.files set created_at = now() - interval '3 days' where id in (tests.id('fileA-b2'), tests.id('fileA-shared'));
insert into public.files (id, tenant_id, building_id, name, mime, size, storage_path, created_at)
values (tests.id('fileB-noobj'), tests.t('B'), tests.id('buildingB1'), 'B 実体なし.pdf', 'application/pdf', 1, tests.t('B') || '/files/' || tests.id('fileB-noobj')::text || '/n.pdf', now() - interval '3 days');
insert into public.files (id, tenant_id, building_id, name, mime, size, storage_path)
values (tests.id('fileA-fresh'), tests.t('A'), tests.id('buildingA1'), '上げている途中.pdf', 'application/pdf', 1, tests.t('A') || '/files/' || tests.id('fileA-fresh')::text || '/f.pdf');

select is((tests.run_as_service(format('select public.file_sweep_rows(%L, ''1 day''::interval) as n', tests.t('A'))) -> 'rows' -> 0 ->> 'n')::int, 1,
          'R-005-15 猶予より前の、実体のない行（A に1つ）を論理削除して、件数を返す');
select isnt((select deleted_at from public.files where id = tests.id('fileA-b2')), null, 'R-005-15 実体のない古い行は論理削除された');
select is((select deleted_at from public.files where id = tests.id('fileA-shared')), null, 'R-005-15 実体のある行は消さない');
select is((select deleted_at from public.files where id = tests.id('fileA-fresh')), null, 'R-005-15 猶予の間の行（実体がまだ）は消さない');
select is((select deleted_at from public.files where id = tests.id('fileB-noobj')), null, 'R-005-16 A の掃除は、B の行を触らない');
select is((select count(*)::int from public.audit_logs where table_name = 'files' and row_id = tests.id('fileA-b2') and source = 'job'), 1, 'R-005-15 変更の履歴に、定時の処理（job）として残る');
select is((tests.run_as_service(format('select public.file_sweep_rows(%L, ''1 day''::interval) as n', tests.t('A'))) -> 'rows' -> 0 ->> 'n')::int, 0, 'R-005-15 二度目は何も変えない');
select is((tests.run_as_service(format('select public.file_sweep_rows(%L, ''1 day''::interval) as n', tests.t('B'))) -> 'rows' -> 0 ->> 'n')::int, 1, 'R-005-15 B の掃除は B の行だけを論理削除する');

-- R-005-17：処理の記録
create or replace function pg_temp.start_run(p_tenant text) returns uuid language plpgsql as $$
declare v jsonb;
begin
  v := tests.run_as_service(format('select public.file_sweep_start_run(%L) as r', tests.t(p_tenant)));
  return (v -> 'rows' -> 0 ->> 'r')::uuid;
end $$;
create temp table _run (a1 uuid, a2 uuid, b1 uuid);
insert into _run (a1) select pg_temp.start_run('A');
update _run set a2 = pg_temp.start_run('A');
update _run set b1 = pg_temp.start_run('B');
select isnt((select a1 from _run), null, 'R-005-17 掃除を始めると、処理の記録（running）ができる');
select is((select a2 from _run), null, 'R-005-17 同じ会社の掃除が動いている間は、2つ目は始まらない');
select isnt((select b1 from _run), null, 'R-005-17 別の会社の掃除は同時に動ける');
select is((select kind || ':' || status from public.job_runs where id = (select a1 from _run)), 'sweep_files:running', 'R-005-17 種類は sweep_files');
select is((select tenant_id from public.job_runs where id = (select a1 from _run)), tests.t('A'), 'R-005-17 記録の会社は掃除した会社');
select is(coalesce(tests.run_as_service(format('select public.file_sweep_finish_run(%L, %L, ''success'', ''{"removed": 1}''::jsonb, null) as r', tests.t('A'), (select a1 from _run))) -> 'rows' -> 0 ->> 'r', ''), 'true', 'R-005-17 記録を閉じられる');
select is((select status || ':' || (counts ->> 'removed') from public.job_runs where id = (select a1 from _run)), 'success:1', 'R-005-17 閉じた記録に、結果の数が残る');
select is(tests.run_as_service(format('select public.file_sweep_finish_run(%L, %L, ''success'', ''{}''::jsonb, null) as r', tests.t('B'), (select a1 from _run))) -> 'rows' -> 0 ->> 'r', 'false', 'R-005-17 別の会社の記録は閉じられない');
select is(tests.run_as_service(format('select public.file_sweep_finish_run(%L, %L, ''failure'', ''{}''::jsonb, %L) as r', tests.t('B'), (select b1 from _run), repeat('x', 500))) -> 'rows' -> 0 ->> 'r', 'true', 'R-005-17 失敗で閉じられる');
select is((select length(error) from public.job_runs where id = (select b1 from _run)), 300, 'R-005-17 エラーの文字は 300 字までに切る');
select isnt(pg_temp.start_run('A'), null, 'R-005-17 閉じたあとは、同じ会社でもう一度始められる');
update public.job_runs set started_at = now() - interval '31 minutes' where tenant_id = tests.t('A') and kind = 'sweep_files' and status = 'running';
select isnt(pg_temp.start_run('A'), null, 'R-005-17 30 分を過ぎた古い running は、失敗で閉じて、新しく始められる');
select is((select count(*)::int from public.job_runs where tenant_id = tests.t('A') and kind = 'sweep_files' and status = 'failure' and error = 'timeout'), 1, 'R-005-17 古い running は timeout の失敗になる');
select is(tests.run_as_service('select count(*)::int as n from public.file_sweep_tenants()') -> 'rows' -> 0 ->> 'n', '2', 'R-005-17 掃除する会社の一覧（消していない会社）が返る');

-- R-005-18：service_role だけ
select is(tests.err(tests.u('adminA'), format('select public.file_sweep_orphans(%L, ''1 day''::interval, 10)', tests.t('A'))), '42501', 'R-005-18 管理者でも、掃除の洗い出しは呼べない');
select is(tests.err(tests.u('adminA'), format('select public.file_sweep_rows(%L, ''1 day''::interval)', tests.t('A'))), '42501', 'R-005-18 管理者でも、行の掃除は呼べない');
select is(tests.err(tests.u('adminA'), format('select public.file_sweep_start_run(%L)', tests.t('A'))), '42501', 'R-005-18 管理者でも、記録の開始は呼べない');
select is(tests.err(tests.u('adminA'), format('select public.file_sweep_finish_run(%L, %L, ''success'', ''{}''::jsonb, null)', tests.t('A'), tests.id('x'))), '42501', 'R-005-18 管理者でも、記録の終了は呼べない');
select is(tests.err(tests.u('adminA'), 'select public.file_sweep_tenants()'), '42501', 'R-005-18 管理者でも、会社の一覧は呼べない');
select is(tests.err(tests.u('operator'), format('select public.file_sweep_orphans(%L, ''1 day''::interval, 10)', tests.t('A'))), '42501', 'R-005-18 運営（ログインした人）も呼べない');
select is(coalesce(tests.run_as_anon(format('select public.file_sweep_orphans(%L, ''1 day''::interval, 10)', tests.t('A'))) ->> 'error', 'ok'), '42501', 'R-005-18 ログインしていない人は呼べない');

select * from finish();
rollback;
