-- 機能 005：外部の人の専用ページ（型 D の決まり。R-005-19〜24）
-- 外部の人 extA は、会社 A の建物 A1 だけを許されている（tests.seed()）。extB は会社 B の建物 B1。
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

-- R-005-19：許された建物の、共有された、消していない行だけ
select is(pg_temp.ids(tests.u('extA'), 'select id from public.files'), tests.id('fileA-shared')::text,
          'R-005-19 外部の人は、許された建物の共有されたファイルの行だけを読める（共有なし・別の建物・消した行・別の会社のものは読めない）');
select is(pg_temp.ids(tests.u('extB'), 'select id from public.files'), tests.id('fileB-shared')::text, 'R-005-19 B の外部の人は、B のファイルだけを読める');
select is(tests.n(tests.u('extA'), format('select 1 from public.files where id = %L', tests.id('fileA-private'))), 0::bigint, 'R-005-19 共有していないファイルは読めない');
select is(tests.n(tests.u('extA'), format('select 1 from public.files where id = %L', tests.id('fileA-b2'))), 0::bigint, 'R-005-19 許されていない建物のファイルは読めない');
select is(tests.n(tests.u('extA'), format('select 1 from public.files where id = %L', tests.id('fileA-deleted'))), 0::bigint, 'R-005-19 消したファイルは読めない');
select is(tests.n(tests.u('extA'), format('select 1 from public.files where id = %L', tests.id('fileB-shared'))), 0::bigint, 'R-005-22 別の会社のファイルは読めない');
select is(tests.n(tests.u('nobody'), 'select 1 from public.files'), 0::bigint, 'R-005-19 どの会社にも属さない人は読めない');
select is(coalesce(tests.run_as_anon('select 1 from public.files') ->> 'error', 'ok'), '42501', 'R-005-19 ログインしていない人は読めない');
select is(tests.n(tests.u('memberA'), format('select 1 from public.files where tenant_id = %L', tests.t('A'))), 4::bigint, 'R-005-19 会社の中の人は、共有に関係なく読める（外部の人の制限は外部だけ）');

-- 許しを外す（外部の人の許された建物を消す）と読めない
update public.external_building_access set deleted_at = now() where id = tests.id('ebaA');
select is(tests.n(tests.u('extA'), 'select 1 from public.files'), 0::bigint, 'R-005-19 許された建物から外されたら、すぐに読めない');
update public.external_building_access set deleted_at = null where id = tests.id('ebaA');
select is(tests.n(tests.u('extA'), 'select 1 from public.files'), 1::bigint, 'R-005-19 許しを戻すと読める');
-- 止められた外部の人は読めない
update public.memberships set status = 'suspended' where id = tests.id('m:A:extA');
select is(tests.n(tests.u('extA'), 'select 1 from public.files'), 0::bigint, 'R-005-19 止められた外部の人は読めない');
update public.memberships set status = 'active' where id = tests.id('m:A:extA');

-- R-005-20：共有をオフにするとすぐ読めない
select is(tests.cnt(tests.u('memberA'), format('update public.files set shared_external = false where id = %L', tests.id('fileA-shared'))), 1::bigint, '（社員が共有をオフにする）');
select is(tests.n(tests.u('extA'), 'select 1 from public.files'), 0::bigint, 'R-005-20 共有をオフにしたら、外部の人はすぐ読めない');
select is(tests.cnt(tests.u('memberA'), format('update public.files set shared_external = true where id = %L', tests.id('fileA-shared'))), 1::bigint, '（社員が共有をオンに戻す）');
select is(tests.n(tests.u('extA'), 'select 1 from public.files'), 1::bigint, 'R-005-20 オンに戻すと、また読める');
select is(tests.cnt(tests.u('staffA'), format('update public.files set shared_external = false where id = %L', tests.id('fileA-shared'))), 0::bigint, 'R-005-20 共有を切り替えられるのは社員だけ（スタッフは 0 行）');

-- R-005-21：外部の人は書けない
select is(tests.err(tests.u('extA'), format(
  'insert into public.files (tenant_id, building_id, name, mime, size, storage_path) values (%L, %L, ''x'', ''application/pdf'', 1, %L)',
  tests.t('A'), tests.id('buildingA1'), tests.t('A') || '/files/ext/x.pdf')), '42501', 'R-005-21 外部の人はファイルの行を作れない');
select is(tests.cnt(tests.u('extA'), format('update public.files set shared_external = false where id = %L', tests.id('fileA-shared'))), 0::bigint, 'R-005-21 外部の人はファイルの行を直せない（共有の切り替えも）');
select is(tests.cnt(tests.u('extA'), format('update public.files set deleted_at = now() where id = %L', tests.id('fileA-shared'))), 0::bigint, 'R-005-21 外部の人はファイルの行を消せない');
select is(tests.err(tests.u('extA'), format('delete from public.files where id = %L', tests.id('fileA-shared'))), '42501', 'R-005-21 外部の人は行を削除（delete）できない');
select is(tests.cnt(tests.u('extA'), format('update public.buildings set name = ''書き換え'' where id = %L', tests.id('buildingA1'))), 0::bigint, 'R-005-21 外部の人は建物も直せない');

-- R-005-22：建物の名前と住所
select is(pg_temp.ids(tests.u('extA'), 'select id from public.buildings'), tests.id('buildingA1')::text, 'R-005-22 外部の人は、許された建物（A1）だけを読める。A2 は読めない');
select is((tests.run_as(tests.u('extA'), 'select name, address from public.buildings') -> 'rows' -> 0 ->> 'name') || '/' || (tests.run_as(tests.u('extA'), 'select name, address from public.buildings') -> 'rows' -> 0 ->> 'address'),
          'テストマンションA1/東京都A区1-1-1', 'R-005-22 建物の名前と住所を読める');
select is(pg_temp.ids(tests.u('extB'), 'select id from public.buildings'), tests.id('buildingB1')::text, 'R-005-22 B の外部の人は B1 だけ。A の建物は読めない');
select is(tests.n(tests.u('extA'), format('select 1 from public.buildings where id = %L', tests.id('buildingB1'))), 0::bigint, 'R-005-22 ほかの会社の建物は読めない');

-- R-005-23：読ませないもの
create or replace function pg_temp.readable(p_uid uuid, p_tables text[]) returns text language plpgsql as $$
declare t text; v text := '';
begin
  foreach t in array p_tables loop
    continue when to_regclass('public.' || quote_ident(t)) is null; -- まだ表がない機能の分は飛ばす（表ができたら自動で入る）
    if coalesce(tests.n(p_uid, format('select 1 from public.%I', t)), 1) > 0 then v := v || t || ','; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.readable(tests.u('extA'), array['building_profiles', 'rooms', 'building_areas', 'clients', 'client_contacts']), '',
          'R-005-23 外部の人は、建物カルテ・部屋・場所・取引先・担当者を読めない');
select is(pg_temp.readable(tests.u('extA'), array['cash_accounts', 'cash_entries', 'receipts']), '', 'R-005-23 外部の人は、小口現金とレシートを読めない');
select is(pg_temp.readable(tests.u('extA'), array['request_charges', 'work_charges', 'items', 'contracts', 'contract_services', 'contract_service_staff', 'invoices', 'invoice_lines', 'payments', 'costs']), '',
          'R-005-23 外部の人は、金額の表（案件・作業の金額・品名・契約・請求・入金・費用）を読めない（表がある分）');
select is(pg_temp.readable(tests.u('extA'), array['requests', 'work_assignments', 'work_records', 'report_templates', 'template_items', 'client_error_logs', 'audit_logs', 'job_runs', 'invitations', 'document_counters', 'support_access_grants']), '',
          'R-005-23 外部の人は、案件・担当・実績と位置・ひな形・履歴・処理の記録・招待を読めない（表がある分）');
select isnt(pg_temp.readable(tests.u('memberA'), array['building_profiles', 'rooms', 'clients']), '', 'R-005-23 （確かめの確認）社内の人は同じ表を読めるので、上の「読めない」は空振りではない');
select is(tests.n(tests.u('extA'), format('select 1 from public.building_profiles where building_id = %L', tests.id('buildingA1'))), 0::bigint, 'R-005-23 許された建物のカルテも読めない（鍵の場所・入り方は見えない）');

-- R-005-24：全部の表で、外部の人が読めるのは、型 D の表と、自分の所属・自分の建物・自分の会社だけ
create or replace function pg_temp.external_leaks(p_uid uuid) returns text language plpgsql as $$
declare r record; v text := '';
begin
  for r in select table_name from app.policy_registry
           where split_part(policy_type, '+', 1) not in ('M', 'P') and policy_type not like '%+D'
             and table_name not in ('tenants', 'memberships', 'external_building_access')
           order by 1 loop
    if coalesce(tests.n(p_uid, format('select 1 from public.%I', r.table_name)), 1) > 0 then v := v || r.table_name || ','; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.external_leaks(tests.u('extA')), '', 'R-005-24 外部の人は、型 D 以外の表を（登録された全部の表で）1行も読めない');
select is(pg_temp.external_leaks(tests.u('extB')), '', 'R-005-24 B の外部の人も同じ');

-- 外部に見せる型（D）の表は、読めた行がすべて許された建物のもの（building_id を持つ表）
create or replace function pg_temp.d_outside(p_uid uuid, p_allowed uuid) returns text language plpgsql as $$
declare r record; v text := '';
begin
  for r in select pr.table_name from app.policy_registry pr
           where pr.policy_type like '%+D'
             and exists (select 1 from pg_attribute a where a.attrelid = ('public.' || quote_ident(pr.table_name))::regclass and a.attname = 'building_id' and not a.attisdropped)
           order by 1 loop
    if coalesce(tests.n(p_uid, format('select 1 from public.%I where building_id <> %L', r.table_name, p_allowed)), 1) > 0 then v := v || r.table_name || ','; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.d_outside(tests.u('extA'), tests.id('buildingA1')), '', 'R-005-24 外部に見せる型の表から読める行は、すべて許された建物（A1）のものだけ');
select is(pg_temp.d_outside(tests.u('extB'), tests.id('buildingB1')), '', 'R-005-24 B の外部の人も同じ');
-- 004 の見積と明細も、型 D の全表の確かめに入る（種：建物 A1 の提出・承認・不成立・下書き）
select ok((select count(*) from app.policy_registry where table_name in ('quotes', 'quote_lines') and policy_type like '%+D') = 2, 'R-005-24 見積と明細が、外部に見せる型（D）として登録されている（上の確かめに入る）');
select is(pg_temp.ids(tests.u('extA'), 'select id from public.quotes'), (select string_agg(x, ',' order by x) from unnest(array[tests.id('qA1-sub')::text, tests.id('qA1-app')::text]) x),
          'R-005-24 外部の人が読める見積は、許された建物 A1 の提出・承認の2件だけ（下書き・不成立・別の建物は読めない）');
select is(tests.n(tests.u('extA'), 'select 1 from public.quote_lines'), 2::bigint, 'R-005-24 外部の人が読める明細は、その2件の見積の分だけ');
select is(tests.n(tests.u('extB'), 'select 1 from public.quotes'), 0::bigint, 'R-005-24 B の外部の人は、A の見積を読めない');
select ok((select count(*) from app.policy_registry where policy_type like '%+D') >= 2, 'R-005-24 外部に見せる型の表が登録されている（建物・ファイル。004・009・012 が足す）');
select is(tests.n(tests.u('extA'), 'select 1 from public.memberships'), 1::bigint, 'R-005-24 外部の人が読める所属は、自分の1行だけ');
select is(tests.n(tests.u('extA'), 'select 1 from public.external_building_access'), 1::bigint, 'R-005-24 外部の人が読める「許された建物」は、自分の分だけ');
select is(tests.n(tests.u('extA'), 'select 1 from public.tenants'), 1::bigint, 'R-005-24 外部の人が読める会社は、自分の会社だけ');

select * from finish();
rollback;
