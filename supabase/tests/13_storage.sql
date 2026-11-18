-- ファイルの置き場所（R-001-21）：パスが自分の会社の ID で始まらなければ、上げられず、読めない
begin;
select * from no_plan();
select tests.seed();

select is((select public from storage.buckets where id = 'tenant-files'), false, 'R-001-21 置き場所は非公開');

create or replace function pg_temp.ins(p_uid uuid, p_name text) returns text language sql as $$
  select coalesce(tests.run_as(p_uid, format('insert into storage.objects (bucket_id, name, owner) values (''tenant-files'', %L, %L)', p_name, p_uid)) ->> 'error', 'ok')
$$;

select is(pg_temp.ins(tests.u('memberA'), tests.t('A') || '/photos/a.jpg'), 'ok', 'R-001-21 自分の会社のフォルダには上げられる（社員）');
select is(pg_temp.ins(tests.u('staffA'), tests.t('A') || '/photos/s.jpg'), 'ok', 'R-001-21 自分の会社のフォルダには上げられる（スタッフ。現場の写真）');
select is(pg_temp.ins(tests.u('memberA'), tests.t('B') || '/photos/x.jpg'), '42501', 'R-001-21 別の会社のフォルダには上げられない');
select is(pg_temp.ins(tests.u('memberA'), 'photos/no-tenant.jpg'), '42501', 'R-001-21 会社の ID で始まらないパスには上げられない');
select is(pg_temp.ins(tests.u('memberA'), 'x/' || tests.t('A') || '/a.jpg'), '42501', 'R-001-21 会社の ID が先頭でなければ上げられない');
select is(pg_temp.ins(tests.u('memberA'), tests.t('A')::text || 'a.jpg'), '42501', 'R-001-21 会社の ID の直後が / でなければ上げられない');
select is(pg_temp.ins(tests.u('extA'), tests.t('A') || '/photos/e.jpg'), '42501', 'R-001-23 外部の人は上げられない');
select is(pg_temp.ins(tests.u('nobody'), tests.t('A') || '/photos/n.jpg'), '42501', 'R-001-21 どの会社にも属さない人は上げられない');
select is(coalesce(tests.run_as_anon(format('insert into storage.objects (bucket_id, name) values (''tenant-files'', %L)', tests.t('A') || '/photos/anon.jpg')) ->> 'error', 'ok'), '42501',
          'R-001-21 ログインしていない人は上げられない');
select is(pg_temp.ins(tests.u('memberA'), tests.t('A') || '/photos/a.jpg'), 'ok', '（同じ名前は、ここでは制約がないので上げられる）');

-- 読む
insert into storage.objects (bucket_id, name) values
  ('tenant-files', tests.t('B') || '/docs/b.pdf'), ('tenant-files', tests.t('A') || '/docs/a.pdf');
select is(tests.n(tests.u('memberA'), format('select 1 from storage.objects where name like %L', tests.t('B') || '/%')), 0::bigint, 'R-001-21 別の会社のファイルは読めない');
select ok(tests.n(tests.u('memberA'), format('select 1 from storage.objects where name like %L', tests.t('A') || '/%')) >= 2, 'R-001-21 自分の会社のファイルは読める');
select ok(tests.n(tests.u('staffA'), format('select 1 from storage.objects where name like %L', tests.t('A') || '/%')) >= 2, 'R-001-21 スタッフも自分の会社のファイルは読める');
select is(tests.n(tests.u('extA'), 'select 1 from storage.objects'), 0::bigint, 'R-001-21 外部の人は、置き場所を直接は読めない（期限つきの URL で渡す）');
select is(tests.n(tests.u('nobody'), 'select 1 from storage.objects'), 0::bigint, 'R-001-21 どの会社にも属さない人は読めない');
select is(tests.n(tests.u('adminB'), format('select 1 from storage.objects where name like %L', tests.t('A') || '/%')), 0::bigint, 'R-001-21 別の会社の管理者も、A のファイルは読めない');
select is(coalesce(jsonb_array_length(tests.run_as_anon('select 1 from storage.objects') -> 'rows'), 0), 0, 'R-001-21 ログインしていない人は読めない（0 行かエラー）');

-- 直す・消す
select is(tests.cnt(tests.u('memberA'), format('update storage.objects set name = %L where name = %L', tests.t('A') || '/docs/renamed.pdf', tests.t('A') || '/docs/a.pdf')), 1::bigint, '自分の会社のファイルは直せる');
select is(tests.err(tests.u('memberA'), format('update storage.objects set name = %L where name = %L', tests.t('B') || '/docs/stolen.pdf', tests.t('A') || '/docs/renamed.pdf')), '42501',
          'R-001-21 別の会社のフォルダへ移す（名前を変える）ことはできない');
select is(tests.cnt(tests.u('memberA'), format('delete from storage.objects where name = %L', tests.t('B') || '/docs/b.pdf')), 0::bigint, 'R-001-21 別の会社のファイルは消せない');
select is(tests.cnt(tests.u('staffA'), format('delete from storage.objects where name = %L', tests.t('A') || '/docs/renamed.pdf')), 1::bigint, '現場の記録の権限（field.record）を持つスタッフは、自分の会社のファイルを消せる');
select is(tests.cnt(tests.u('extA'), format('delete from storage.objects where name like %L', tests.t('A') || '/%')), 0::bigint, 'R-001-23 外部の人は消せない');

-- 運営は、許可の間だけ読める
select is(tests.n(tests.u('operator'), format('select 1 from storage.objects where name like %L', tests.t('A') || '/%')), 0::bigint, 'R-001-2 運営は、許可がなければファイルを読めない');
insert into public.support_access_grants (tenant_id, granted_by, reason, ends_at) values (tests.t('A'), tests.u('adminA'), '調査', now() + interval '1 hour');
select ok(tests.n(tests.u('operator'), format('select 1 from storage.objects where name like %L', tests.t('A') || '/%')) >= 1, 'R-001-3 許可の間、運営はファイルを読める');
select is(tests.n(tests.u('operator'), format('select 1 from storage.objects where name like %L', tests.t('B') || '/%')), 0::bigint, 'R-001-3 許可は A だけ。B のファイルは読めない');
select is(tests.err(tests.u('operator'), format('insert into storage.objects (bucket_id, name) values (''tenant-files'', %L)', tests.t('A') || '/op.jpg')), '42501', 'R-001-3 許可の間も、運営は上げられない');

-- 表の storage_path の check 制約に使う関数
select is(app.storage_path_ok(tests.t('A'), tests.t('A') || '/photos/a.jpg'), true, 'R-001-21 storage_path_ok：自分の会社の ID で始まる');
select is(app.storage_path_ok(tests.t('A'), tests.t('B') || '/photos/a.jpg'), false, 'R-001-21 storage_path_ok：別の会社の ID は不可');
select is(app.storage_path_ok(tests.t('A'), tests.t('A')::text), false, 'R-001-21 storage_path_ok：フォルダの下にファイルがなければ不可');
select is(app.storage_path_ok(tests.t('A'), null), false, 'R-001-21 storage_path_ok：空は不可');

select * from finish();
rollback;
