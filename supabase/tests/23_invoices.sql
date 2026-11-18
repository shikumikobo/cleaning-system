-- 機能 011：請求（R-011-1〜31）。R-011-32〜36 は画面の部品（Vitest）と画面の流れ（Playwright）。
-- R-011-32 の DB 側：下の「合計の突き合わせ」と、apps/web/src/lib/invoices/ の invoice_totals.json は、同じ数字。
begin;
select * from no_plan();
select tests.seed();

-- ---- 道具 ----
create or replace function pg_temp.call(p_uid uuid, p_fn text, p_args text) returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.callerr(p_uid uuid, p_fn text, p_args text) returns text language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) ->> 'error'
$$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Tokyo')::date $$;
create or replace function pg_temp.yr() returns int language sql as $$ select extract(year from (now() at time zone 'Asia/Tokyo'))::int $$;
-- 下書きを作る（会社 A の社員）
create or replace function pg_temp.drafts(p_period date, p_client text default null) returns jsonb language sql as $$
  select pg_temp.call(tests.u('memberA'), 'create_invoice_drafts',
    format('%L, %L, %s', tests.t('A'), p_period, case when p_client is null then 'null' else quote_literal(tests.id(p_client)::text) end))
$$;
create or replace function pg_temp.inv(p_client text, p_period date) returns uuid language sql as $$
  select id from public.invoices where client_id = tests.id(p_client) and period = p_period and deleted_at is null and status <> 'cancelled'
$$;
create or replace function pg_temp.nlines(p_inv uuid) returns int language sql as $$
  select count(*)::int from public.invoice_lines where invoice_id = p_inv and deleted_at is null
$$;
create or replace function pg_temp.sumlines(p_inv uuid) returns bigint language sql as $$
  select coalesce(sum(amount), 0)::bigint from public.invoice_lines where invoice_id = p_inv and deleted_at is null
$$;
create or replace function pg_temp.i(p text) returns text language sql as $$ select quote_literal(tests.id(p)::text) $$;
-- 請求書の状況
create or replace function pg_temp.st(p_id uuid) returns text language sql as $$ select status from public.invoices where id = p_id $$;
-- 管理者の権限で、請求書と明細1つを用意する（RLS を通らない）。税率 0・取引先はその都度作る
create or replace function pg_temp.mkinv(p_name text, p_status text, p_amount bigint, p_sent boolean default false) returns uuid language plpgsql as $$
begin
  insert into public.clients (id, tenant_id, kind, name) values (tests.id('c-' || p_name), tests.t('A'), 'management_company', 'テスト請求先-' || p_name);
  insert into public.invoices (id, tenant_id, client_id, period, number, issue_date, due_date, tax_rate, subtotal, tax, total, status, issued_at, sent_at)
  values (tests.id('inv-' || p_name), tests.t('A'), tests.id('c-' || p_name), date '2050-01-01',
          case when p_status = 'draft' then null else 'T-' || p_name end,
          case when p_status = 'draft' then null else date '2050-02-01' end, case when p_status = 'draft' then null else date '2050-02-28' end,
          0, case when p_status = 'draft' then 0 else p_amount end, 0, case when p_status = 'draft' then 0 else p_amount end, p_status,
          case when p_status = 'draft' then null else now() end, case when p_sent then now() end);
  insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, name, qty, unit, unit_price, sort)
  values (tests.t('A'), tests.id('inv-' || p_name), tests.id('k-' || p_name), date '2050-01-01', '明細-' || p_name, 1, '式', p_amount, 1);
  return tests.id('inv-' || p_name);
end $$;

-- ---- 下書きの元になる契約・作業・案件（会社 A・取引先 X1・X2。請求月は 2027-03）----
insert into public.clients (id, tenant_id, kind, name) values
  (tests.id('cX1'), tests.t('A'), 'management_company', 'テスト請求先X1'), (tests.id('cX2'), tests.t('A'), 'management_company', 'テスト請求先X2'),
  (tests.id('cY1'), tests.t('B'), 'management_company', 'テスト請求先Y1');
insert into public.buildings (id, tenant_id, client_id, name, address) values
  (tests.id('bX1'), tests.t('A'), tests.id('cX1'), 'テスト請求ビルX1', '東京都X1'), (tests.id('bX2'), tests.t('A'), tests.id('cX2'), 'テスト請求ビルX2', '東京都X2'),
  (tests.id('bY1'), tests.t('B'), tests.id('cY1'), 'テスト請求ビルY1', '大阪府Y1');
insert into public.contracts (id, tenant_id, client_id, building_id, source, kind, start_date, end_date, status) values
  (tests.id('ctX1'), tests.t('A'), tests.id('cX1'), tests.id('bX1'), 'import', 'recurring', date '2027-01-01', null, 'active'),
  (tests.id('ctX2'), tests.t('A'), tests.id('cX2'), tests.id('bX2'), 'import', 'recurring', date '2026-06-01', date '2027-02-15', 'ended'),
  (tests.id('ctY1'), tests.t('B'), tests.id('cY1'), tests.id('bY1'), 'import', 'recurring', date '2027-01-01', null, 'active');
insert into public.contract_services (id, tenant_id, contract_id, service_key, service_kind, name, amount, billing, recurrence, valid_from, valid_to) values
  (tests.id('sM1'), tests.t('A'), tests.id('ctX1'), tests.id('kM1'), 'base', '定期清掃', 30000, 'monthly', 'FREQ=WEEKLY;BYDAY=MO', date '2027-01-01', null),
  -- 月の途中（3/15）で金額が変わる：3/1 に有効な古い行（10000）で請求する
  (tests.id('sM2a'), tests.t('A'), tests.id('ctX1'), tests.id('kM2'), 'option', '機器の保守', 10000, 'monthly', 'FREQ=MONTHLY', date '2027-01-01', date '2027-03-14'),
  (tests.id('sM2b'), tests.t('A'), tests.id('ctX1'), tests.id('kM2'), 'option', '機器の保守', 12000, 'monthly', 'FREQ=MONTHLY', date '2027-03-15', null),
  -- 3/10 から始まる：その月で最初に始まる行（5000）で請求する
  (tests.id('sM4'), tests.t('A'), tests.id('ctX1'), tests.id('kM4'), 'option', '新しい点検', 5000, 'monthly', 'FREQ=MONTHLY', date '2027-03-10', null),
  -- 2月末で閉じた：3月には載せない
  (tests.id('sM5'), tests.t('A'), tests.id('ctX1'), tests.id('kM5'), 'option', '終わった点検', 7000, 'monthly', 'FREQ=MONTHLY', date '2027-01-01', date '2027-02-28'),
  -- 金額 0：載せない
  (tests.id('sM6'), tests.t('A'), tests.id('ctX1'), tests.id('kM6'), 'option', '無料の点検', 0, 'monthly', 'FREQ=MONTHLY', date '2027-01-01', null),
  (tests.id('sV1'), tests.t('A'), tests.id('ctX1'), tests.id('kV1'), 'option', '窓清掃', 12000, 'per_visit', 'FREQ=MONTHLY;INTERVAL=3', date '2027-01-01', null),
  -- 契約が2月15日に終わった取引先 X2：月額は載せない
  (tests.id('sX2'), tests.t('A'), tests.id('ctX2'), tests.id('kX2'), 'base', '定期清掃X2', 20000, 'monthly', 'FREQ=MONTHLY', date '2026-06-01', date '2027-02-15'),
  (tests.id('sY1'), tests.t('B'), tests.id('ctY1'), tests.id('kY1'), 'base', '定期清掃Y1', 25000, 'monthly', 'FREQ=MONTHLY', date '2027-01-01', null);
insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status) values
  (tests.id('wd1'), tests.t('A'), tests.id('bX1'), tests.id('sV1'), tests.id('kV1'), '窓清掃', date '2027-03-05', 'done'),
  (tests.id('wd2'), tests.t('A'), tests.id('bX1'), tests.id('sV1'), tests.id('kV1'), '窓清掃', date '2027-03-12', 'scheduled'),
  (tests.id('wd3'), tests.t('A'), tests.id('bX1'), tests.id('sV1'), tests.id('kV1'), '窓清掃', date '2027-02-20', 'done'),
  (tests.id('wd4'), tests.t('A'), tests.id('bX1'), tests.id('sV1'), tests.id('kV1'), '窓清掃', date '2027-03-20', 'done'),
  (tests.id('wd5'), tests.t('A'), tests.id('bX1'), tests.id('sV1'), tests.id('kV1'), '窓清掃', date '2027-03-22', 'cancelled'),
  (tests.id('wd6'), tests.t('A'), tests.id('bX1'), tests.id('sV1'), tests.id('kV1'), '窓清掃', date '2027-03-25', 'done'),
  (tests.id('wd8'), tests.t('A'), tests.id('bX1'), tests.id('sV1'), tests.id('kV1'), '窓清掃', date '2027-03-27', 'skipped');
insert into public.work_charges (tenant_id, work_id, amount) values
  (tests.t('A'), tests.id('wd1'), 12000), (tests.t('A'), tests.id('wd2'), 12000), (tests.t('A'), tests.id('wd3'), 12000),
  (tests.t('A'), tests.id('wd4'), 0), (tests.t('A'), tests.id('wd5'), 12000), (tests.t('A'), tests.id('wd6'), 7000), (tests.t('A'), tests.id('wd8'), 12000);
-- 案件：完了・請求する（8000）／請求しない／未完了／4月に作った（3月の請求には載せない）／金額 0／取引先 X2 の完了（4000）
insert into public.requests (id, tenant_id, client_id, building_id, title, status, created_at) values
  (tests.id('rq1'), tests.t('A'), tests.id('cX1'), tests.id('bX1'), 'ごみ置き場の清掃', 'done', timestamptz '2027-02-10 10:00+09'),
  (tests.id('rq2'), tests.t('A'), tests.id('cX1'), tests.id('bX1'), '請求しない案件', 'done', timestamptz '2027-02-10 10:00+09'),
  (tests.id('rq3'), tests.t('A'), tests.id('cX1'), tests.id('bX1'), '未完了の案件', 'new', timestamptz '2027-02-10 10:00+09'),
  (tests.id('rq4'), tests.t('A'), tests.id('cX1'), tests.id('bX1'), '4月の案件', 'done', timestamptz '2027-04-10 10:00+09'),
  (tests.id('rq5'), tests.t('A'), tests.id('cX1'), tests.id('bX1'), '金額 0 の案件', 'done', timestamptz '2027-02-10 10:00+09'),
  (tests.id('rq6'), tests.t('A'), tests.id('cX2'), tests.id('bX2'), 'X2 の清掃', 'done', timestamptz '2027-01-05 10:00+09');
insert into public.request_charges (tenant_id, request_id, amount, billable) values
  (tests.t('A'), tests.id('rq1'), 8000, true), (tests.t('A'), tests.id('rq2'), 9000, false), (tests.t('A'), tests.id('rq3'), 9000, true),
  (tests.t('A'), tests.id('rq4'), 9000, true), (tests.t('A'), tests.id('rq5'), 0, true), (tests.t('A'), tests.id('rq6'), 4000, true);

-- ===== R-011-1〜4 下書きを作る =====
create temp table _d1 on commit drop as select pg_temp.drafts(date '2027-03-01') as r;
select is((select r ->> 'ok' from _d1), 'true', 'R-011-1 社員は月を選んで、請求書の下書きを作れる');
select is((select count(*)::int from public.invoices where period = date '2027-03-01' and tenant_id = tests.t('A') and status = 'draft'), (select (r ->> 'created')::int from _d1), 'R-011-1 作った下書きの数が戻りと合う（すべて下書き）');
select is(pg_temp.st(pg_temp.inv('cX1', date '2027-03-01')), 'draft', 'R-011-1 状況は下書き');
select is((select count(*)::int from public.invoice_lines where invoice_id = pg_temp.inv('cX1', date '2027-03-01') and service_key = tests.id('kM1') and service_month = date '2027-03-01' and unit_price = 30000 and qty = 1 and name = 'テスト請求ビルX1 定期清掃'), 1,
  'R-011-1 契約の毎月請求の中身が、建物の名前つきで明細になる（元は契約の中身の鍵と月）');
select is((select count(*)::int from public.invoice_lines where invoice_id = pg_temp.inv('cX1', date '2027-03-01') and service_key in (tests.id('kM6'), tests.id('kV1'))), 0, 'R-011-1 金額 0 の中身と、行った回ごとの中身は、月額として載せない');
select is((select count(*)::int from public.invoice_lines where invoice_id = pg_temp.inv('cX1', date '2027-03-01') and work_id in (tests.id('wd1'), tests.id('wd6'))), 2, 'R-011-2 その月に完了した作業の金額が明細になる');
select is((select count(*)::int from public.invoice_lines where work_id in (tests.id('wd2'), tests.id('wd3'), tests.id('wd4'), tests.id('wd5'), tests.id('wd8'))), 0,
  'R-011-2 予定のまま・ほかの月・金額 0・取り消した・行わなかった作業は載せない');
select is((select count(*)::int from public.invoice_lines where invoice_id = pg_temp.inv('cX1', date '2027-03-01') and request_id = tests.id('rq1') and unit_price = 8000), 1, 'R-011-3 完了した案件の金額が明細になる');
select is((select count(*)::int from public.invoice_lines where request_id in (tests.id('rq2'), tests.id('rq3'), tests.id('rq4'), tests.id('rq5'))), 0,
  'R-011-3 請求しない・未完了・月の末日より後に作った・金額 0 の案件は載せない');
select is(pg_temp.nlines(pg_temp.inv('cX1', date '2027-03-01')), 6, 'R-011-4 取引先 X1 の請求書は1枚で、明細は月額3・作業2・案件1');
select is(pg_temp.sumlines(pg_temp.inv('cX1', date '2027-03-01')), 72000::bigint, 'R-011-4 明細の合計（30000＋10000＋5000＋12000＋7000＋8000）');
select is(pg_temp.nlines(pg_temp.inv('cX2', date '2027-03-01')), 1, 'R-011-4 別の取引先 X2 は別の請求書（案件だけ。終わった契約の月額は載せない）');
select is((select count(*)::int from public.invoice_lines l join public.invoices i on i.id = l.invoice_id where i.client_id = tests.id('clientA10') and i.period = date '2027-03-01' and l.deleted_at is null), 2,
  'R-011-4 同じ取引先の2つの建物の月額は、1枚の請求書にまとまる');
select is((select count(distinct invoice_id)::int from public.invoice_lines l join public.invoices i on i.id = l.invoice_id where i.client_id = tests.id('clientA10') and i.period = date '2027-03-01'), 1, 'R-011-4 その請求書は1枚');
select is((select count(*)::int from public.invoices where tenant_id = tests.t('A') and client_id = tests.id('cY1')), 0, 'R-011-1 別の会社の契約は、会社 A の下書きに載らない');

-- ===== R-011-5 二重に載らない =====
create temp table _n1 on commit drop as select count(*)::int as n from public.invoice_lines where deleted_at is null;
create temp table _d2 on commit drop as select pg_temp.drafts(date '2027-03-01') as r;
select is((select (r ->> 'created')::int || '/' || (r ->> 'added')::int from _d2), '0/0', 'R-011-5 同じ月を二度呼んでも、請求書も明細も増えない');
select is((select count(*)::int from public.invoice_lines where deleted_at is null), (select n from _n1), 'R-011-5 明細の数は変わらない');
select is(pg_temp.try(format($q$insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, name) values (%L, %L, %L, date '2027-03-01', 'x')$q$, tests.t('A'), pg_temp.inv('cX2', date '2027-03-01'), tests.id('kM1'))), '23505', 'R-011-5 同じ契約の中身の同じ月は、DB でも二重にできない');
select is(pg_temp.try(format($q$insert into public.invoice_lines (tenant_id, invoice_id, work_id, name) values (%L, %L, %L, 'x')$q$, tests.t('A'), pg_temp.inv('cX2', date '2027-03-01'), tests.id('wd1'))), '23505', 'R-011-5 同じ作業は、DB でも二重にできない');
select is(pg_temp.try(format($q$insert into public.invoice_lines (tenant_id, invoice_id, request_id, name) values (%L, %L, %L, 'x')$q$, tests.t('A'), pg_temp.inv('cX2', date '2027-03-01'), tests.id('rq1'))), '23505', 'R-011-5 同じ案件は、DB でも二重にできない');
select is(pg_temp.try(format($q$insert into public.invoices (tenant_id, client_id, period) values (%L, %L, date '2027-03-01')$q$, tests.t('A'), tests.id('cX1'))), '23505', 'R-011-4 取引先ごと・月ごとの請求書（取消を除く）は DB でも1枚');

-- ===== R-011-6 月の途中の変更・終わった中身 =====
select is((select unit_price from public.invoice_lines where invoice_id = pg_temp.inv('cX1', date '2027-03-01') and service_key = tests.id('kM2')), 10000::bigint, 'R-011-6 月の途中で金額が変わっても日割りにせず、月の1日に有効な中身の金額');
select is((select unit_price from public.invoice_lines where invoice_id = pg_temp.inv('cX1', date '2027-03-01') and service_key = tests.id('kM4')), 5000::bigint, 'R-011-6 月の途中から始まる中身は、その月で最初に始まる中身の金額');
select is((select count(*)::int from public.invoice_lines where invoice_id = pg_temp.inv('cX1', date '2027-03-01') and service_key = tests.id('kM5')), 0, 'R-011-6 月の前に閉じた中身は載せない');
select is((select count(*)::int from public.invoice_lines where service_key = tests.id('kX2')), 0, 'R-011-6 月の前に終わった契約は載せない');
select is((select count(*)::int from public.invoice_lines where service_key = tests.id('kM2')), 1, 'R-011-6 同じ鍵で2つある行も、1行だけ');

-- ===== R-011-9 月・会社・権限 =====
select is(pg_temp.call(tests.u('memberA'), 'create_invoice_drafts', format('%L, null, null', tests.t('A'))) ->> 'reason', 'period_required', 'R-011-9 月が空ならば断る');
select is(pg_temp.call(tests.u('memberA'), 'create_invoice_drafts', format('%L, %L, null', tests.t('A'), date '2027-03-17')) ->> 'added', '0', 'R-011-9 月の途中の日付は、その月の1日に直す（同じ月なので増えない）');
select is(pg_temp.callerr(tests.u('memberA'), 'create_invoice_drafts', format('%L, %L, %L', tests.t('A'), date '2027-03-01', tests.id('cY1'))), '42501', 'R-011-9 別の会社の取引先を指すと、権限がないのと同じ 42501');
select is(pg_temp.callerr(tests.u('memberA'), 'create_invoice_drafts', format('%L, %L, null', tests.t('B'), date '2027-03-01')), '42501', 'R-011-9 別の会社を指すと 42501');
select is(pg_temp.drafts(date '2020-06-01') ->> 'created', '0', 'R-011-9 載せるものがなければ、何も作らず 0 件');

-- ===== R-011-7 発行したあとは足さない・下書きには足す =====
-- 発行の前に、X1 の下書きの期日を直接直す（R-011-10）。そのあと発行（R-011-14）
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoices set due_date = %L, note = '振込は月末まで', tax_rate = 0.1 where id = %L$q$, date '2027-04-20', pg_temp.inv('cX1', date '2027-03-01'))), 1::bigint,
  'R-011-10 社員は下書きの期日・税率・備考を直せる');
create temp table _x1 on commit drop as select pg_temp.inv('cX1', date '2027-03-01') as id;
create temp table _iss on commit drop as select pg_temp.call(tests.u('memberA'), 'issue_invoice', format('%L', (select id from _x1))) as r;
select is((select r ->> 'ok' from _iss), 'true', 'R-011-14 社員は下書きを発行できる');
select is((select status || '/' || number || '/' || issue_date::text || '/' || due_date::text || '/' || subtotal::text || '/' || tax::text || '/' || total::text from public.invoices where id = (select id from _x1)),
  'issued/I-' || pg_temp.yr() || '-0001/' || pg_temp.today()::text || '/2027-04-20/72000/7200/79200', 'R-011-14 状況・番号・発行日（日本時間の今日）・期日・小計・税・合計が入る');
select is((select issued_at is not null from public.invoices where id = (select id from _x1)), true, 'R-011-14 発行した日時が入る');
insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status) values
  (tests.id('wd7'), tests.t('A'), tests.id('bX1'), tests.id('sV1'), tests.id('kV1'), '窓清掃', date '2027-03-28', 'done');
insert into public.work_charges (tenant_id, work_id, amount) values (tests.t('A'), tests.id('wd7'), 3000);
insert into public.requests (id, tenant_id, client_id, building_id, title, status, created_at) values (tests.id('rq7'), tests.t('A'), tests.id('cX2'), tests.id('bX2'), 'X2 の追加', 'done', timestamptz '2027-02-12 10:00+09');
insert into public.request_charges (tenant_id, request_id, amount, billable) values (tests.t('A'), tests.id('rq7'), 2000, true);
create temp table _d3 on commit drop as select pg_temp.drafts(date '2027-03-01') as r;
select is((select (r ->> 'locked')::int from _d3), 1, 'R-011-7 発行した請求書のある取引先は、足さずに飛ばし、数えて返す');
select is((select count(*)::int from public.invoice_lines where work_id = tests.id('wd7')), 0, 'R-011-7 発行した請求書に、新しい元は足さない');
select is(pg_temp.nlines(pg_temp.inv('cX2', date '2027-03-01')), 2, 'R-011-7 下書きの請求書には、新しく出てきた元だけを足す（X2：案件が2つに）');
select is((select (r ->> 'created')::int from _d3), 0, 'R-011-7 下書きがある取引先で、請求書を増やさない');

-- ===== R-011-14〜17 発行 =====
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', format('%L', (select id from _x1))) ->> 'already', 'true', 'R-011-17 もう一度発行しても、何もしない（already）');
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', format('%L', (select id from _x1))) ->> 'number', 'I-' || pg_temp.yr() || '-0001', 'R-011-17 前の番号を返す（二重に番号を振らない）');
select is((select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'invoice' and year = pg_temp.yr()), 1, 'R-011-16 番号は 1 から。二度目の呼び出しでは進まない');
select is((select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'quote' and year = 2026), 3, 'R-011-16 見積の番号を進めない');
select pg_temp.mkinv('empty', 'draft', 0);
delete from public.invoice_lines where invoice_id = tests.id('inv-empty');
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', pg_temp.i('inv-empty')) ->> 'reason', 'no_lines', 'R-011-17 明細が1つもない請求書は発行させない');
select pg_temp.mkinv('zero', 'draft', 0);
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', pg_temp.i('inv-zero')) ->> 'reason', 'zero_total', 'R-011-17 合計が 0 の請求書は発行させない');
select is((select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'invoice' and year = pg_temp.yr()), 1, 'R-011-16 断った発行では、番号が進まない（欠番を作らない）');
select pg_temp.mkinv('due', 'draft', 1000);
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoices set due_date = %L where id = %L$q$, date '2000-01-01', tests.id('inv-due'))), 1::bigint, '（準備）期日を昔に直す');
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', format('%L, %L', tests.id('inv-due'), pg_temp.today())) ->> 'reason', 'due_before_issue', 'R-011-17 期日が発行日より前ならば発行させない');
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', pg_temp.i('iA-cancel')) ->> 'reason', 'not_draft', 'R-011-17 取消の請求書は発行させない');
-- 期日の初めの値：空ならば請求月の翌月末（発行日がそれより後なら、発行日の30日後）
select pg_temp.mkinv('due2', 'draft', 1000);
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoices set due_date = null where id = %L$q$, tests.id('inv-due2'))), 1::bigint, '（準備）期日を空にする');
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', format('%L, %L', tests.id('inv-due2'), date '2050-02-01')) ->> 'due_date', '2050-02-28', 'R-011-14 期日が空ならば、請求月（2050-01）の翌月末');
select pg_temp.mkinv('due3', 'draft', 1000);
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', format('%L, %L', tests.id('inv-due3'), date '2050-04-10')) ->> 'due_date', '2050-05-10', 'R-011-14 翌月末が発行日より前ならば、発行日の30日後');
select is((select number from public.invoices where id = tests.id('inv-due2')), 'I-2050-0001', 'R-011-16 番号の年は発行日の年（会社ごと・年ごとに 1 から）');
select is((select number from public.invoices where id = tests.id('inv-due3')), 'I-2050-0002', 'R-011-16 同じ年は通し番号');

-- ===== R-011-15 税は請求書1枚に1回 =====
-- 合計の突き合わせ（R-011-32）：apps/web/src/lib/invoices/invoice_totals.json と同じ数字
create or replace function pg_temp.mkcase(p_n int, p_rate numeric, p_lines text) returns void language plpgsql as $$
declare e text[]; v_i int := 0; l text;
begin
  insert into public.clients (id, tenant_id, kind, name) values (tests.id('cc' || p_n), tests.t('A'), 'owner', 'テスト計算先' || p_n);
  insert into public.invoices (id, tenant_id, client_id, period, tax_rate) values (tests.id('ic' || p_n), tests.t('A'), tests.id('cc' || p_n), date '2040-01-01', p_rate);
  foreach l in array string_to_array(p_lines, ';') loop
    v_i := v_i + 1;
    insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, name, qty, unit_price, sort)
    values (tests.t('A'), tests.id('ic' || p_n), tests.id('kc' || p_n || '-' || v_i), date '2040-01-01', '明細' || v_i, split_part(l, ',', 1)::numeric, split_part(l, ',', 2)::bigint, v_i);
  end loop;
end $$;
select pg_temp.mkcase(1, 0.1, '1,100');
select pg_temp.mkcase(2, 0.1, '1,99;1,99');
select pg_temp.mkcase(3, 0.1, '0.5,333');
select pg_temp.mkcase(4, 0.08, '2.5,1000;1,1');
select pg_temp.mkcase(5, 0.1, '1,99999999999');
select pg_temp.mkcase(6, 0.1055, '3,3333;0.01,100');
create or replace function pg_temp.tot(p_n int) returns text language plpgsql as $$
declare r jsonb;
begin
  r := pg_temp.call(tests.u('memberA'), 'issue_invoice', format('%L, %L', tests.id('ic' || p_n), date '2040-02-01'));
  return (r ->> 'subtotal') || '/' || (r ->> 'tax') || '/' || (r ->> 'total');
end $$;
select is(pg_temp.tot(1), '100/10/110', 'R-011-15・32 単純な1行');
select is(pg_temp.tot(2), '198/19/217', 'R-011-15・32 明細ごとに税をかけない（明細ごとなら 9＋9＝18）。税は1回、切り捨て');
select is(pg_temp.tot(3), '167/16/183', 'R-011-15・32 明細の金額は円未満を四捨五入（166.5 → 167）、税は切り捨て（16.7 → 16）');
select is(pg_temp.tot(4), '2501/200/2701', 'R-011-15・32 税率 8%');
select is(pg_temp.tot(5), '99999999999/9999999999/109999999998', 'R-011-15・32 大きな金額');
select is(pg_temp.tot(6), '10000/1055/11055', 'R-011-15・32 税率 10.55%（小数の数量）');

-- ===== R-011-16 番号 =====
select is((select number from public.invoices where id = tests.id('ic1')), 'I-2040-0001', 'R-011-16 番号は I-<西暦>-<4桁>');
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', format('%L, %L', tests.id('inv-zero'), date '2040-03-01')) ->> 'reason', 'zero_total', 'R-011-16 （確認）0 円は何度でも断る');
select is((select count(distinct number)::int from public.invoices where tenant_id = tests.t('A') and number like 'I-2040-%'), 6, 'R-011-16 同じ番号を2通に付けない');

-- ===== R-011-18 発行した請求書は直せない =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoices set note = '直す' where id = %L$q$, (select id from _x1))), 0::bigint, 'R-011-18 発行した請求書は直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoices set due_date = %L where id = %L$q$, date '2030-01-01', (select id from _x1))), 0::bigint, 'R-011-18 期日も直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoice_lines set name = '直す' where invoice_id = %L$q$, (select id from _x1))), 0::bigint, 'R-011-18 発行した請求書の明細は直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoice_lines set deleted_at = now() where invoice_id = %L$q$, (select id from _x1))), 0::bigint, 'R-011-18 明細を外せない');
select is(pg_temp.nlines((select id from _x1)), 6, 'R-011-18 明細は6つのまま');
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoice_lines set name = '直す' where invoice_id = %L$q$, tests.id('iA-issued'))), 0::bigint, 'R-011-18 種の発行済みの明細も直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoices set note = '直す' where id in (%L, %L, %L)$q$, tests.id('iA-sent'), tests.id('iA-partial'), tests.id('iA-paid'))), 0::bigint, 'R-011-18 送付・入金の請求書も直せない');

-- ===== R-011-10 下書きの編集 =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoice_lines set qty = 0.33 where id = %L$q$, tests.id('lA-draft1'))), 1::bigint, 'R-011-10 社員は下書きの明細の数量を直せる');
select is((select amount from public.invoice_lines where id = tests.id('lA-draft1')), 9900::bigint, 'R-011-10 金額は DB が 数量 × 単価（0.33 × 30000）で出す');
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoice_lines set name = '共用部の清掃（直した）', unit = '回', qty = 2.5 where id = %L$q$, tests.id('lA-draft2'))), 1::bigint, 'R-011-10 品名・単位・数量を直せる');
select is((select amount from public.invoice_lines where id = tests.id('lA-draft2')), 12500::bigint, 'R-011-10 2.5 × 5000 = 12500');
select is(tests.err(tests.u('memberA'), format($q$update public.invoice_lines set qty = 0 where id = %L$q$, tests.id('lA-draft1'))), '23514', 'R-011-10 数量が 0 以下ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoice_lines set name = '  ' where id = %L$q$, tests.id('lA-draft1'))), '23514', 'R-011-10 品名が空ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoices set tax_rate = 1.5 where id = %L$q$, tests.id('iA-draft'))), '23514', 'R-011-10 税率が 0〜1 の外ならば保存しない');
select is(tests.cnt(tests.u('adminA'), format($q$update public.invoices set tax_rate = 0.08 where id = %L$q$, tests.id('iA-draft'))), 1::bigint, 'R-011-10 管理者も税率を直せる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoice_lines set deleted_at = now() where id = %L$q$, tests.id('lA-draft2'))), 1::bigint, 'R-011-10 下書きの明細を外せる（論理削除）');

-- ===== R-011-11 直接書けないもの =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.invoices (tenant_id, client_id, period) values (%L, %L, date '2060-01-01')$q$, tests.t('A'), tests.id('cX1'))), '42501', 'R-011-11 請求書を直接作れない（RPC だけ）');
select is(tests.err(tests.u('memberA'), format($q$update public.invoices set status = 'issued' where id = %L$q$, tests.id('iA-draft'))), '42501', 'R-011-11 状況を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoices set number = 'I-9999-0001' where id = %L$q$, tests.id('iA-draft'))), '42501', 'R-011-11 番号を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoices set issue_date = %L where id = %L$q$, pg_temp.today(), tests.id('iA-draft'))), '42501', 'R-011-11 発行日を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoices set total = 5, subtotal = 5 where id = %L$q$, tests.id('iA-draft'))), '42501', 'R-011-11 合計を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoices set tax = 5 where id = %L$q$, tests.id('iA-draft'))), '42501', 'R-011-11 税を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoices set previous_id = %L where id = %L$q$, tests.id('iA-cancel'), tests.id('iA-draft'))), '42501', 'R-011-11 前の版を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoices set deleted_at = now() where id = %L$q$, tests.id('iA-draft'))), '42501', 'R-011-11 請求書を直接消せない（消すのは RPC）');
select is(tests.err(tests.u('adminA'), format($q$update public.invoices set status = 'paid' where id = %L$q$, tests.id('iA-draft'))), '42501', 'R-011-11 管理者も状況を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.invoice_lines (tenant_id, invoice_id, request_id, name) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('iA-draft'), tests.id('reqA-1'))), '42501', 'R-011-11 明細を直接作れない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoice_lines set unit_price = 1 where id = %L$q$, tests.id('lA-draft1'))), '42501', 'R-011-11 明細の単価を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoice_lines set service_key = %L where id = %L$q$, tests.id('kM1'), tests.id('lA-draft1'))), '42501', 'R-011-11 明細の元を付け替えられない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoice_lines set invoice_id = %L where id = %L$q$, tests.id('iA-issued'), tests.id('lA-draft1'))), '42501', 'R-011-11 明細を別の請求書へ付け替えられない');
select is(tests.err(tests.u('memberA'), format($q$update public.invoice_lines set amount = 1 where id = %L$q$, tests.id('lA-draft1'))), '428C9', 'R-011-11 明細の金額（生成列）を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.payments (tenant_id, invoice_id, paid_on, amount) values (%L, %L, %L, 100)$q$, tests.t('A'), tests.id('iA-issued'), pg_temp.today())), '42501', 'R-011-11 入金を直接作れない（RPC だけ）');
select is(tests.err(tests.u('memberA'), format($q$update public.payments set amount = 1 where id = %L$q$, tests.id('pA-partial'))), '42501', 'R-011-11 入金を直接直せない');
select is(tests.err(tests.u('memberA'), format($q$delete from public.payments where id = %L$q$, tests.id('pA-partial'))), '42501', 'R-011-11 入金を直接消せない');

-- ===== R-011-12 下書きを消す =====
create temp table _x2 on commit drop as select pg_temp.inv('cX2', date '2027-03-01') as id;
select is(pg_temp.call(tests.u('memberA'), 'delete_invoice', format('%L', (select id from _x2))) ->> 'ok', 'true', 'R-011-12 社員は下書きを消せる（RPC）');
select is((select count(*)::int from public.invoices where id = (select id from _x2) and deleted_at is not null), 1, 'R-011-12 請求書は論理削除');
select is(pg_temp.nlines((select id from _x2)), 0, 'R-011-12 明細も消える');
select is(pg_temp.call(tests.u('memberA'), 'delete_invoice', format('%L', (select id from _x1))) ->> 'reason', 'not_draft', 'R-011-12 発行した請求書は消させない');
select is(pg_temp.callerr(tests.u('memberA'), 'delete_invoice', format('%L', (select id from _x2))), '42501', 'R-011-12 消えた請求書は、見つからないのと同じ 42501');
create temp table _d4 on commit drop as select pg_temp.drafts(date '2027-03-01', 'cX2') as r;
select is((select (r ->> 'created')::int || '/' || (r ->> 'added')::int from _d4), '1/2', 'R-011-12 消した下書きの元は、次の下書きに入れ直せる');

-- ===== R-011-13 明細の元はどれか1つ =====
select is(pg_temp.try(format($q$insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, request_id, name) values (%L, %L, %L, date '2060-01-01', %L, 'x')$q$, tests.t('A'), tests.id('iA-draft'), tests.id('kz1'), tests.id('reqA-2'))), '23514', 'R-011-13 元が複数ならば保存しない');
select is(pg_temp.try(format($q$insert into public.invoice_lines (tenant_id, invoice_id, name) values (%L, %L, 'x')$q$, tests.t('A'), tests.id('iA-draft'))), '23514', 'R-011-13 元がなければ保存しない');
select is(pg_temp.try(format($q$insert into public.invoice_lines (tenant_id, invoice_id, service_key, name) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('iA-draft'), tests.id('kz2'))), '23514', 'R-011-13 契約の中身には月が要る');
select is(pg_temp.try(format($q$insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, name) values (%L, %L, %L, date '2060-01-15', 'x')$q$, tests.t('A'), tests.id('iA-draft'), tests.id('kz3'))), '23514', 'R-011-13 月は1日の日付');
select is(pg_temp.try(format($q$insert into public.invoice_lines (tenant_id, invoice_id, work_id, name) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('iA-draft'), tests.id('wB10'))), '23503', 'R-011-13 別の会社の作業は外部キーで止まる');

-- ===== R-011-19 送付 =====
select is(pg_temp.call(tests.u('memberA'), 'mark_invoice_sent', pg_temp.i('iA-issued')) ->> 'ok', 'true', 'R-011-19 社員は発行した請求書の送付を記録できる');
select is((select status || '/' || (sent_at is not null)::text from public.invoices where id = tests.id('iA-issued')), 'sent/true', 'R-011-19 状況が送付になり、送った日時が入る');
select is(pg_temp.call(tests.u('memberA'), 'mark_invoice_sent', pg_temp.i('iA-issued')) ->> 'already', 'true', 'R-011-19 二度呼んでも同じ');
select is(pg_temp.call(tests.u('memberA'), 'mark_invoice_sent', pg_temp.i('iA-draft')) ->> 'reason', 'not_issued', 'R-011-19 下書きは送付にさせない');
select is(pg_temp.call(tests.u('memberA'), 'mark_invoice_sent', pg_temp.i('iA-cancel')) ->> 'reason', 'not_issued', 'R-011-19 取消は送付にさせない');
select is(pg_temp.call(tests.u('memberA'), 'mark_invoice_sent', pg_temp.i('iA-partial')) ->> 'reason', 'has_payments', 'R-011-19 入金のあとは状況を変えず、断る');
select is(pg_temp.st(tests.id('iA-partial')), 'partial', 'R-011-19 一部入金のまま');

-- ===== R-011-20 取消 =====
create temp table _c1 on commit drop as select pg_temp.call(tests.u('memberA'), 'cancel_invoice', pg_temp.i('iA-sent') || ', ''二重に出した''') as r;
select is((select r ->> 'ok' from _c1), 'true', 'R-011-20 社員は送付した請求書を取り消せる');
select is((select status || '/' || (cancelled_at is not null)::text || '/' || cancel_reason || '/' || number from public.invoices where id = tests.id('iA-sent')), 'cancelled/true/二重に出した/I-2025-0002', 'R-011-20 状況・取り消した日時・理由が入り、番号は残る');
select is((select count(*)::int from public.invoice_lines where invoice_id = tests.id('iA-sent') and deleted_at is null), 0, 'R-011-20 明細が消える（元が空く）');
select is(pg_temp.call(tests.u('memberA'), 'cancel_invoice', pg_temp.i('iA-sent')) ->> 'already', 'true', 'R-011-20 二度呼んでも同じ');
select is(pg_temp.call(tests.u('memberA'), 'cancel_invoice', pg_temp.i('iA-draft')) ->> 'reason', 'draft', 'R-011-20 下書きは取り消させない（消す）');
select is(pg_temp.call(tests.u('memberA'), 'cancel_invoice', pg_temp.i('iA-partial')) ->> 'reason', 'has_payments', 'R-011-20 入金のある請求書は取り消させない');
select is(pg_temp.call(tests.u('memberA'), 'cancel_invoice', pg_temp.i('iA-paid')) ->> 'reason', 'has_payments', 'R-011-20 入金済みも取り消させない');
select is(pg_temp.call(tests.u('memberA'), 'issue_invoice', pg_temp.i('iA-sent')) ->> 'reason', 'not_draft', 'R-011-20 取り消した請求書は発行し直せない');
select is(pg_temp.call(tests.u('memberA'), 'mark_invoice_sent', pg_temp.i('iA-sent')) ->> 'reason', 'not_issued', 'R-011-20 取り消した請求書は送付にできない');

-- ===== R-011-8・21 取消のあと出し直す・載ったものは直せない =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set amount = 8100 where request_id = %L$q$, tests.id('rq1'))), 0::bigint, 'R-011-21 発行した請求書に載った案件の金額は直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.work_charges set amount = 12100 where work_id = %L$q$, tests.id('wd1'))), 0::bigint, 'R-011-21 載った作業の金額は直せない');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', tests.id('sM1'), date '2027-03-20', '{"amount":31000}')) ->> 'reason', 'invoiced', 'R-011-21 載った月に効く契約の中身の変更はできない');
select is(pg_temp.call(tests.u('memberA'), 'cancel_invoice', format('%L', (select id from _x1))) ->> 'ok', 'true', '（準備）X1 の請求書を取り消す');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set amount = 8100 where request_id = %L$q$, tests.id('rq1'))), 1::bigint, 'R-011-21 取り消して載らなくなれば、案件の金額をまた直せる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.work_charges set amount = 12100 where work_id = %L$q$, tests.id('wd1'))), 1::bigint, 'R-011-21 作業の金額も直せる');
create temp table _d5 on commit drop as select pg_temp.drafts(date '2027-03-01', 'cX1') as r;
select is((select (r ->> 'created')::int || '/' || (r ->> 'added')::int from _d5), '1/7', 'R-011-8 取り消した月は、下書きを作り直せる（取消で空いた6つと、新しい作業の1つ）');
select is((select previous_id from public.invoices where id = pg_temp.inv('cX1', date '2027-03-01')), (select id from _x1), 'R-011-8 出し直した下書きの previous_id に、取り消した請求書が入る');
select is((select unit_price from public.invoice_lines where request_id = tests.id('rq1') and deleted_at is null), 8100::bigint, 'R-011-8 直した金額が、出し直しの明細に載る');
select is(pg_temp.try(format($q$insert into public.invoices (tenant_id, client_id, period, previous_id) values (%L, %L, date '2060-02-01', %L)$q$, tests.t('A'), tests.id('cX1'), (select id from _x1))), '23505', 'R-011-8 1つの取り消した請求書からの出し直しは、DB でも1つ');
select is(pg_temp.call(tests.u('memberA'), 'change_contract_service', format('%L, %L, %L::jsonb', tests.id('sM1'), date '2027-03-20', '{"amount":31000}')) ->> 'reason', 'invoiced', 'R-011-21 出し直しの下書きに載っている間も、契約の中身は直せない');

-- ===== R-011-22〜25 入金 =====
select pg_temp.mkinv('p1', 'issued', 10000);
create temp table _p1 on commit drop as select pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, %L, 4000, %L', tests.id('inv-p1'), date '2050-02-10', '内金')) as r;
select is((select r ->> 'status' || '/' || (r ->> 'paid') || '/' || (r ->> 'balance') from _p1), 'partial/4000/6000', 'R-011-22 合計に満たない入金は「一部入金」');
select is((select paid_on::text || '/' || amount || '/' || note from public.payments where id = ((select r ->> 'id' from _p1))::uuid), '2050-02-10/4000/内金', 'R-011-22 入金日・金額・メモが入る');
create temp table _p2 on commit drop as select pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, %L, 6000', tests.id('inv-p1'), date '2050-02-20')) as r;
select is((select r ->> 'status' from _p2), 'paid', 'R-011-22 合計に達したら「入金済み」');
select is(pg_temp.st(tests.id('inv-p1')), 'paid', 'R-011-22 請求書の状況も同じ処理で変わる');
select is(pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, %L, 1', tests.id('inv-p1'), date '2050-02-21')) ->> 'reason', 'overpaid', 'R-011-23 合計を超える入金は受け付けない');
select is(pg_temp.call(tests.u('memberA'), 'update_payment', format('%L, %L, 3000, null', ((select r ->> 'id' from _p2)::uuid), date '2050-02-20')) ->> 'status', 'partial', 'R-011-24 入金を直すと、状況も戻る（入金済み → 一部入金）');
select is(pg_temp.call(tests.u('memberA'), 'update_payment', format('%L, %L, 7000, null', ((select r ->> 'id' from _p2)::uuid), date '2050-02-20')) ->> 'reason', 'overpaid', 'R-011-24 直すときも、合計を超える入金は受け付けない');
select is(pg_temp.call(tests.u('memberA'), 'update_payment', format('%L, %L, 6000, %L', ((select r ->> 'id' from _p2)::uuid), date '2050-02-22', '残り')) ->> 'status', 'paid', 'R-011-24 直して合計に達すれば、入金済みに戻る');
select is(pg_temp.call(tests.u('memberA'), 'delete_payment', format('%L', ((select r ->> 'id' from _p2)::uuid))) ->> 'status', 'partial', 'R-011-24 入金を消すと、状況が戻る（入金済み → 一部入金）');
select is(pg_temp.call(tests.u('memberA'), 'delete_payment', format('%L', ((select r ->> 'id' from _p1)::uuid))) ->> 'status', 'issued', 'R-011-24 入金が全部なくなれば、発行に戻る（送付していなければ）');
select pg_temp.mkinv('p2', 'sent', 5000, true);
create temp table _p3 on commit drop as select pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, %L, 5000', tests.id('inv-p2'), date '2050-02-10')) as r;
select is(pg_temp.st(tests.id('inv-p2')), 'paid', 'R-011-22 送付した請求書にも入金できる');
select is(pg_temp.call(tests.u('memberA'), 'delete_payment', format('%L', ((select r ->> 'id' from _p3)::uuid))) ->> 'status', 'sent', 'R-011-24 送付していた請求書は、入金がなくなると「送付」に戻る');
select is(pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, %L, 0', tests.id('inv-p2'), date '2050-02-10')) ->> 'reason', 'invalid_amount', 'R-011-23 金額が 0 以下ならば受け付けない');
select is(pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, %L, -5', tests.id('inv-p2'), date '2050-02-10')) ->> 'reason', 'invalid_amount', 'R-011-23 負の金額も受け付けない');
select is(pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, null, 100', tests.id('inv-p2'))) ->> 'reason', 'paid_on_required', 'R-011-23 入金日がなければ受け付けない');
select is(pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, %L, 100', tests.id('iA-draft'), date '2050-02-10')) ->> 'reason', 'not_issued', 'R-011-23 下書きには入金させない');
select is(pg_temp.call(tests.u('memberA'), 'record_payment', format('%L, %L, 100', tests.id('iA-sent'), date '2050-02-10')) ->> 'reason', 'cancelled', 'R-011-23 取消の請求書には入金させない');
insert into public.payments (id, tenant_id, invoice_id, paid_on, amount) values (tests.id('pCancel'), tests.t('A'), tests.id('iA-sent'), date '2050-02-10', 100);
select is(pg_temp.call(tests.u('memberA'), 'update_payment', format('%L, %L, 50, null', tests.id('pCancel'), date '2050-02-10')) ->> 'reason', 'cancelled', 'R-011-24 取り消した請求書の入金は直せない');
select is(pg_temp.call(tests.u('memberA'), 'delete_payment', format('%L', tests.id('pCancel'))) ->> 'reason', 'cancelled', 'R-011-24 消せない');
select is((select paid::text || '/' || balance::text from public.invoice_balances where invoice_id = tests.id('iA-partial')), '10000/12000', 'R-011-25 view で、入金額と残高を読める');
select is((select paid::text || '/' || balance::text from public.invoice_balances where invoice_id = tests.id('iA-draft')), '0/0', 'R-011-25 入金のない請求書の入金額は 0');
select is(tests.n(tests.u('staffA'), 'select 1 from public.invoice_balances'), 0::bigint, 'R-011-25 view は見る人の権限で絞る（スタッフには見えない）');
select ok(tests.n(tests.u('memberA'), format($q$select 1 from public.invoice_balances where tenant_id = %L$q$, tests.t('A'))) > 0, 'R-011-25 社員には見える');

-- ===== R-011-26〜28 権限と会社 =====
create or replace function pg_temp.rpcs_blocked(p_uid uuid) returns text language plpgsql as $$
declare v text := ''; r jsonb; e text; f text;
begin
  foreach f in array array[
    format('create_invoice_drafts(%L, %L, null)', tests.t('A'), date '2027-04-01'),
    format('issue_invoice(%L)', tests.id('iA-draft')), format('mark_invoice_sent(%L)', tests.id('iA-issued')),
    format('cancel_invoice(%L, null)', tests.id('iA-issued')), format('delete_invoice(%L)', tests.id('iA-draft')),
    format('record_payment(%L, %L, 100, null)', tests.id('iA-issued'), date '2050-02-10'),
    format('update_payment(%L, %L, 100, null)', tests.id('pA-partial'), date '2050-02-10'), format('delete_payment(%L)', tests.id('pA-partial'))] loop
    r := case when p_uid is null then tests.run_as_anon(format('select public.%s as r', f)) else tests.run_as(p_uid, format('select public.%s as r', f)) end;
    e := r ->> 'error';
    if e is distinct from '42501' then v := v || f || ':' || coalesce(e, 'ok') || ','; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.rpcs_blocked(tests.u('staffA')), '', 'R-011-26 スタッフは、請求の RPC を1つも呼べない');
select is(pg_temp.rpcs_blocked(tests.u('extA')), '', 'R-011-26 外部の人は呼べない');
select is(pg_temp.rpcs_blocked(tests.u('nobody')), '', 'R-011-26 どの会社にも属さない人は呼べない');
select is(pg_temp.rpcs_blocked(tests.u('operator')), '', 'R-011-26 運営は呼べない');
select is(pg_temp.rpcs_blocked(null), '', 'R-011-26 ログインしていない人は呼べない');
select is(pg_temp.rpcs_blocked(tests.u('adminB')), '', 'R-011-28 別の会社の管理者は、会社 A の請求の RPC が効かない（42501）');
select is(pg_temp.callerr(tests.u('memberA'), 'issue_invoice', format('%L', tests.id('iB-issued'))), '42501', 'R-011-28 別の会社の請求書は、権限がないのと同じ 42501');
select is(pg_temp.callerr(tests.u('memberA'), 'issue_invoice', format('%L', tests.id('no-such-invoice'))), '42501', 'R-011-28 見つからない請求書も同じ 42501');
select is(pg_temp.callerr(tests.u('memberA'), 'record_payment', format('%L, %L, 100, null', tests.id('iB-issued'), date '2050-02-10')), '42501', 'R-011-28 別の会社の請求書には入金できない');
select is(pg_temp.callerr(tests.u('memberA'), 'delete_payment', format('%L', tests.id('pB-1'))), '42501', 'R-011-28 別の会社の入金は消せない');
select ok(pg_temp.call(tests.u('adminA'), 'create_invoice_drafts', format('%L, %L, null', tests.t('A'), date '2031-09-01')) ->> 'ok' = 'true', 'R-011-26 管理者も下書きを作れる');
select ok(pg_temp.call(tests.u('adminA'), 'issue_invoice', pg_temp.i('iA-draft')) ->> 'ok' = 'true', 'R-011-26 管理者も発行できる');
select is(tests.n(tests.u('staffA'), 'select 1 from public.invoices'), 0::bigint, 'R-011-27 スタッフは請求書を読めない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.invoice_lines'), 0::bigint, 'R-011-27 スタッフは明細を読めない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.payments'), 0::bigint, 'R-011-27 スタッフは入金を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.invoices'), 0::bigint, 'R-011-27 外部の人は請求書を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.invoice_lines'), 0::bigint, 'R-011-27 外部の人は明細を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.payments'), 0::bigint, 'R-011-27 外部の人は入金を読めない');
select is(tests.n(tests.u('operator'), 'select 1 from public.invoices'), 0::bigint, 'R-011-27 運営は、許可がなければ読めない');
select is(tests.n(tests.u('nobody'), 'select 1 from public.invoices'), 0::bigint, 'R-011-27 どの会社にも属さない人は読めない');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.invoices where id = %L$q$, tests.id('iA-issued'))), 1::bigint, 'R-011-27 社員は請求書を読める');
select is(tests.n(tests.u('adminA'), format($q$select 1 from public.payments where id = %L$q$, tests.id('pA-partial'))), 1::bigint, 'R-011-27 管理者は入金を読める');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.invoices where tenant_id = %L$q$, tests.t('B'))), 0::bigint, 'R-011-28 別の会社の請求書は読めない');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.invoice_lines where tenant_id = %L$q$, tests.t('B'))), 0::bigint, 'R-011-28 別の会社の明細は読めない');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.payments where tenant_id = %L$q$, tests.t('B'))), 0::bigint, 'R-011-28 別の会社の入金は読めない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.invoices set note = 'x' where id = %L$q$, tests.id('iB-issued'))), 0::bigint, 'R-011-28 別の会社の請求書は直せない');
select is(tests.err(tests.u('staffA'), format($q$update public.invoices set note = 'x' where id = %L$q$, tests.id('iA-draft'))), null, 'R-011-26 スタッフの更新は、読めないので何も変えない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.invoices set note = 'x' where id = %L$q$, tests.id('iA-draft'))), 0::bigint, 'R-011-26 スタッフは下書きを直せない');

-- ===== R-011-29 履歴 =====
select ok((select count(*) from public.audit_logs where table_name = 'invoices' and action = 'insert' and source = 'rpc') >= 3, 'R-011-29 下書きを作ったことが、source が rpc で履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'invoices' and action = 'update' and source = 'rpc' and changed ? 'status') >= 2, 'R-011-29 状況の変化が、source が rpc で履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'invoice_lines' and action = 'insert' and source = 'rpc') >= 6, 'R-011-29 明細を作ったことが履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'payments' and action = 'insert' and source = 'rpc') >= 3, 'R-011-29 入金の記録が履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'invoices' and action = 'update' and changed ? 'note') >= 1, 'R-011-29 画面からの直しも履歴に残る');

-- ===== R-011-30 請求書のある取引先は消さない =====
select is(pg_temp.call(tests.u('memberA'), 'delete_client', format('%L', tests.id('clientA11'))) -> 'blockers' -> 0 ->> 'reason', 'has_invoices', 'R-011-30 請求書がある取引先は消さず、理由（has_invoices）を返す');
select is((pg_temp.call(tests.u('memberA'), 'delete_client', format('%L', tests.id('clientA11'))) -> 'blockers' -> 0 ->> 'count')::int > 0, true, 'R-011-30 件数も返す');
select is(pg_temp.call(tests.u('memberA'), 'delete_client', format('%L', tests.id('c-p1'))) -> 'blockers' -> 0 ->> 'reason', 'has_invoices', 'R-011-30 取消でない請求書（入金のあったもの）でも消さない');

-- ===== R-011-31 お知らせの種類 =====
select is((select code || '/' || required_perm from public.notification_kinds where code = 'invoice_overdue'), 'invoice_overdue/amount.read', 'R-011-31 invoice_overdue は、amount.read を要る種類として載っている');

select * from finish();
rollback;
