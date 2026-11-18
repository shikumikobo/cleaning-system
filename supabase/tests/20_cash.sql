-- 機能 006：小口現金・レシート（R-006-1〜23・27〜29・33）
begin;
select * from no_plan();
select tests.seed();

-- 呼び出しの短い書き方（追加の列は '列名|値の SQL' で渡す）
create or replace function pg_temp.ent(p_id text, p_acct text, p_holder text, p_dir text, p_amount int, p_date text default '2026-11-10', p_extra text default '') returns text language sql as $$
  select format('insert into public.cash_entries (id, tenant_id, account_id, holder_id, entry_date, direction, amount, purpose%s) values (%L, %L, %L, %L, %L, %L, %s, ''テスト''%s)',
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '|', 1) end,
    tests.id(p_id), tests.t('A'), tests.id(p_acct), tests.id('m:A:' || p_holder), p_date, p_dir, p_amount,
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '|', 2) end)
$$;

-- ===== 小口 =====
select is(tests.cnt(tests.u('memberA'), format('insert into public.cash_accounts (id, tenant_id, holder_id, name) values (%L, %L, %L, ''新しい小口'')',
  tests.id('cashA-new'), tests.t('A'), tests.id('m:A:staffA'))), 1::bigint, 'R-006-1 cash.manage を持つ人（社員）は、小口を作れる');
select is(tests.cnt(tests.u('adminA'), format('insert into public.cash_accounts (id, tenant_id, holder_id, name) values (%L, %L, %L, ''管理の小口'')',
  tests.id('cashA-new2'), tests.t('A'), tests.id('m:A:memberA'))), 1::bigint, 'R-006-1 管理者も小口を作れる');
select is(tests.err(tests.u('adminA'), format('insert into public.cash_accounts (tenant_id, holder_id, name) values (%L, %L, ''別会社の持ち手'')',
  tests.t('A'), tests.id('m:B:staffB'))), '23503', 'R-006-1 持ち手は、その会社の所属だけ（別の会社の所属は外部キーが断る）');
select is(tests.err(tests.u('staffA'), format('insert into public.cash_accounts (tenant_id, holder_id, name) values (%L, %L, ''自分で作る'')',
  tests.t('A'), tests.id('m:A:staffA'))), '42501', 'R-006-2 持ち手の本人（スタッフ）は、小口を作れない');
select is(tests.cnt(tests.u('staffA'), format('update public.cash_accounts set name = ''変える'' where id = %L', tests.id('cashA-staff'))), 0::bigint,
  'R-006-2 持ち手の本人は、小口の名前を直せない');
select is(tests.err(tests.u('extA'), format('insert into public.cash_accounts (tenant_id, holder_id, name) values (%L, %L, ''外部'')',
  tests.t('A'), tests.id('m:A:staffA'))), '42501', 'R-006-2 外部の人は小口を作れない');
select is(tests.cnt(tests.u('memberA'), format('update public.cash_accounts set name = ''名前を直す'' where id = %L', tests.id('cashA-staff'))), 1::bigint,
  'R-006-2 cash.manage を持つ人は小口を直せる');

select is(tests.n(tests.u('staffA'), 'select 1 from public.cash_accounts'), 2::bigint, 'R-006-3 持ち手の本人（スタッフ）は、自分の小口だけ読める（種の1つと、新しく作った1つ）');
select is(tests.n(tests.u('staffA'), format('select 1 from public.cash_accounts where id = %L', tests.id('cashA-member'))), 0::bigint, 'R-006-3 他人の小口は読めない');
select is(tests.n(tests.u('memberA'), format('select 1 from public.cash_accounts where tenant_id = %L', tests.t('A'))) >= 4, true, 'R-006-3 cash.manage を持つ人は、会社の全員の小口を読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.cash_accounts'), 0::bigint, 'R-006-3 外部の人は小口を読めない');

-- 残高（R-006-4）：スタッフA は 入金10000 − 出金500（下書き）= 9500、確認済み以上は 10000
select is(tests.run_as(tests.u('staffA'), format('select balance, confirmed_balance, draft_count from public.cash_account_balances where account_id = %L', tests.id('cashA-staff'))) -> 'rows' -> 0,
  '{"balance": 9500, "confirmed_balance": 10000, "draft_count": 1}'::jsonb, 'R-006-4 残高は入金 − 出金。確認済み以上の残高と、下書きの数も出る');
select is(tests.n(tests.u('staffA'), format('select 1 from public.cash_account_balances where account_id = %L', tests.id('cashA-member'))), 0::bigint, 'R-006-4 残高の view も、見る人の権限で絞られる（他人の小口は出ない）');
select is(tests.n(tests.u('staffB'), format('select 1 from public.cash_account_balances where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-006-4 別の会社の残高は出ない');
select is((select reloptions::text from pg_class where relname = 'cash_account_balances'), '{security_invoker=true}', 'R-006-4 残高の view は security_invoker');

-- 小口の削除（R-006-5）：残高が0でなければ消せない
select is(tests.cnt(tests.u('memberA'), format('update public.cash_accounts set deleted_at = now() where id = %L', tests.id('cashA-staff'))), -1::bigint,
  'R-006-5 残高が0でない小口は消せない');
select is(tests.cnt(tests.u('memberA'), format('update public.cash_accounts set deleted_at = now() where id = %L', tests.id('cashA-new'))), 1::bigint,
  'R-006-5 残高が0の小口は消せる');

-- ===== 出入りの登録 =====
select is(tests.cnt(tests.u('staffA'), pg_temp.ent('e1', 'cashA-staff', 'staffA', 'out', 1200)), 1::bigint, 'R-006-6 持ち手の本人は出金を登録できる');
select is((select status from public.cash_entries where id = tests.id('e1')), 'draft', 'R-006-6 登録は下書きになる');
select is(tests.err(tests.u('staffA'), pg_temp.ent('e2', 'cashA-staff', 'staffA', 'out', 0)), '23514', 'R-006-6 金額は1円以上');
select is(tests.err(tests.u('staffA'), format('insert into public.cash_entries (tenant_id, account_id, holder_id, entry_date, direction, amount, purpose) values (%L, %L, %L, ''2026-11-10'', ''out'', 100, ''  '')',
  tests.t('A'), tests.id('cashA-staff'), tests.id('m:A:staffA'))), '23514', 'R-006-6 用途は空でない');
select is(tests.err(tests.u('staffA'), format('insert into public.cash_entries (tenant_id, account_id, holder_id, entry_date, direction, amount, purpose) values (%L, %L, %L, ''2026-11-10'', ''out'', 100, null)',
  tests.t('A'), tests.id('cashA-staff'), tests.id('m:A:staffA'))), '23502', 'R-006-6 用途が null なら断る');
select is(tests.err(tests.u('staffA'), pg_temp.ent('e2', 'cashA-staff', 'staffA', 'out', 100, null)), '23502', 'R-006-6 日付がないと断る');

select is(tests.err(tests.u('staffA'), pg_temp.ent('e3', 'cashA-staff', 'staffA', 'in', 5000)), '42501', 'R-006-7 持ち手の本人は、入金を登録できない');
select is(tests.cnt(tests.u('memberA'), pg_temp.ent('e3', 'cashA-staff', 'staffA', 'in', 5000)), 1::bigint, 'R-006-7 cash.manage を持つ人は、持ち手に渡した入金を登録できる');
select is((select status from public.cash_entries where id = tests.id('e3')), 'draft', 'R-006-7 入金も下書きで保存される');

select is(tests.err(tests.u('staffA'), pg_temp.ent('e4', 'cashA-member', 'memberA', 'out', 100)), '42501', 'R-006-8 他人の小口に、持ち手でない人は登録できない');
select is(tests.err(tests.u('staffA'), pg_temp.ent('e4', 'cashA-staff', 'memberA', 'out', 100)), '42501', 'R-006-8 他人を持ち手にした出入りは、持ち手でない人は作れない');
select is(tests.err(tests.u('memberA'), pg_temp.ent('e4', 'cashA-staff', 'memberA', 'out', 100)), '23503', 'R-006-8 小口の持ち手と、出入りの持ち手が合わないものは、cash.manage を持つ人も作れない（外部キー）');
select is(tests.err(tests.u('staffB'), format('insert into public.cash_entries (tenant_id, account_id, holder_id, entry_date, direction, amount, purpose) values (%L, %L, %L, ''2026-11-10'', ''out'', 100, ''x'')',
  tests.t('A'), tests.id('cashA-staff'), tests.id('m:A:staffA'))), '42501', 'R-006-8 別の会社の人は、A の小口に登録できない');
select is(tests.err(tests.u('extA'), pg_temp.ent('e5', 'cashA-staff', 'staffA', 'out', 100)), '42501', 'R-006-8 外部の人は登録できない');

-- 端末の ID の二度送り（R-006-9）
select is(tests.cnt(tests.u('staffA'), pg_temp.ent('dev1', 'cashA-staff', 'staffA', 'out', 700) || ' on conflict (id) do nothing'), 1::bigint, 'R-006-9 端末の ID の出入りを1回目に送ると1件入る');
select is(tests.cnt(tests.u('staffA'), pg_temp.ent('dev1', 'cashA-staff', 'staffA', 'out', 999) || ' on conflict (id) do nothing'), 0::bigint, 'R-006-9 同じ ID を二度送ると、二度目は何もしない');
select is((select count(*)::int from public.cash_entries where id = tests.id('dev1')), 1, 'R-006-9 1件だけ');
select is((select amount from public.cash_entries where id = tests.id('dev1')), 700, 'R-006-9 先に届いた中身が残る');

-- 下書きの間の直しと消し（R-006-11）
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set amount = 1300 where id = %L', tests.id('e1'))), 1::bigint, 'R-006-11 下書きの間、持ち手の本人は金額を直せる');
select is(tests.cnt(tests.u('memberA'), format('update public.cash_entries set purpose = ''直した用途'' where id = %L', tests.id('e1'))), 1::bigint, 'R-006-11 下書きの間、cash.manage を持つ人も直せる');
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set deleted_at = now() where id = %L', tests.id('dev1'))), 1::bigint, 'R-006-11 下書きは消せる（論理削除）');
select is(tests.n(tests.u('staffA'), format('select 1 from public.cash_entries where id = %L and deleted_at is null', tests.id('dev1'))), 0::bigint, 'R-006-11 消した行は、普段の読み込みで出ない');
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set direction = ''in'' where id = %L', tests.id('e1'))), -1::bigint, 'R-006-7 持ち手の本人は、直して入金にもできない');

-- 状況は画面から書けない（R-006-13）
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set status = ''confirmed'' where id = %L', tests.id('e1'))), -1::bigint, 'R-006-13 持ち手の本人は status を確認済みにできない');
select is(tests.cnt(tests.u('memberA'), format('update public.cash_entries set status = ''confirmed'', confirmed_at = now() where id = %L', tests.id('e1'))), -1::bigint, 'R-006-13 cash.manage を持つ人も、画面から status を書き換えられない');
select ok(tests.err(tests.u('staffA'), pg_temp.ent('e6', 'cashA-staff', 'staffA', 'out', 100, '2026-11-10', 'status|''confirmed''')) in ('42501', '23514'), 'R-006-13 確認済みで作ることはできない');
select is(tests.err(tests.u('staffA'), pg_temp.ent('e6', 'cashA-staff', 'staffA', 'out', 100, '2026-11-10', 'confirmed_at|now()')), '42501', 'R-006-13 確認の列を埋めて作ることもできない');
select is((select status from public.cash_entries where id = tests.id('e1')), 'draft', 'R-006-13 e1 は下書きのまま');
select is(tests.err(tests.u('memberA'), format('insert into public.cash_entries (tenant_id, account_id, holder_id, entry_date, direction, amount, purpose, status, confirmed_at) values (%L, %L, %L, ''2026-11-10'', ''in'', 100, ''x'', ''confirmed'', now())',
  tests.t('A'), tests.id('cashA-staff'), tests.id('m:A:staffA'))), '42501', 'R-006-13 cash.manage を持つ人も、確認済みで作れない');

-- 読み取り（R-006-14）
select is(tests.n(tests.u('staffA'), 'select 1 from public.cash_entries') >= 3, true, 'R-006-14 持ち手の本人は、自分の出入りを読める');
select is(tests.n(tests.u('staffA'), format('select 1 from public.cash_entries where account_id = %L', tests.id('cashA-member'))), 0::bigint, 'R-006-14 他人の出入りは読めない');
select is(tests.n(tests.u('memberA'), format('select 1 from public.cash_entries where tenant_id = %L', tests.t('A'))) >= 5, true, 'R-006-14 cash.manage を持つ人は、全員の出入りを読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.cash_entries'), 0::bigint, 'R-006-14 外部の人は読めない');

-- ===== 確認（R-006-15〜17・21） =====
select is(tests.err(tests.u('staffA'), format('select public.confirm_cash_entries(array[%L]::uuid[])', tests.id('e1'))), '42501', 'R-006-16 持ち手の本人は確認できない');
select is(tests.err(tests.u('extA'), format('select public.confirm_cash_entries(array[%L]::uuid[])', tests.id('e1'))), '42501', 'R-006-16 外部の人は確認できない');
select is(tests.err(tests.u('staffB'), format('select public.confirm_cash_entries(array[%L]::uuid[])', tests.id('e1'))), '42501', 'R-006-21 別の会社の人は、A の出入りを確認できない');
select is(tests.err(tests.u('adminB'), format('select public.confirm_cash_entries(array[%L]::uuid[])', tests.id('e1'))), '42501', 'R-006-21 別の会社の管理者も確認できない');
select is(tests.err(tests.u('staffA'), 'select public.confirm_cash_entries(null::uuid[])'), '42501', 'R-006-16 権限のない人は、引数が空でも断られる');
select is((select status from public.cash_entries where id = tests.id('e1')), 'draft', 'R-006-21 断られた確認では、状況が変わらない');

select is(tests.run_as(tests.u('memberA'), format('select public.confirm_cash_entries(array[%L, %L]::uuid[]) as n', tests.id('e1'), tests.id('e3'))) -> 'rows' -> 0 ->> 'n', '2', 'R-006-15 cash.manage を持つ人は、下書きをまとめて確認できる（確認した件数が返る）');
select is((select status || '/' || (confirmed_by = tests.u('memberA'))::text || '/' || (confirmed_at is not null)::text from public.cash_entries where id = tests.id('e1')), 'confirmed/true/true', 'R-006-15 確認済みになり、確認した人と時刻が残る');
select is(tests.run_as(tests.u('adminA'), format('select public.confirm_cash_entries(array[%L]::uuid[]) as n', tests.id('e1'))) -> 'rows' -> 0 ->> 'n', '0', 'R-006-17 確認済みをもう一度確認しても、何も変えず、エラーにしない');
select is((select confirmed_by from public.cash_entries where id = tests.id('e1')), tests.u('memberA'), 'R-006-17 二度目で確認者が書き換わらない');
select is(tests.err(tests.u('memberA'), format('select public.confirm_cash_entries(array[%L, %L]::uuid[])', tests.id('entA-out'), tests.id('entB-out'))), '42501', 'R-006-21 別の会社の ID が混じると、何も確認せず断る');
select is(tests.err(tests.u('memberA'), format('select public.confirm_cash_entries(array[%L, %L]::uuid[])', tests.id('entA-out'), tests.id('nothing'))), '22023', 'R-006-21 見つからない ID が混じると、何も確認せず断る');
select is((select status from public.cash_entries where id = tests.id('entA-out')), 'draft', 'R-006-21 一緒に渡した自分の会社の行も、確認されない');
select is((select count(*)::int from public.audit_logs where table_name = 'cash_entries' and row_id = tests.id('e1') and source = 'rpc'), 1, 'R-006-15 確認は変更の履歴に残る（RPC から）');

-- 確認のあとは直せない（R-006-12）
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set amount = 1 where id = %L', tests.id('e1'))), 0::bigint, 'R-006-12 確認済みは、持ち手の本人が直せない');
select is(tests.cnt(tests.u('memberA'), format('update public.cash_entries set amount = 1 where id = %L', tests.id('e1'))), 0::bigint, 'R-006-12 確認済みは、cash.manage を持つ人も直せない');
select is(tests.cnt(tests.u('adminA'), format('update public.cash_entries set deleted_at = now() where id = %L', tests.id('e1'))), 0::bigint, 'R-006-12 確認済みは、管理者も消せない');
select is((select amount from public.cash_entries where id = tests.id('e1')), 1300, 'R-006-12 金額は 1300 のまま');
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set deleted_at = now() where id = %L', tests.id('entA-in'))), 0::bigint, 'R-006-12 種の確認済み（入金）も消せない');

-- ===== 月の締め（R-006-18〜21） =====
-- 10月：種の入金（10/05 確認済み）と出金（10/06 下書き）。下書きが残る月は締められない
select is(tests.err(tests.u('memberA'), format('select public.close_cash_month(%L, date ''2026-10-15'')', tests.t('A'))), '22023', 'R-006-19 下書きが残っている月は締められない');
select is((select count(*)::int from public.cash_entries where tenant_id = tests.t('A') and status = 'closed'), 0, 'R-006-19 断られたあとは、何も締め済みにならない');
select is(tests.err(tests.u('memberA'), format('select public.close_cash_month(%L, date ''2999-01-01'')', tests.t('A'))), '22023', 'R-006-19 まだ来ていない月は締められない');
select is(tests.err(tests.u('staffA'), format('select public.close_cash_month(%L, date ''2026-10-01'')', tests.t('A'))), '42501', 'R-006-16 持ち手の本人は月を締められない');
select is(tests.err(tests.u('adminB'), format('select public.close_cash_month(%L, date ''2026-10-01'')', tests.t('A'))), '42501', 'R-006-21 別の会社の管理者は、A の月を締められない');
-- 下書きをなくして（持ち手が消す）から締める。社員の小口の下書きも同じ月にあるので、小口を指定して締める
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set deleted_at = now() where id = %L', tests.id('entA-out'))), 1::bigint, 'R-006-11 10月の下書きを消す');
select is(tests.run_as(tests.u('memberA'), format('select public.close_cash_month(%L, date ''2026-10-20'', %L) as n', tests.t('A'), tests.id('cashA-staff'))) -> 'rows' -> 0 ->> 'n', '1', 'R-006-18 小口を指定して月を締める（確認済み1件が締め済みになる）');
select is((select status || '/' || (closed_by = tests.u('memberA'))::text from public.cash_entries where id = tests.id('entA-in')), 'closed/true', 'R-006-18 締め済みになり、締めた人が残る');
select is((select status from public.cash_entries where id = tests.id('entA-member')), 'draft', 'R-006-18 小口を指定した締めは、ほかの小口の行に触れない');
select is(tests.run_as(tests.u('memberA'), format('select public.close_cash_month(%L, date ''2026-10-20'', %L) as n', tests.t('A'), tests.id('cashA-staff'))) -> 'rows' -> 0 ->> 'n', '0', 'R-006-18 同じ月をもう一度締めても何も変わらない');
select is(tests.cnt(tests.u('memberA'), format('update public.cash_entries set amount = 1 where id = %L', tests.id('entA-in'))), 0::bigint, 'R-006-12 締め済みは、直せない');

select is(tests.err(tests.u('staffA'), pg_temp.ent('e7', 'cashA-staff', 'staffA', 'out', 100, '2026-10-20')), '42501', 'R-006-20 締めた月の日付では、出入りを新しく作れない');
select is(tests.err(tests.u('memberA'), pg_temp.ent('e7', 'cashA-staff', 'staffA', 'in', 100, '2026-10-31')), '42501', 'R-006-20 cash.manage を持つ人も、締めた月には作れない');
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set entry_date = ''2026-10-10'' where id = %L', tests.id('e1'))), 0::bigint, 'R-006-20 日付を動かして、締めた月に入れることもできない（確認済みなので0行）');
select is(tests.cnt(tests.u('staffA'), pg_temp.ent('e8', 'cashA-staff', 'staffA', 'out', 100, '2026-11-12')), 1::bigint, 'R-006-20 締めていない月には作れる');
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set entry_date = ''2026-10-12'' where id = %L', tests.id('e8'))), -1::bigint, 'R-006-20 下書きの日付を、締めた月へ動かすことはできない');
select is(tests.err(tests.u('memberA'), format('select public.close_cash_month(%L, date ''2026-10-20'')', tests.t('A'))), '22023', 'R-006-19 小口を指定しない締めは、会社の全部の小口を見る（社員の小口の下書きが残っているので断る）');

-- ===== レシート =====
select is(tests.cnt(tests.u('staffA'), format('insert into public.receipts (id, tenant_id, holder_id, storage_path) values (%L, %L, %L, %L)',
  tests.id('r1'), tests.t('A'), tests.id('m:A:staffA'), tests.t('A')::text || '/receipts/' || tests.id('r1')::text || '.jpg')), 1::bigint, 'R-006-22 持ち手の本人はレシートの行を作れる');
select is((select status from public.receipts where id = tests.id('r1')), 'pending', 'R-006-22 読み取り待ちで作られる');
select is(tests.err(tests.u('staffA'), format('insert into public.receipts (id, tenant_id, holder_id, storage_path) values (%L, %L, %L, %L)',
  tests.id('r2'), tests.t('A'), tests.id('m:A:staffA'), tests.t('B')::text || '/receipts/' || tests.id('r2')::text || '.jpg')), '23514', 'R-006-23 別の会社のフォルダのパスでは作れない');
select is(tests.err(tests.u('staffA'), format('insert into public.receipts (id, tenant_id, holder_id, storage_path) values (%L, %L, %L, %L)',
  tests.id('r2'), tests.t('A'), tests.id('m:A:staffA'), tests.t('A')::text || '/receipts/' || tests.id('r1')::text || '.jpg')), '23514', 'R-006-23 別のレシートの ID のパスでは作れない');
select is(tests.err(tests.u('staffA'), format('insert into public.receipts (id, tenant_id, holder_id, storage_path) values (%L, %L, %L, %L)',
  tests.id('r2'), tests.t('A'), tests.id('m:A:staffA'), tests.t('A')::text || '/photos/' || tests.id('r2')::text || '.jpg')), '23514', 'R-006-23 receipts のフォルダ以外では作れない');
select is(tests.err(tests.u('staffA'), format('insert into public.receipts (id, tenant_id, holder_id, storage_path) values (%L, %L, %L, %L)',
  tests.id('r2'), tests.t('A'), tests.id('m:A:memberA'), tests.t('A')::text || '/receipts/' || tests.id('r2')::text || '.jpg')), '42501', 'R-006-22 他人の持ち主のレシートは作れない');
select is(tests.err(tests.u('extA'), format('insert into public.receipts (id, tenant_id, holder_id, storage_path) values (%L, %L, %L, %L)',
  tests.id('r3'), tests.t('A'), tests.id('m:A:staffA'), tests.t('A')::text || '/receipts/' || tests.id('r3')::text || '.jpg')), '42501', 'R-006-22 外部の人はレシートを作れない');

-- 読み取りの結果（持ち主の本人の鍵で書く。Edge Function と同じ）
select is(tests.cnt(tests.u('staffA'), format('update public.receipts set read_amount = 1980, read_date = ''2026-11-10'', status = ''read'' where id = %L', tests.id('r1'))), 1::bigint, 'R-006-24 読み取った金額と日付を、レシートに保存できる');
select is((select read_amount::text || '/' || read_date::text || '/' || status from public.receipts where id = tests.id('r1')), '1980/2026-11-10/read', 'R-006-24 読み取り済みの値が残る');
select is(tests.err(tests.u('staffA'), format('update public.receipts set status = ''broken'' where id = %L', tests.id('r1'))), '23514', 'R-006-24 状況は pending・read・failed・manual だけ');
select is(tests.cnt(tests.u('staffA'), format('update public.receipts set status = ''failed'' where id = %L', tests.id('rcpA-staff'))), 1::bigint, 'R-006-24 読み取れなかったときは「読み取れず」にできる');
-- 読み取りは候補：出入りの金額を変えない（R-006-25）
select is((select amount from public.cash_entries where id = tests.id('e8')), 100, 'R-006-25 読み取った金額が、出入りの金額に勝手に入らない');

-- 出入りに付けるレシート（R-006-29）
select is(tests.cnt(tests.u('staffA'), format('update public.cash_entries set receipt_id = %L where id = %L', tests.id('r1'), tests.id('e8'))), 1::bigint, 'R-006-29 同じ持ち手のレシートは付けられる');
select is(tests.err(tests.u('staffA'), format('update public.cash_entries set receipt_id = %L where id = %L', tests.id('rcpA-member'), tests.id('e8'))), '23503', 'R-006-29 別の持ち手のレシートは付けられない');
select is(tests.err(tests.u('staffA'), format('update public.cash_entries set receipt_id = %L where id = %L', tests.id('rcpB-staff'), tests.id('e8'))), '23503', 'R-006-29 別の会社のレシートは付けられない');

-- 確認済みの出入りから使われているレシートは、直せず消せない（R-006-27）
select is(tests.cnt(tests.u('staffA'), format('update public.receipts set read_amount = 5 where id = %L', tests.id('r1'))), 1::bigint, 'R-006-27 下書きの出入りから使われているレシートは、まだ直せる');
select is(tests.run_as(tests.u('memberA'), format('select public.confirm_cash_entries(array[%L]::uuid[]) as n', tests.id('e8'))) -> 'rows' -> 0 ->> 'n', '1', 'R-006-15 e8（レシート付き）を確認する');
select is(tests.cnt(tests.u('staffA'), format('update public.receipts set read_amount = 5 where id = %L', tests.id('r1'))), 0::bigint, 'R-006-27 確認済みの出入りから使われているレシートは、持ち手の本人が直せない');
select is(tests.cnt(tests.u('staffA'), format('update public.receipts set deleted_at = now() where id = %L', tests.id('r1'))), 0::bigint, 'R-006-27 消すこともできない');
select is(tests.cnt(tests.u('memberA'), format('update public.receipts set read_amount = 5 where id = %L', tests.id('r1'))), 0::bigint, 'R-006-27 cash.manage を持つ人も直せない');
select is(tests.cnt(tests.u('staffA'), format('update public.receipts set deleted_at = now() where id = %L', tests.id('rcpA-staff'))), 1::bigint, 'R-006-27 使われていない（下書きの）レシートは消せる');

-- 読み取り（R-006-28）
select is(tests.n(tests.u('staffA'), format('select 1 from public.receipts where id = %L', tests.id('rcpA-member'))), 0::bigint, 'R-006-28 他人のレシートは読めない');
select is(tests.n(tests.u('staffA'), format('select 1 from public.receipts where id = %L', tests.id('r1'))), 1::bigint, 'R-006-28 自分のレシートは読める');
select is(tests.n(tests.u('memberA'), format('select 1 from public.receipts where tenant_id = %L', tests.t('A'))) >= 3, true, 'R-006-28 cash.manage を持つ人は、全員のレシートを読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.receipts'), 0::bigint, 'R-006-28 外部の人は読めない');

-- ===== 会社をまたがない守り（R-006-33）：006 の3つの表を明示で確かめる（全表の確かめにも自動で入る） =====
select is(tests.n(tests.u('adminB'), format('select 1 from public.cash_accounts where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-006-33 別の会社の小口は読めない');
select is(tests.n(tests.u('adminB'), format('select 1 from public.cash_entries where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-006-33 別の会社の出入りは読めない');
select is(tests.n(tests.u('adminB'), format('select 1 from public.receipts where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-006-33 別の会社のレシートは読めない');
select is(tests.cnt(tests.u('adminB'), format('update public.cash_entries set purpose = ''x'' where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-006-33 別の会社の出入りは直せない');
select is(tests.cnt(tests.u('adminB'), format('delete from public.cash_entries where tenant_id = %L', tests.t('A'))), -1::bigint, 'R-006-33 出入りは、delete の権限そのものがない');
select is(tests.run_as_anon('select 1 from public.cash_entries') ->> 'error', '42501', 'R-006-33 ログインしていない人は読めない');
select is(tests.err(tests.u('adminB'), format('insert into public.cash_entries (tenant_id, account_id, holder_id, entry_date, direction, amount, purpose) values (%L, %L, %L, ''2026-11-10'', ''in'', 1, ''x'')',
  tests.t('B'), tests.id('cashA-staff'), tests.id('m:A:staffA'))), '23503', 'R-006-33 別の会社の小口を指す出入りは、外部キーが断る');
select is((select policy_type from app.policy_registry where table_name = 'cash_entries'), 'C1', 'R-006-33 出入りは型 C1 として登録されている');
select is((select policy_type from app.policy_registry where table_name = 'cash_accounts'), 'C1', 'R-006-33 小口は型 C1 として登録されている');
select is((select policy_type from app.policy_registry where table_name = 'receipts'), 'C1', 'R-006-33 レシートは型 C1 として登録されている');
select is(tests.n(tests.u('operator'), format('select 1 from public.cash_entries where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-006-33 運営は、許可がなければ出入りを読めない');

-- 持ち手の表示名（R-006-37）
select is(tests.run_as(tests.u('memberA'), format('select display_name from public.cash_holder_names(%L) where membership_id = %L', tests.t('A'), tests.id('m:A:staffA'))) -> 'rows' -> 0 ->> 'display_name', 'staffA',
  'R-006-37 cash.manage を持つ人は、持ち手の表示名を読める');
select is(tests.n(tests.u('memberA'), format('select 1 from public.cash_holder_names(%L) where membership_id = %L', tests.t('A'), tests.id('m:A:extA'))), 0::bigint, 'R-006-37 外部の人の名前は出さない');
select is(tests.err(tests.u('staffA'), format('select * from public.cash_holder_names(%L)', tests.t('A'))), '42501', 'R-006-37 cash.manage を持たない人には返さない');
select is(tests.err(tests.u('adminB'), format('select * from public.cash_holder_names(%L)', tests.t('A'))), '42501', 'R-006-37 別の会社の管理者にも返さない');

-- 建物への外部キー（波 1 の取り込み。20261117030000）：(tenant_id, id) の組で、自分の会社の建物だけを指せる
select is(tests.cnt(tests.u('staffA'), pg_temp.ent('eb1', 'cashA-staff', 'staffA', 'out', 300, '2026-11-10', 'building_id|' || quote_literal(tests.id('buildingA1')::text))), 1::bigint,
  '出入りに、自分の会社の建物を付けられる');
select is(tests.err(tests.u('staffA'), pg_temp.ent('eb2', 'cashA-staff', 'staffA', 'out', 300, '2026-11-10', 'building_id|' || quote_literal(tests.id('buildingB1')::text))), '23503',
  '出入りに、別の会社の建物は付けられない（組の外部キーが断る）');
select is(tests.err(tests.u('staffA'), pg_temp.ent('eb3', 'cashA-staff', 'staffA', 'out', 300, '2026-11-10', 'building_id|' || quote_literal('00000000-0000-4000-8000-0000000000ff'))), '23503',
  '出入りに、存在しない建物は付けられない');
select is(tests.cnt(tests.u('staffA'), pg_temp.ent('eb4', 'cashA-staff', 'staffA', 'out', 300)), 1::bigint, '建物は付けなくてもよい（building_id は空でよい）');

select * from finish();
rollback;
