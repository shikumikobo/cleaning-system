-- 電波のない間の送り直しの、DB の側（R-001-31・33）と、番号（document_counters）
begin;
select * from no_plan();
select tests.seed();

-- 型 C1 の表を、端末で作った uuid で二度送る（PostgREST の upsert ignore-duplicates と同じ insert ... on conflict (id) do nothing）
select is(tests.cnt(tests.u('staffA'), format(
  'insert into public.client_error_logs (id, tenant_id, membership_id, device_id, kind, message) values (%L, %L, %L, ''dev-1'', ''sync_failed'', ''1回目'') on conflict (id) do nothing',
  tests.id('err-1'), tests.t('A'), tests.id('m:A:staffA'))), 1::bigint, 'R-001-31 端末の ID の記録を1回目に送ると、1件入る');
select is(tests.cnt(tests.u('staffA'), format(
  'insert into public.client_error_logs (id, tenant_id, membership_id, device_id, kind, message) values (%L, %L, %L, ''dev-1'', ''sync_failed'', ''2回目'') on conflict (id) do nothing',
  tests.id('err-1'), tests.t('A'), tests.id('m:A:staffA'))), 0::bigint, 'R-001-31 同じ端末の ID を二度送ると、二度目は何もしない');
select is((select count(*)::int from public.client_error_logs where id = tests.id('err-1')), 1, 'R-001-31 1件だけになる');
select is((select message from public.client_error_logs where id = tests.id('err-1')), '1回目', 'R-001-31 先に届いた中身が残る');

-- 二度目を、別の人・別の会社が同じ ID で送っても、元の行は変わらない・見えない
select is(tests.cnt(tests.u('staffB'), format(
  'insert into public.client_error_logs (id, tenant_id, membership_id, device_id, kind, message) values (%L, %L, %L, ''dev-x'', ''sync_failed'', ''乗っ取り'') on conflict (id) do nothing',
  tests.id('err-1'), tests.t('B'), tests.id('m:B:staffB'))), 0::bigint, 'R-001-31 別の会社が同じ ID で送っても、元の行は上書きされない');
select is((select message from public.client_error_logs where id = tests.id('err-1')), '1回目', 'R-001-31 元の行は変わらない');
select is(tests.err(tests.u('staffB'), format(
  'insert into public.client_error_logs (id, tenant_id, membership_id, device_id, kind, message) values (%L, %L, %L, ''dev-x'', ''sync_failed'', ''x'')',
  tests.id('err-1'), tests.t('B'), tests.id('m:B:staffB'))), '23505', 'R-001-31 on conflict なしで同じ ID を送ると重複のエラー（端末は「もう届いている」と扱える）');

-- RPC の形：端末の uuid を引数で受け取り、同じ uuid の二度目は何もしないで前の結果を返す
create table public.t_record (id uuid primary key, tenant_id uuid not null references public.tenants (id), membership_id uuid not null,
  v int not null default 0, unique (tenant_id, id));
select app.apply_policy('public.t_record', 'C1', '{}');
create function public.t_start(p_id uuid, p_tenant uuid, p_membership uuid) returns public.t_record
language plpgsql security definer set search_path = '' as $$
declare r public.t_record;
begin
  if not app.is_owner_membership(p_tenant, p_membership) then raise exception '本人のものだけ' using errcode = '42501'; end if;
  insert into public.t_record (id, tenant_id, membership_id, v) values (p_id, p_tenant, p_membership, 1)
  on conflict (id) do nothing;
  select * into r from public.t_record where id = p_id and tenant_id = p_tenant;
  return r;
end $$;
select app.lock_functions();
grant execute on function public.t_start(uuid, uuid, uuid) to authenticated;

select is(tests.run_as(tests.u('staffA'), format('select (public.t_start(%L, %L, %L)).v as v', tests.id('rec-1'), tests.t('A'), tests.id('m:A:staffA'))) -> 'rows' -> 0 ->> 'v', '1',
          'R-001-31 RPC を1回目に呼ぶと、記録ができて結果が返る');
select is(tests.run_as(tests.u('staffA'), format('select (public.t_start(%L, %L, %L)).v as v', tests.id('rec-1'), tests.t('A'), tests.id('m:A:staffA'))) -> 'rows' -> 0 ->> 'v', '1',
          'R-001-31 同じ uuid の RPC を二度呼ぶと、二度目は何もしないで前の結果を返す');
select is((select count(*)::int from public.t_record where id = tests.id('rec-1')), 1, 'R-001-31 RPC を二度呼んでも1件');
select is(tests.run_as(tests.u('staffA'), format('select (public.t_start(%L, %L, %L)).v as v', tests.id('rec-2'), tests.t('A'), tests.id('m:A:staffA'))) -> 'rows' -> 0 ->> 'v', '1',
          'R-001-31 別の uuid なら、別の記録になる');
select is((select count(*)::int from public.t_record), 2, 'R-001-31 uuid ごとに1件');
select is(tests.run_as(tests.u('staffB'), format('select (public.t_start(%L, %L, %L)).v as v', tests.id('rec-1'), tests.t('B'), tests.id('m:B:staffB'))) -> 'rows' -> 0 ->> 'v', null,
          'R-001-19 別の会社が同じ uuid で呼んでも、A の記録の結果は返らない');
select is(tests.run_as(tests.u('staffA'), format('select (public.t_start(%L, %L, %L)).v as v', tests.id('rec-9'), tests.t('A'), tests.id('m:A:memberA'))) ->> 'error', '42501',
          'R-001-23 他人の所属では RPC を呼べない');

-- R-001-33 送れなかったとき、端末のエラーとして記録する（端末・時刻・中身）
select is(tests.err(tests.u('staffA'), format(
  'insert into public.client_error_logs (tenant_id, membership_id, device_id, app_version, kind, message, context, at) values (%L, %L, ''dev-9'', ''1.0.0'', ''sync_failed'', ''送れなかった'', ''{"table":"photos","id":"abc"}'', now() - interval ''5 minutes'')',
  tests.t('A'), tests.id('m:A:staffA'))), null, 'R-001-33 スタッフは、自分の端末のエラーを記録できる');
select is((select device_id || '/' || kind || '/' || message || '/' || (context ->> 'table') from public.client_error_logs where device_id = 'dev-9'),
          'dev-9/sync_failed/送れなかった/photos', 'R-001-33 端末・種類・中身が残る');
select ok((select at < received_at from public.client_error_logs where device_id = 'dev-9'), 'R-001-33 端末で起きた時刻（at）と、届いた時刻（received_at）が別に残る');
select is(tests.err(tests.u('staffA'), format(
  'insert into public.client_error_logs (tenant_id, membership_id, device_id, kind, message) values (%L, %L, ''dev-9'', ''sync_failed'', ''他人のふり'')',
  tests.t('A'), tests.id('m:A:memberA'))), '42501', 'R-001-33 他人の所属で端末のエラーは書けない');
select is(tests.err(tests.u('staffA'), format(
  'insert into public.client_error_logs (tenant_id, membership_id, device_id, kind, message) values (%L, %L, ''dev-9'', ''broken'', ''x'')',
  tests.t('A'), tests.id('m:A:staffA'))), '23514', 'R-001-33 種類は「送れない」「画面のエラー」だけ');
select is(tests.cnt(tests.u('staffA'), format('update public.client_error_logs set message = ''消す'' where device_id = ''dev-9''')), -1::bigint,
          'R-001-33 端末のエラーは書き足すだけ（あとから直せない）');
select is(tests.n(tests.u('staffA'), 'select 1 from public.client_error_logs'), 3::bigint, 'R-001-33 スタッフは、自分のエラーだけ読める（種の1件と err-1 と dev-9）');
select is(tests.n(tests.u('memberA'), format('select 1 from public.client_error_logs where tenant_id = %L', tests.t('A'))) >= 3, true, 'R-001-33 work.assign を持つ人は、会社の全員のエラーを読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.client_error_logs'), 0::bigint, 'R-001-33 外部の人は読めない');

-- 番号（document_counters）：RPC の中だけが振る
select is(app.next_doc_no(tests.t('A'), 'quote', 2027), 1, 'R-001-23 番号：その年の最初は 1');
select is(app.next_doc_no(tests.t('A'), 'quote', 2027), 2, 'R-001-23 番号：続けて 2');
select is(app.next_doc_no(tests.t('A'), 'invoice', 2027), 1, 'R-001-23 番号：種類が違えば別の数え方');
select is(app.next_doc_no(tests.t('A'), 'quote', 2028), 1, 'R-001-23 番号：年が違えば別の数え方');
select is(app.next_doc_no(tests.t('B'), 'quote', 2027), 1, 'R-001-19 番号：会社ごとに別の数え方');
select is(app.next_doc_no(tests.t('A'), 'quote', 2026), 4, 'R-001-23 番号：途中から（種が 3 のところ）続く');
select is(tests.run_as(tests.u('adminA'), format('select app.next_doc_no(%L, ''quote'', 2027)', tests.t('A'))) ->> 'error', '42501', 'R-001-23 管理者も、番号の関数は直接は呼べない');
select is(tests.n(tests.u('adminA'), 'select 1 from public.document_counters'), 0::bigint, 'R-001-23 管理者も、番号の表は読めない');
select is(tests.cnt(tests.u('adminA'), 'update public.document_counters set last_no = 0'), -1::bigint, 'R-001-23 番号の表は直接は直せない');
select is(tests.run_as_anon('select app.next_doc_no(null, ''quote'', 2027)') ->> 'error', '42501', 'R-001-23 ログインしていない人は番号を振れない');

select * from finish();
rollback;
