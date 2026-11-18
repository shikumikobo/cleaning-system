-- 機能 008：写真の掃除（R-008-16〜18）。行のない写真の実体と、実体のない写真の行を、定時の処理が直す
begin;
select * from no_plan();
select tests.seed();

create or replace function pg_temp.obj(p_path text, p_age interval) returns void language sql as $$
  insert into storage.objects (bucket_id, name, created_at) values ('tenant-files', p_path, now() - p_age)
$$;
create or replace function pg_temp.sweep_names(p_tenant text, p_grace text default '1 day') returns text language plpgsql as $$
declare v jsonb;
begin
  v := tests.run_as_service(format('select array_to_string(array(select n from unnest(public.photo_sweep_orphans(%L, %L::interval, 1000)) n order by n), '','') as r', tests.t(p_tenant), p_grace));
  if v ? 'error' then return 'ERROR ' || (v ->> 'error'); end if;
  return coalesce(v -> 'rows' -> 0 ->> 'r', '');
end $$;
create or replace function pg_temp.p(p_tenant text, p_name text, p_file text default 'photo.jpg') returns text language sql as $$
  select tests.photo_path(p_tenant, p_name, p_file)
$$;

-- ===== R-008-16 行のない写真の実体 =====
select is(pg_temp.sweep_names('A'), '', 'R-008-16 作ったばかりの実体は（行があっても・なくても）対象にしない');
update storage.objects set created_at = now() - interval '3 days' where bucket_id = 'tenant-files';
select is(pg_temp.sweep_names('A'), '', 'R-008-16 行のある写真の実体（元の画像・小さな画像とも）は、古くても対象にしない');
select pg_temp.obj(pg_temp.p('A', 'orphanOld'), interval '3 days');
select pg_temp.obj(pg_temp.p('A', 'orphanOld', 'thumb.jpg'), interval '3 days');
select pg_temp.obj(pg_temp.p('A', 'orphanNew'), interval '1 hour');
select pg_temp.obj(tests.t('A') || '/files/' || tests.id('fOld')::text || '/x.pdf', interval '3 days');
select pg_temp.obj(tests.t('A') || '/receipts/' || tests.id('rcOld')::text || '.jpg', interval '3 days');
select pg_temp.obj(pg_temp.p('B', 'orphanB'), interval '3 days');
select is(pg_temp.sweep_names('A'), pg_temp.p('A', 'orphanOld') || ',' || pg_temp.p('A', 'orphanOld', 'thumb.jpg'),
          'R-008-16 行のない古い実体（元の画像・小さな画像）だけが対象。行のある実体と、猶予の間の新しい実体は対象にしない');
select is(pg_temp.sweep_names('A') like '%/files/%' or pg_temp.sweep_names('A') like '%/receipts/%', false, 'R-008-16 photos/ の外（ファイル・レシート）は対象にしない（ファイルの掃除は 005）');
select is(pg_temp.sweep_names('A') like '%' || tests.t('B')::text || '%', false, 'R-008-16 ほかの会社の実体は、この会社の掃除の対象にしない');
select is(pg_temp.sweep_names('B'), pg_temp.p('B', 'orphanB'), 'R-008-16 B の掃除は、B の行のない古い実体だけを返す');
select is(pg_temp.sweep_names('A', '30 minutes') like '%' || tests.id('orphanNew')::text || '%', true, 'R-008-16 猶予を短くすれば、新しい実体も対象になる（猶予は呼び出しで決まる）');

-- 消した写真：猶予の間は残し、猶予より前に消したものの実体は対象にする
update public.photos set deleted_at = now() where id = tests.id('photoA-b2');
select is(pg_temp.sweep_names('A') like '%' || tests.id('photoA-b2')::text || '%', false, 'R-008-16 消して間もない写真の実体は、対象にしない');
update public.photos set deleted_at = now() - interval '3 days' where id = tests.id('photoA-b2');
select is(pg_temp.sweep_names('A') like '%' || tests.id('photoA-b2')::text || '/photo.jpg%' and pg_temp.sweep_names('A') like '%' || tests.id('photoA-b2')::text || '/thumb.jpg%', true,
          'R-008-16 猶予より前に消した写真は、元の画像も小さな画像も対象になる');

-- 小さな画像だけが行から指されていて、元の画像の実体がない場合の確かめ
-- 元の画像を指す行があれば、元の画像は消さない（行が指しているパスだけを見る）
select is(pg_temp.sweep_names('A') like '%' || tests.id('photoA-staff')::text || '%', false, 'R-008-16 生きている行が指す実体は、対象にしない');

-- ===== R-008-17 実体のない行 =====
select tests.make_photo('A', 'noObj', 'buildingA1', 'staffA', 'before');
update public.photos set created_at = now() - interval '3 days' where id = tests.id('noObj');
select tests.make_photo('A', 'fresh', 'buildingA1', 'staffA', 'before'); -- 上げている途中（行はあるが実体はまだ）
select tests.make_photo('B', 'noObjB', 'buildingB1', 'staffB', 'before');
update public.photos set created_at = now() - interval '3 days' where id = tests.id('noObjB');
select is((tests.run_as_service(format('select public.photo_sweep_rows(%L, ''1 day''::interval) as n', tests.t('A'))) -> 'rows' -> 0 ->> 'n')::int, 1,
          'R-008-17 猶予より前の、実体のない写真の行（A に1つ）を論理削除して、件数を返す');
select isnt((select deleted_at from public.photos where id = tests.id('noObj')), null, 'R-008-17 実体のない古い行は論理削除された');
select is((select deleted_at from public.photos where id = tests.id('photoA-obs')), null, 'R-008-17 実体のある行は消さない');
select is((select deleted_at from public.photos where id = tests.id('fresh')), null, 'R-008-17 猶予の間の行（実体がまだ）は消さない');
select is((select deleted_at from public.photos where id = tests.id('noObjB')), null, 'R-008-17 A の掃除は、B の行を触らない');
select is((tests.run_as_service(format('select public.photo_sweep_rows(%L, ''1 day''::interval) as n', tests.t('A'))) -> 'rows' -> 0 ->> 'n')::int, 0, 'R-008-17 もう一度流しても、何も増えない');

-- ===== R-008-18 呼べるのは service_role だけ =====
select is(tests.err(tests.u('adminA'), format('select public.photo_sweep_orphans(%L)', tests.t('A'))), '42501', 'R-008-18 管理者も、写真の掃除の関数は呼べない');
select is(tests.err(tests.u('staffA'), format('select public.photo_sweep_rows(%L)', tests.t('A'))), '42501', 'R-008-18 スタッフも呼べない');
select is(coalesce(tests.run_as_anon(format('select public.photo_sweep_orphans(%L)', tests.t('A'))) ->> 'error', 'ok'), '42501', 'R-008-18 ログインしていない人も呼べない');
select is(coalesce(tests.run_as_service(format('select public.photo_sweep_orphans(%L)', tests.t('A'))) ->> 'error', 'ok'), 'ok', 'R-008-18 service_role は呼べる');
select is((select count(*)::int from pg_proc p where p.proname in ('photo_sweep_orphans', 'photo_sweep_rows') and p.prosecdef
           and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')), 2, 'R-008-18 どちらも security definer で、search_path を固定している');

select * from finish();
rollback;
