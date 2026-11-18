-- 機能 016：売上と粗利（R-016-1〜18）。R-016-19〜21 は画面の部品（Vitest）と画面の流れ（Playwright）。
begin;
select * from no_plan();
select tests.seed();

create or replace function pg_temp.i(p text) returns uuid language sql as $$ select tests.id(p) $$;
-- 月 2028-05 の1行（建物・契約を指定。null なら「なし」の行）
create or replace function pg_temp.row(p_uid uuid, p_building text, p_contract text, p_month date default date '2028-05-01') returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select revenue, draft_revenue, petty, outsourcing, material, other_cost, gross from public.profit_monthly where tenant_id = %L and month = %L and building_id %s and contract_id %s',
    tests.t('A'), p_month,
    case when p_building is null then 'is null' else '= ' || quote_literal(tests.id(p_building)::text) end,
    case when p_contract is null then 'is null' else '= ' || quote_literal(tests.id(p_contract)::text) end)) -> 'rows' -> 0
$$;
create or replace function pg_temp.sums(p_uid uuid, p_month date default date '2028-05-01') returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select coalesce(sum(revenue),0)::bigint as revenue, coalesce(sum(draft_revenue),0)::bigint as draft, coalesce(sum(petty),0)::bigint as petty,
    coalesce(sum(outsourcing + material + other_cost),0)::bigint as manual, coalesce(sum(gross),0)::bigint as gross, count(*)::int as n from public.profit_monthly where tenant_id = %L and month = %L', tests.t('A'), p_month)) -> 'rows' -> 0
$$;

-- 社員として、1つの値を返す select（列の名前は v）を流す。小口の行は amount.read の人にだけ見えるので、集計は必ずこれで読む
create or replace function pg_temp.v(p_sql text) returns bigint language sql as $$
  select (tests.run_as(tests.u('memberA'), p_sql) -> 'rows' -> 0 ->> 'v')::bigint
$$;

-- ---- 準備：取引先・建物・契約・作業・案件（会社 A の P 系と、会社 B の Q 系）----
insert into public.clients (id, tenant_id, kind, name) values
  (pg_temp.i('cP1'), tests.t('A'), 'management_company', '利益テスト取引先1'),
  (pg_temp.i('cP2'), tests.t('A'), 'management_company', '利益テスト取引先2'),
  (pg_temp.i('cP3'), tests.t('A'), 'management_company', '利益テスト取引先3'),
  (pg_temp.i('cQ'), tests.t('B'), 'management_company', '利益テスト取引先Q');
insert into public.buildings (id, tenant_id, client_id, name, address) values
  (pg_temp.i('bP1'), tests.t('A'), pg_temp.i('cP1'), '利益ビル1', '東京都1'),
  (pg_temp.i('bP2'), tests.t('A'), pg_temp.i('cP2'), '利益ビル2', '東京都2'),
  (pg_temp.i('bP3'), tests.t('A'), pg_temp.i('cP1'), '利益ビル3', '東京都3'),
  (pg_temp.i('bP4'), tests.t('A'), pg_temp.i('cP3'), '利益ビル4', '東京都4'),
  (pg_temp.i('bQ'), tests.t('B'), pg_temp.i('cQ'), '利益ビルQ', '大阪府Q');
insert into public.contracts (id, tenant_id, client_id, building_id, source, kind, start_date, status) values
  (pg_temp.i('ctP1'), tests.t('A'), pg_temp.i('cP1'), pg_temp.i('bP1'), 'import', 'recurring', date '2028-01-01', 'active'),
  (pg_temp.i('ctP2'), tests.t('A'), pg_temp.i('cP2'), pg_temp.i('bP2'), 'import', 'recurring', date '2028-01-01', 'active'),
  (pg_temp.i('ctP3'), tests.t('A'), pg_temp.i('cP3'), pg_temp.i('bP4'), 'import', 'recurring', date '2028-01-01', 'active'),
  (pg_temp.i('ctQ'), tests.t('B'), pg_temp.i('cQ'), pg_temp.i('bQ'), 'import', 'recurring', date '2028-01-01', 'active');
insert into public.contract_services (id, tenant_id, contract_id, service_key, service_kind, name, amount, billing, recurrence, valid_from, valid_to) values
  (pg_temp.i('sP1'), tests.t('A'), pg_temp.i('ctP1'), pg_temp.i('kP1'), 'base', '定期清掃1', 30000, 'monthly', 'FREQ=WEEKLY;BYDAY=MO', date '2028-01-01', date '2028-03-31'),
  -- 金額を変えた新しい行（同じ service_key）。どちらの行でも、同じ契約に付く
  (pg_temp.i('sP1b'), tests.t('A'), pg_temp.i('ctP1'), pg_temp.i('kP1'), 'base', '定期清掃1', 32000, 'monthly', 'FREQ=WEEKLY;BYDAY=MO', date '2028-04-01', null),
  (pg_temp.i('sP2'), tests.t('A'), pg_temp.i('ctP2'), pg_temp.i('kP2'), 'base', '定期清掃2', 20000, 'monthly', 'FREQ=MONTHLY', date '2028-01-01', null),
  (pg_temp.i('sP3'), tests.t('A'), pg_temp.i('ctP3'), pg_temp.i('kP3'), 'base', '定期清掃3', 6000, 'monthly', 'FREQ=MONTHLY', date '2028-01-01', null),
  (pg_temp.i('sQ'), tests.t('B'), pg_temp.i('ctQ'), pg_temp.i('kQ'), 'base', '定期清掃Q', 9000, 'monthly', 'FREQ=MONTHLY', date '2028-01-01', null);
insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status) values
  (pg_temp.i('wP1'), tests.t('A'), pg_temp.i('bP1'), pg_temp.i('sP1b'), pg_temp.i('kP1'), '窓清掃', date '2028-05-12', 'done');
insert into public.requests (id, tenant_id, client_id, building_id, source, category, title, status) values
  (pg_temp.i('rqP1'), tests.t('A'), pg_temp.i('cP1'), pg_temp.i('bP3'), 'manual', 'repair', '照明の交換', 'done');

-- ---- 準備：請求書と明細（管理者の権限で直接。RLS を通らない）----
-- iP1：取引先1・発行。契約の中身 30000＋作業 5000×2＋案件 8000
-- iP2：取引先2・入金済み。契約の中身 20000
-- iP3：取引先3・下書き。契約の中身 6000
-- iP4：取引先1・取消（明細が消えていない）。iP5：取引先2・消した請求書（発行済み）
insert into public.invoices (id, tenant_id, client_id, period, number, issue_date, due_date, tax_rate, subtotal, tax, total, status, issued_at, cancelled_at) values
  (pg_temp.i('iP1'), tests.t('A'), pg_temp.i('cP1'), date '2028-05-01', 'P-1', date '2028-06-01', date '2028-06-30', 0.1, 48000, 4800, 52800, 'issued', now(), null),
  (pg_temp.i('iP2'), tests.t('A'), pg_temp.i('cP2'), date '2028-05-01', 'P-2', date '2028-06-01', date '2028-06-30', 0.1, 20000, 2000, 22000, 'paid', now(), null),
  (pg_temp.i('iP3'), tests.t('A'), pg_temp.i('cP3'), date '2028-05-01', null, null, null, 0.1, 0, 0, 0, 'draft', null, null),
  (pg_temp.i('iP4'), tests.t('A'), pg_temp.i('cP1'), date '2028-05-01', 'P-4', date '2028-06-01', date '2028-06-30', 0.1, 99999, 9999, 109998, 'cancelled', now(), now()),
  -- 前の月（2028-04）と、前の年（2027-05）
  (pg_temp.i('iP6'), tests.t('A'), pg_temp.i('cP1'), date '2028-04-01', 'P-6', date '2028-05-01', date '2028-05-31', 0.1, 30000, 3000, 33000, 'sent', now(), null),
  (pg_temp.i('iP7'), tests.t('A'), pg_temp.i('cP1'), date '2027-05-01', 'P-7', date '2026-06-01', date '2026-06-30', 0.1, 25000, 2500, 27500, 'paid', now(), null),
  (pg_temp.i('iQ1'), tests.t('B'), pg_temp.i('cQ'), date '2028-05-01', 'Q-1', date '2028-06-01', date '2028-06-30', 0.1, 9000, 900, 9900, 'issued', now(), null);
insert into public.invoices (id, tenant_id, client_id, period, number, issue_date, due_date, tax_rate, subtotal, tax, total, status, issued_at, deleted_at)
values (pg_temp.i('iP5'), tests.t('A'), pg_temp.i('cP2'), date '2028-05-01', 'P-5', date '2028-06-01', date '2028-06-30', 0.1, 77777, 7777, 85554, 'issued', now(), now());
insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, work_id, request_id, name, qty, unit, unit_price, sort) values
  (tests.t('A'), pg_temp.i('iP1'), pg_temp.i('kP1'), date '2028-05-01', null, null, '定期清掃1', 1, '月', 30000, 1),
  (tests.t('A'), pg_temp.i('iP1'), null, null, pg_temp.i('wP1'), null, '窓清掃', 2, '回', 5000, 2),
  (tests.t('A'), pg_temp.i('iP1'), null, null, null, pg_temp.i('rqP1'), '照明の交換', 1, '式', 8000, 3),
  (tests.t('A'), pg_temp.i('iP2'), pg_temp.i('kP2'), date '2028-05-01', null, null, '定期清掃2', 1, '月', 20000, 1),
  (tests.t('A'), pg_temp.i('iP3'), pg_temp.i('kP3'), date '2028-05-01', null, null, '定期清掃3', 1, '月', 6000, 1),
  (tests.t('A'), pg_temp.i('iP4'), pg_temp.i('kP9'), date '2028-05-01', null, null, '取り消した分', 1, '式', 99999, 1),
  (tests.t('A'), pg_temp.i('iP5'), pg_temp.i('kP8'), date '2028-05-01', null, null, '消した請求書', 1, '式', 77777, 1),
  (tests.t('A'), pg_temp.i('iP6'), pg_temp.i('kP1'), date '2028-04-01', null, null, '定期清掃1（4月）', 1, '月', 30000, 1),
  (tests.t('A'), pg_temp.i('iP7'), pg_temp.i('kP7'), date '2027-05-01', null, null, '定期清掃（前の年）', 1, '月', 25000, 1),
  (tests.t('B'), pg_temp.i('iQ1'), pg_temp.i('kQ'), date '2028-05-01', null, null, '定期清掃Q', 1, '月', 9000, 1);
-- 外した明細（消した明細は売上に入れない）
insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, name, qty, unit, unit_price, sort, deleted_at) values
  (tests.t('A'), pg_temp.i('iP1'), pg_temp.i('kP5'), date '2028-05-01', '外した明細', 1, '式', 55555, 9, now());

-- ---- 準備：小口（スタッフ staffA の小口）----
insert into public.cash_accounts (id, tenant_id, holder_id, name) values (pg_temp.i('acP'), tests.t('A'), tests.id('m:A:staffA'), '利益テストの小口');
insert into public.cash_entries (id, tenant_id, account_id, holder_id, entry_date, direction, amount, purpose, building_id, work_id, status, confirmed_at, closed_at, deleted_at) values
  -- 確認済み・建物あり（契約なし）
  (pg_temp.i('ce1'), tests.t('A'), pg_temp.i('acP'), tests.id('m:A:staffA'), date '2028-05-10', 'out', 3000, '洗剤', pg_temp.i('bP1'), null, 'confirmed', now(), null, null),
  -- 締め済み・作業あり（作業の建物と契約に付く）
  (pg_temp.i('ce2'), tests.t('A'), pg_temp.i('acP'), tests.id('m:A:staffA'), date '2028-05-20', 'out', 1500, '駐車場', null, pg_temp.i('wP1'), 'closed', now(), now(), null),
  -- 下書き（入れない）
  (pg_temp.i('ce3'), tests.t('A'), pg_temp.i('acP'), tests.id('m:A:staffA'), date '2028-05-11', 'out', 9000, '下書き', pg_temp.i('bP1'), null, 'draft', null, null, null),
  -- 入金（渡した現金。入れない）
  (pg_temp.i('ce4'), tests.t('A'), pg_temp.i('acP'), tests.id('m:A:staffA'), date '2028-05-01', 'in', 50000, '渡した', null, null, 'confirmed', now(), null, null),
  -- 建物も作業もない（建物なし）
  (pg_temp.i('ce5'), tests.t('A'), pg_temp.i('acP'), tests.id('m:A:staffA'), date '2028-05-25', 'out', 2000, 'ごみ袋', null, null, 'confirmed', now(), null, null),
  -- 消した行（入れない）
  (pg_temp.i('ce6'), tests.t('A'), pg_temp.i('acP'), tests.id('m:A:staffA'), date '2028-05-26', 'out', 700, '消した', pg_temp.i('bP1'), null, 'confirmed', now(), null, now()),
  -- 前の月（4月30日）：5月には入れない
  (pg_temp.i('ce7'), tests.t('A'), pg_temp.i('acP'), tests.id('m:A:staffA'), date '2028-04-30', 'out', 400, '4月分', pg_temp.i('bP1'), null, 'confirmed', now(), null, null);

-- ===== R-016-9 費用を作る・直す・消す（invoice.edit）=====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, building_id, kind, amount, note) values (%L, date '2028-05-01', %L, 'outsourcing', 12000, '外注の窓清掃')$q$, tests.t('A'), pg_temp.i('bP1'))), 1::bigint, 'R-016-9 社員は費用（外注）を作れる');
select is(tests.cnt(tests.u('adminA'), format($q$insert into public.costs (id, tenant_id, month, contract_id, kind, amount) values (%L, %L, date '2028-05-01', %L, 'material', 4000)$q$, pg_temp.i('cm'), tests.t('A'), pg_temp.i('ctP2'))), 1::bigint, 'R-016-9 管理者は契約だけを指す費用（材料）を作れる');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.costs (id, tenant_id, month, kind, amount, note) values (%L, %L, date '2028-05-01', 'other', 1000, '共通')$q$, pg_temp.i('cc'), tests.t('A'))), 1::bigint, 'R-016-9 建物も契約もない共通の費用を作れる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.costs set amount = 1200, note = '共通（直した）' where id = %L$q$, pg_temp.i('cc'))), 1::bigint, 'R-016-9 費用を直せる');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.costs (id, tenant_id, month, kind, amount) values (%L, %L, date '2028-05-01', 'other', 555)$q$, pg_temp.i('cd'), tests.t('A'))), 1::bigint, '（準備）あとで消す費用を作る');
select is(tests.cnt(tests.u('memberA'), format($q$update public.costs set deleted_at = now() where id = %L$q$, pg_temp.i('cd'))), 1::bigint, 'R-016-9 費用を消せる（論理削除）');
select is(tests.cnt(tests.u('memberA'), format($q$update public.costs set amount = 1000 where id = %L$q$, pg_temp.i('cc'))), 1::bigint, '（準備）共通の費用を 1000 に戻す');
-- 前の月（4月）と前の年（2027-05）の費用
insert into public.costs (tenant_id, month, building_id, kind, amount) values (tests.t('A'), date '2028-04-01', pg_temp.i('bP1'), 'material', 2500), (tests.t('A'), date '2027-05-01', pg_temp.i('bP1'), 'outsourcing', 5000);

-- ===== R-016-10 入力の検査 =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-15', 'other', 100)$q$, tests.t('A'))), '23514', 'R-016-10 月がその月の1日でなければ保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'travel', 100)$q$, tests.t('A'))), '23514', 'R-016-10 種類が外注・材料・その他の外は保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'other', 0)$q$, tests.t('A'))), '23514', 'R-016-10 金額が 0 以下は保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'other', -5)$q$, tests.t('A'))), '23514', 'R-016-10 金額がマイナスは保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', null, 100)$q$, tests.t('A'))), '23502', 'R-016-10 種類が空は保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, building_id, contract_id, kind, amount) values (%L, date '2028-05-01', %L, %L, 'other', 100)$q$, tests.t('A'), pg_temp.i('bP2'), pg_temp.i('ctP1'))), '42501', 'R-016-10 建物と契約の両方を指すとき、契約の建物と違えば保存しない');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.costs (id, tenant_id, month, building_id, contract_id, kind, amount) values (%L, %L, date '2028-05-01', %L, %L, 'other', 100)$q$, pg_temp.i('cb'), tests.t('A'), pg_temp.i('bP1'), pg_temp.i('ctP1'))), 1::bigint, 'R-016-10 契約の建物と同じ建物なら、両方を指せる');
select is(tests.err(tests.u('memberA'), format($q$update public.costs set building_id = %L where id = %L$q$, pg_temp.i('bP3'), pg_temp.i('cb'))), '42501', 'R-016-10 直すときも、建物と契約が合わなければ保存しない');
delete from public.costs where id = pg_temp.i('cb');

-- ===== R-016-11 別の会社の建物・契約 =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, building_id, kind, amount) values (%L, date '2028-05-01', %L, 'other', 100)$q$, tests.t('A'), pg_temp.i('bQ'))), '23503', 'R-016-11 別の会社の建物を指す費用は保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, contract_id, kind, amount) values (%L, date '2028-05-01', %L, 'other', 100)$q$, tests.t('A'), pg_temp.i('ctQ'))), '23503', 'R-016-11 別の会社の契約を指す費用は保存しない');
select is(tests.err(tests.u('adminB'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'other', 100)$q$, tests.t('A'))), '42501', 'R-016-11 別の会社の費用として保存しない');

-- ===== R-016-1〜3 売上 =====
select is((pg_temp.row(tests.u('memberA'), 'bP1', 'ctP1') ->> 'revenue')::bigint, 40000::bigint, 'R-016-1 売上は発行した請求書の明細（契約の中身 30000＋作業 5000×2）。金額は税抜');
select is((pg_temp.row(tests.u('memberA'), 'bP2', 'ctP2') ->> 'revenue')::bigint, 20000::bigint, 'R-016-1 入金済みの請求書も売上（入金の有無で動かない）');
select is((pg_temp.sums(tests.u('memberA')) ->> 'revenue')::bigint, 68000::bigint, 'R-016-1 5月の売上の合計。取消・消した請求書・外した明細は入らない');
select is((pg_temp.row(tests.u('memberA'), 'bP4', 'ctP3') ->> 'revenue')::bigint, 0::bigint, 'R-016-2 下書きは売上に入れない');
select is((pg_temp.row(tests.u('memberA'), 'bP4', 'ctP3') ->> 'draft_revenue')::bigint, 6000::bigint, 'R-016-2 下書きの分は、下書き（見込み）の列に出る');
select is((pg_temp.row(tests.u('memberA'), 'bP4', 'ctP3') ->> 'gross')::bigint, 0::bigint, 'R-016-2 下書きは粗利に入れない');
select is((pg_temp.sums(tests.u('memberA')) ->> 'draft')::bigint, 6000::bigint, 'R-016-2 取消・消した請求書の分は、下書きの列にも入らない');
select is((pg_temp.row(tests.u('memberA'), 'bP3', null) ->> 'revenue')::bigint, 8000::bigint, 'R-016-3 案件の明細は、案件の建物に付く（契約はなし）');
select is((tests.run_as(tests.u('memberA'), format($q$select client_id as v from public.profit_monthly where tenant_id = %L and month = date '2028-05-01' and building_id = %L$q$, tests.t('A'), pg_temp.i('bP3'))) -> 'rows' -> 0 ->> 'v')::uuid, pg_temp.i('cP1'), 'R-016-3 取引先は請求書の取引先');
select is(pg_temp.v(format($q$select count(*)::bigint as v from public.profit_monthly where tenant_id = %L and month = date '2028-05-01' and building_id = %L and contract_id = %L$q$, tests.t('A'), pg_temp.i('bP1'), pg_temp.i('ctP1'))), 1::bigint, 'R-016-3 作業の明細は、作業の契約と建物に付く。契約の中身の古い行・新しい行のどちらも、同じ契約に付く（行が割れない）');
select is(pg_temp.v(format($q$select count(*)::bigint as v from public.profit_monthly where tenant_id = %L and month = date '2028-04-01' and contract_id = %L and revenue = 30000$q$, tests.t('A'), pg_temp.i('ctP1'))), 1::bigint, 'R-016-3 4月の契約の中身も、同じ契約に付く');

-- ===== R-016-4 小口の費用 =====
select is((pg_temp.row(tests.u('memberA'), 'bP1', null) ->> 'petty')::bigint, 3000::bigint, 'R-016-4 小口の確認済みの出金は、出入りの建物（契約なし）の費用に入る。下書き・消した行は入らない');
select is((pg_temp.row(tests.u('memberA'), 'bP1', 'ctP1') ->> 'petty')::bigint, 1500::bigint, 'R-016-4 締め済みの出金は、作業の建物と契約の費用に入る');
select is((pg_temp.row(tests.u('memberA'), null, null) ->> 'petty')::bigint, 2000::bigint, 'R-016-4 建物も作業もない出金は、「建物なし」の行に入り、消えない');
select is((pg_temp.sums(tests.u('memberA')) ->> 'petty')::bigint, 6500::bigint, 'R-016-4 5月の小口の費用の合計（入金・下書き・消した行・4月の行は入らない）');
select is(pg_temp.v(format($q$select petty as v from public.profit_monthly where tenant_id = %L and month = date '2028-04-01' and building_id = %L and contract_id is null$q$, tests.t('A'), pg_temp.i('bP1'))), 400::bigint, 'R-016-4 4月30日の出金は4月に入る');

-- ===== R-016-5 手で入れた費用 =====
select is((pg_temp.row(tests.u('memberA'), 'bP1', null) ->> 'outsourcing')::bigint, 12000::bigint, 'R-016-5 外注の費用は、その月・建物の外注の列に入る');
select is((pg_temp.row(tests.u('memberA'), 'bP2', 'ctP2') ->> 'material')::bigint, 4000::bigint, 'R-016-5 建物が空で契約がある費用は、契約の建物に入る');
select is((pg_temp.row(tests.u('memberA'), null, null) ->> 'other_cost')::bigint, 1000::bigint, 'R-016-5 建物も契約もない費用は「共通」の行に入る');
select is((pg_temp.sums(tests.u('memberA')) ->> 'manual')::bigint, 17000::bigint, 'R-016-5 5月の手で入れた費用の合計（消した費用は入らない）');

-- ===== R-016-6 粗利 =====
select is((pg_temp.row(tests.u('memberA'), 'bP1', 'ctP1') ->> 'gross')::bigint, 38500::bigint, 'R-016-6 粗利＝売上 40000 − 小口 1500');
select is((pg_temp.row(tests.u('memberA'), 'bP1', null) ->> 'gross')::bigint, -15000::bigint, 'R-016-6 売上のない行の粗利は、費用の分だけマイナス（小口 3000＋外注 12000）');
select is((pg_temp.sums(tests.u('memberA')) ->> 'gross')::bigint, 44500::bigint, 'R-016-6 5月の粗利の合計 ＝ 売上 68000 − 小口 6500 − 外注・材料・その他 17000');

-- ===== R-016-7 どの切り方でも同じ合計 =====
select is(pg_temp.v(format($q$select sum(revenue)::bigint as v from public.profit_monthly where tenant_id = %L and month = date '2028-05-01'$q$, tests.t('A'))), 68000::bigint, 'R-016-7 行をすべて足した売上が、全体の売上と一致する');
select is(pg_temp.v(format($q$select count(*)::bigint as v from public.profit_monthly where tenant_id = %L and month = date '2028-05-01' and (building_id is null or contract_id is null)$q$, tests.t('A'))), 3::bigint, 'R-016-7 建物・契約が決められない分は、行として残る（契約なしの建物 2 行と、建物なし・共通の 1 行）');
select is(pg_temp.v(format($q$select sum(g)::bigint as v from (select building_id, sum(gross) as g from public.profit_monthly where tenant_id = %L and month = date '2028-05-01' group by building_id) x$q$, tests.t('A'))), 44500::bigint, 'R-016-7 建物ごとに集めた粗利の合計が、全体と一致する');
select is(pg_temp.v(format($q$select sum(g)::bigint as v from (select client_id, sum(gross) as g from public.profit_monthly where tenant_id = %L and month = date '2028-05-01' group by client_id) x$q$, tests.t('A'))), 44500::bigint, 'R-016-7 取引先ごとに集めた粗利の合計が、全体と一致する');
select is(pg_temp.v(format($q$select sum(g)::bigint as v from (select contract_id, sum(gross) as g from public.profit_monthly where tenant_id = %L and month = date '2028-05-01' group by contract_id) x$q$, tests.t('A'))), 44500::bigint, 'R-016-7 契約ごとに集めた粗利の合計が、全体と一致する');

-- ===== R-016-8 前の月・前の年（DB は、月を指定すれば、その月の行を返す。差と率は画面の部品）=====
select is((pg_temp.sums(tests.u('memberA'), date '2028-04-01') ->> 'revenue')::bigint, 30000::bigint, 'R-016-8 前の月（2028-04）の売上が読める');
select is((pg_temp.sums(tests.u('memberA'), date '2027-05-01') ->> 'revenue')::bigint, 25000::bigint, 'R-016-8 前の年の同じ月（2027-05）の売上が読める');
select is((pg_temp.sums(tests.u('memberA'), date '2027-05-01') ->> 'manual')::bigint, 5000::bigint, 'R-016-8 前の年の同じ月の費用が読める');

-- ===== R-016-12 履歴 =====
select ok((select count(*) from public.audit_logs where table_name = 'costs' and action = 'insert') >= 3, 'R-016-12 費用を作ったことが履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'costs' and action = 'update' and changed ? 'amount') >= 1, 'R-016-12 費用を直したことが履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'costs' and action = 'update' and changed ? 'deleted_at') >= 1, 'R-016-12 費用を消したことが履歴に残る');

-- ===== R-016-13 費用のある建物は消さない =====
select ok((tests.run_as(tests.u('memberA'), format('select public.delete_building(%L) as r', pg_temp.i('bP1'))) -> 'rows' -> 0 -> 'r' -> 'blockers') @> '[{"reason":"has_costs"}]'::jsonb, 'R-016-13 費用がある建物は消さず、理由（has_costs）を返す');
insert into public.costs (id, tenant_id, month, building_id, kind, amount) values (pg_temp.i('ck'), tests.t('A'), date '2028-05-01', pg_temp.i('bP4'), 'other', 100);
update public.contracts set status = 'ended', end_date = date '2028-04-30' where id = pg_temp.i('ctP3');
select ok((tests.run_as(tests.u('memberA'), format('select public.delete_building(%L) as r', pg_temp.i('bP4'))) -> 'rows' -> 0 -> 'r' -> 'blockers') @> '[{"reason":"has_costs"}]'::jsonb, 'R-016-13 契約が終わっていても、費用があれば建物は消さない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.costs set deleted_at = now() where id = %L$q$, pg_temp.i('ck'))), 1::bigint, '（準備）費用を消す');
select is(tests.run_as(tests.u('memberA'), format('select public.delete_building(%L) as r', pg_temp.i('bP4'))) -> 'rows' -> 0 -> 'r' ->> 'ok', 'true', 'R-016-13 費用を消せば、建物を消せる');

-- ===== R-016-14 読める人 =====
select ok(pg_temp.row(tests.u('adminA'), 'bP1', 'ctP1') is not null, 'R-016-14 管理者は売上と粗利を読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.profit_monthly'), 0::bigint, 'R-016-14 スタッフは、粗利の view を読めない（0 行）');
select is(tests.n(tests.u('staffA'), 'select 1 from public.profit_lines'), 0::bigint, 'R-016-14 スタッフは、1件ごとの view も読めない。自分の小口の出金も出てこない');
select is(tests.n(tests.u('staffA'), format('select 1 from public.cash_entries where holder_id = %L', tests.id('m:A:staffA'))) > 0, true, '（前提）スタッフは、自分の小口の出入りそのものは読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.costs'), 0::bigint, 'R-016-14 スタッフは費用を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.profit_monthly'), 0::bigint, 'R-016-14 外部の人は、粗利の view を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.costs'), 0::bigint, 'R-016-14 外部の人は費用を読めない');
select is(tests.n(tests.u('nobody'), 'select 1 from public.profit_monthly'), 0::bigint, 'R-016-14 どの会社にも属さない人は、粗利の view を読めない');
select is(tests.n(tests.u('operator'), 'select 1 from public.profit_monthly'), 0::bigint, 'R-016-14 運営は、許可のないとき粗利の view を読めない');
select is(tests.run_as_anon('select 1 from public.profit_monthly') ->> 'error', '42501', 'R-016-14 ログインしていない人は、粗利の view を読めない（権限がない）');
select is(tests.run_as_anon('select 1 from public.costs') ->> 'error', '42501', 'R-016-14 ログインしていない人は、費用を読めない');

-- ===== R-016-16 別の会社 =====
select is(tests.n(tests.u('adminB'), format('select 1 from public.profit_monthly where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-016-16 別の会社の管理者は、A の売上・粗利を読めない');
select is(tests.n(tests.u('adminB'), format('select 1 from public.costs where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-016-16 別の会社の管理者は、A の費用を読めない');
select is(tests.cnt(tests.u('adminB'), format($q$update public.costs set amount = 1 where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-016-16 別の会社の管理者は、A の費用を直せない');
select is((tests.run_as(tests.u('adminB'), format('select coalesce(sum(revenue),0)::bigint as v from public.profit_monthly where month = %L', date '2028-05-01')) -> 'rows' -> 0 ->> 'v')::bigint, 9000::bigint, 'R-016-16 B の管理者が読むのは、B の売上（9000）だけ');

-- ===== R-016-17 view は security_invoker =====
select is((select reloptions::text from pg_class where relname = 'profit_lines'), '{security_invoker=true}', 'R-016-17 profit_lines は security_invoker');
select is((select reloptions::text from pg_class where relname = 'profit_monthly'), '{security_invoker=true}', 'R-016-17 profit_monthly は security_invoker');
select is((select count(*)::int from information_schema.role_table_grants where table_name in ('profit_lines', 'profit_monthly') and grantee in ('anon', 'PUBLIC')), 0, 'R-016-17 anon・public に権限がない');

-- ===== R-016-15 費用を書けるのは invoice.edit（amount.read だけの人は書けない）=====
-- 社員から invoice.edit を外した状態（この確かめの中だけ）にする
delete from public.role_permissions where role_id = (select id from public.roles where code = 'member') and permission_id = (select id from public.permissions where code = 'invoice.edit');
select is(tests.n(tests.u('memberA'), 'select 1 from public.costs') > 0, true, '（前提）amount.read だけの社員は、費用を読める');
select is(tests.err(tests.u('memberA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'other', 100)$q$, tests.t('A'))), '42501', 'R-016-15 invoice.edit を持たない人は、費用を作れない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.costs set amount = 1 where id = %L$q$, pg_temp.i('cc'))), 0::bigint, 'R-016-15 invoice.edit を持たない人は、費用を直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.costs set deleted_at = now() where id = %L$q$, pg_temp.i('cc'))), 0::bigint, 'R-016-15 invoice.edit を持たない人は、費用を消せない');
select is(tests.err(tests.u('staffA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'other', 100)$q$, tests.t('A'))), '42501', 'R-016-15 スタッフは費用を作れない');
select is(tests.err(tests.u('extA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'other', 100)$q$, tests.t('A'))), '42501', 'R-016-15 外部の人は費用を作れない');
select is(tests.err(tests.u('operator'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'other', 100)$q$, tests.t('A'))), '42501', 'R-016-15 運営は費用を作れない');
select is(tests.err(tests.u('adminA'), format($q$insert into public.costs (tenant_id, month, kind, amount) values (%L, date '2028-05-01', 'other', 100)$q$, tests.t('A'))), null, '（確認）invoice.edit を持つ管理者は作れる');

-- ===== R-016-18 速さ：会社×月で絞ると、索引が使われる =====
-- 会社 A に、36 か月 × 60 取引先の請求書・明細、小口の出金、費用を足し、統計を取ってから、月で絞った読みの計画を見る
insert into public.clients (id, tenant_id, kind, name) select tests.id('pc' || g), tests.t('A'), 'management_company', '性能' || g from generate_series(1, 60) g;
insert into public.invoices (id, tenant_id, client_id, period, number, issue_date, due_date, tax_rate, subtotal, tax, total, status, issued_at)
select tests.id('pi' || g || '-' || m), tests.t('A'), tests.id('pc' || g), (date '2024-01-01' + (m || ' months')::interval)::date, 'PF-' || g || '-' || m,
       date '2030-01-01', date '2030-01-31', 0.1, 1000, 100, 1100, 'issued', now()
from generate_series(1, 60) g, generate_series(0, 35) m;
insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, name, qty, unit, unit_price, sort)
select tests.t('A'), tests.id('pi' || g || '-' || m), tests.id('pk' || g), (date '2024-01-01' + (m || ' months')::interval)::date, '性能', 1, '月', 1000, 1
from generate_series(1, 60) g, generate_series(0, 35) m;
insert into public.cash_entries (tenant_id, account_id, holder_id, entry_date, direction, amount, purpose, status, confirmed_at)
select tests.t('A'), tests.id('acP'), tests.id('m:A:staffA'), date '2024-01-01' + (g % 1000), 'out', 100, '性能', 'confirmed', now() from generate_series(1, 3000) g;
insert into public.costs (tenant_id, month, kind, amount)
select tests.t('A'), (date '2024-01-01' + ((g % 36) || ' months')::interval)::date, 'other', 100 from generate_series(1, 1500) g;
analyze public.invoices; analyze public.invoice_lines; analyze public.cash_entries; analyze public.costs;
create or replace function pg_temp.plan(p_sql text) returns text language plpgsql as $$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || (r."QUERY PLAN") || E'\n'; end loop;
  return v;
end $$;
create temp table _plan on commit drop as
select pg_temp.plan(format('select * from public.profit_monthly where tenant_id = %L and month = %L', tests.t('A'), date '2025-06-01')) as p;
select ok((select p from _plan) ~ 'invoices_period_idx', 'R-016-18 請求書は、会社と月の索引（invoices_period_idx）で読む');
select ok((select p from _plan) ~ 'cash_entries_out_month_idx', 'R-016-18 小口の出金は、会社と月の索引（cash_entries_out_month_idx）で読む');
select ok((select p from _plan) ~ 'costs_month_idx', 'R-016-18 費用は、会社と月の索引（costs_month_idx）で読む');
select ok((select p from _plan) !~ 'Seq Scan on (public\.)?(invoices|cash_entries|costs)( |$)', 'R-016-18 請求書・小口・費用の全部の行を読まない');
select is((select count(*)::int from public.profit_monthly where tenant_id = tests.t('A') and month = date '2025-06-01' and client_id is not null), 60, 'R-016-18 その月の行が（60 取引先ぶん）返る');

select * from finish();
rollback;
