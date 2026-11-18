-- 機能 004：見積（R-004-1〜26）。R-004-27〜31 は画面の部品（Vitest）、R-004-29 の DB 側は tools/pglite/quote-totals.mjs
begin;
select * from no_plan();
select tests.seed();

-- ---- 道具 ----
-- RPC を呼んで戻りの jsonb を返す。args は SQL の文字列（例：format('%L', id)）
create or replace function pg_temp.call(p_uid uuid, p_fn text, p_args text) returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.callerr(p_uid uuid, p_fn text, p_args text) returns text language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) ->> 'error'
$$;
create or replace function pg_temp.qid(p text) returns text language sql as $$ select quote_literal(tests.id(p)::text) $$;
-- 日本時間の今年
create or replace function pg_temp.yr() returns int language sql as $$ select extract(year from (now() at time zone 'Asia/Tokyo'))::int $$;
-- 管理者の権限で下書きと明細を用意する（RLS を通らない）
create or replace function pg_temp.mkq(p_name text, p_kind text default 'request', p_rate numeric default 0.1, p_tenant text default 'A', p_valid date default null) returns void language plpgsql as $$
begin
  insert into public.quotes (id, tenant_id, client_id, building_id, kind, tax_rate, valid_until)
  values (tests.id(p_name), tests.t(p_tenant), tests.id('client' || p_tenant || '4'), tests.id('building' || p_tenant || '4'), p_kind, p_rate, p_valid);
end $$;
create or replace function pg_temp.mkl(p_q text, p_n int, p_kind text, p_qty numeric, p_price int, p_rec text default null, p_tenant text default 'A') returns void language plpgsql as $$
begin
  insert into public.quote_lines (id, tenant_id, quote_id, line_kind, name, qty, unit, unit_price, recurrence, sort)
  values (tests.id('ln:' || p_q || ':' || p_n), tests.t(p_tenant), tests.id(p_q), p_kind, '明細' || p_n, p_qty, '式', p_price, p_rec, p_n);
end $$;
create or replace function pg_temp.field(p_q text, p_col text) returns text language plpgsql as $$
declare v text;
begin execute format('select %I::text from public.quotes where id = %L', p_col, tests.id(p_q)) into v; return v; end $$;

-- ===== R-004-1 品名の候補 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.items (tenant_id, name, unit, unit_price, kind) values (%L, '新しい品名', '回', 5000, 'one_time')$q$, tests.t('A'))), 1::bigint,
  'R-004-1 社員は品名の候補を登録できる');
select is(tests.cnt(tests.u('adminA'), format($q$insert into public.items (tenant_id, name, unit, unit_price, kind) values (%L, '管理者の品名', '式', 0, 'option')$q$, tests.t('A'))), 1::bigint,
  'R-004-1 管理者も登録できる（単価 0 もよい）');
select is(tests.err(tests.u('memberA'), format($q$insert into public.items (tenant_id, name, unit_price, kind) values (%L, '  ', 100, 'base')$q$, tests.t('A'))), '23514', 'R-004-1 名前が空ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.items (tenant_id, name, unit_price, kind) values (%L, '負の単価', -1, 'base')$q$, tests.t('A'))), '23514', 'R-004-1 単価が負ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.items (tenant_id, name, unit_price, kind) values (%L, '変な種類', 100, 'other')$q$, tests.t('A'))), '23514', 'R-004-1 種類が決まった値以外ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.items (tenant_id, name, unit_price, kind) values (%L, '新しい品名', 100, 'base')$q$, tests.t('A'))), '23505', 'R-004-1 同じ名前（消していない行）は2つ作らない');
select is(tests.err(tests.u('staffA'), format($q$insert into public.items (tenant_id, name, unit_price, kind) values (%L, 'スタッフの品名', 100, 'base')$q$, tests.t('A'))), '42501', 'R-004-21 スタッフは品名の候補を作れない');

-- ===== R-004-2 品名の候補の直しと削除 =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.items set unit_price = 31000 where id = %L$q$, tests.id('itemA-base'))), 1::bigint, 'R-004-2 品名の候補の単価を直せる');
select is((select unit_price from public.quote_lines where id = tests.id('ln:qA-draft:2')), 12000, 'R-004-2 すでに明細に写した単価は変わらない（品名の候補を直しても）');
select is(tests.cnt(tests.u('memberA'), format($q$update public.items set unit_price = 13000 where id = %L$q$, tests.id('itemA-opt'))), 1::bigint, '（準備）窓清掃の候補の単価を直す');
select is((select unit_price from public.quote_lines where id = tests.id('ln:qA-draft:2')), 12000, 'R-004-2 下書きの明細の単価も、候補を直しただけでは変わらない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.items set deleted_at = now() where id = %L$q$, tests.id('itemA-opt'))), 1::bigint, 'R-004-2 品名の候補を消せる（論理削除）');
select is((select count(*)::int from public.quote_lines where item_id = tests.id('itemA-opt') and deleted_at is null), 5, 'R-004-2 消しても、使った明細は残る');

-- ===== R-004-3 見積を作る =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.quotes (id, tenant_id, client_id, building_id, kind) values (%L, %L, %L, %L, 'request')$q$,
  tests.id('qNew'), tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), 1::bigint, 'R-004-3 社員は取引先と建物だけで（案件なしで）見積を作れる');
select is((select status || '/' || kind || '/' || coalesce(request_id::text, 'null') || '/' || coalesce(number, 'null') from public.quotes where id = tests.id('qNew')), 'draft/request/null/null', 'R-004-3 下書きで保存され、案件と番号は空');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind, request_id) values (%L, %L, %L, 'recurring', %L)$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'), tests.id('reqA-1'))), 1::bigint, 'R-004-3 自社の案件の id を付けて見積を作れる（外部キーは 53 で確かめる）');
select is(tests.cnt(tests.u('adminA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind) values (%L, %L, %L, 'special')$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), 1::bigint, 'R-004-3 種類は特別清掃も作れる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind) values (%L, %L, %L, 'request')$q$,
  tests.t('A'), tests.id('clientB4'), tests.id('buildingA4'))), '23503', 'R-004-3 別の会社の取引先は受け付けない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind) values (%L, %L, %L, 'request')$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingB4'))), '23503', 'R-004-3 別の会社の建物は受け付けない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind) values (%L, %L, %L, 'other')$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), '23514', 'R-004-3 種類が決まった値以外ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind, tax_rate) values (%L, %L, %L, 'request', 1.5)$q$,
  tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), '23514', 'R-004-3 税率が 0〜1 の外ならば保存しない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set valid_until = date '2030-01-31', tax_rate = 0.08, note = '備考' where id = %L$q$, tests.id('qNew'))), 1::bigint, 'R-004-3 下書きの有効期限・税率・備考を直せる');

-- ===== R-004-4 明細 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.quote_lines (id, tenant_id, quote_id, item_id, line_kind, name, qty, unit, unit_price, sort)
  values (%L, %L, %L, %L, 'one_time', '床の洗浄', 2.5, '回', 1000, 1)$q$, tests.id('lnNew'), tests.t('A'), tests.id('qNew'), tests.id('itemA-base'))), 1::bigint, 'R-004-4 社員は下書きに明細を足せる');
select is((select amount from public.quote_lines where id = tests.id('lnNew')), 2500::bigint, 'R-004-4 金額は 数量 × 単価（2.5 × 1000 = 2500）');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quote_lines set qty = 1.5, unit_price = 3333 where id = %L$q$, tests.id('lnNew'))), 1::bigint, 'R-004-4 明細を直せる');
select is((select amount from public.quote_lines where id = tests.id('lnNew')), 5000::bigint, 'R-004-4 直すと金額も出し直す（1.5 × 3333 = 4999.5 → 5000 に四捨五入）');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price) values (%L, %L, 'base', 'x', 0, 100)$q$, tests.t('A'), tests.id('qNew'))), '23514', 'R-004-4 数量が 0 ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price) values (%L, %L, 'base', 'x', 1, -5)$q$, tests.t('A'), tests.id('qNew'))), '23514', 'R-004-4 単価が負ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price) values (%L, %L, 'base', ' ', 1, 100)$q$, tests.t('A'), tests.id('qNew'))), '23514', 'R-004-4 名前が空ならば保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price) values (%L, %L, 'weird', 'x', 1, 100)$q$, tests.t('A'), tests.id('qNew'))), '23514', 'R-004-4 明細の種類が決まった値以外ならば保存しない');
select isnt(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price, amount) values (%L, %L, 'base', 'x', 1, 100, 999999)$q$, tests.t('A'), tests.id('qNew'))), null, 'R-004-4 金額を直接書き込むことはできない（システムが出す）');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price) values (%L, %L, 'one_time', 'x', 1, 100)$q$, tests.t('A'), tests.id('qB-draft'))), '42501', 'R-004-3 別の会社の見積には明細を付けられない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quote_lines set deleted_at = now() where id = %L$q$, tests.id('lnNew'))), 1::bigint, 'R-004-4 明細を消せる（論理削除）');
select is(tests.err(tests.u('memberA'), format($q$update public.quote_lines set quote_id = %L where id = %L$q$, tests.id('qA-draft'), tests.id('ln:qA-draft:1'))), '42501', 'R-004-6 明細を別の見積へ付け替えることはできない');

-- ===== R-004-5 繰り返し =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price, recurrence) values (%L, %L, 'base', 'x', 1, 100, 'every month')$q$, tests.t('A'), tests.id('qNew'))), '23514', 'R-004-5 RRULE の形でない繰り返しは保存しない');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price, recurrence) values (%L, %L, 'base', 'x', 1, 100, 'FREQ=MONTHLY;BYDAY=2TU')$q$, tests.t('A'), tests.id('qNew'))), 1::bigint, 'R-004-5 RRULE の文字列は保存できる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price, recurrence) values (%L, %L, 'base', 'x', 1, 100, 'RRULE:FREQ=MONTHLY')$q$, tests.t('A'), tests.id('qNew'))), '23514', 'R-004-5 保存する形は FREQ=… から始まる（RRULE: は付けない）');

-- ===== R-004-6 直接書けない列 =====
select is(tests.err(tests.u('memberA'), format($q$update public.quotes set status = 'submitted' where id = %L$q$, tests.id('qNew'))), '42501', 'R-004-6 状況を直接書き換えられない');
select is(tests.err(tests.u('memberA'), format($q$update public.quotes set number = 'Q-X-1' where id = %L$q$, tests.id('qNew'))), '42501', 'R-004-6 番号を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.quotes set total = 1 where id = %L$q$, tests.id('qNew'))), '42501', 'R-004-6 合計を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.quotes set tax = 1, subtotal = 1 where id = %L$q$, tests.id('qNew'))), '42501', 'R-004-6 税・小計を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.quotes set issue_date = current_date where id = %L$q$, tests.id('qNew'))), '42501', 'R-004-6 発行日を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.quotes set previous_id = %L where id = %L$q$, tests.id('qA-sub'), tests.id('qNew'))), '42501', 'R-004-6 元の版を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.quotes set decided_by = %L, decided_at = now() where id = %L$q$, tests.u('memberA'), tests.id('qNew'))), '42501', 'R-004-6 決めた人と日を直接書けない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind, status, number, issue_date, subtotal, tax, total)
  values (%L, %L, %L, 'request', 'submitted', 'Q-9-1', current_date, 100, 10, 110)$q$, tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), '42501', 'R-004-6 提出済みの見積を直接作れない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind, total, subtotal)
  values (%L, %L, %L, 'request', 500, 500)$q$, tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), '42501', 'R-004-6 合計を入れた下書きも直接作れない（合計は提出の RPC だけ）');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind, previous_id)
  values (%L, %L, %L, 'request', %L)$q$, tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'), tests.id('qA-sub'))), '42501', 'R-004-6 元の版つきの見積は、直す RPC だけが作る');
select is((select status || '/' || coalesce(number, 'null') from public.quotes where id = tests.id('qNew')), 'draft/null', 'R-004-6 拒まれたあとも、見積は下書きのまま');

-- ===== R-004-7 下書きを消す =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set deleted_at = now() where id = %L$q$, tests.id('qB-draft'))), 0::bigint, '（前提）別の会社の下書きは消せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set deleted_at = now() where id = %L$q$, tests.id('qA-draft'))), 1::bigint, 'R-004-7 社員は下書きの見積を消せる（論理削除）');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set deleted_at = now() where id = %L$q$, tests.id('qA-sub'))), 0::bigint, 'R-004-7 提出した見積は消せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set deleted_at = now() where id = %L$q$, tests.id('qA-app'))), 0::bigint, 'R-004-7 承認した見積も消せない');

-- ===== R-004-8・9 提出：合計・税・番号 =====
select pg_temp.mkq('qS1');
select pg_temp.mkl('qS1', 1, 'one_time', 1, 10005);
create temp table _ctr (v int) on commit drop;
insert into _ctr select coalesce((select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'quote' and year = pg_temp.yr()), 0);
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qS1')) ->> 'ok', 'true', 'R-004-8 社員は下書きを提出できる');
select is(pg_temp.field('qS1', 'subtotal') || '/' || pg_temp.field('qS1', 'tax') || '/' || pg_temp.field('qS1', 'total'), '10005/1000/11005', 'R-004-8 小計・税・合計を計算して入れる');
select is(pg_temp.field('qS1', 'status'), 'submitted', 'R-004-8 状況は「提出」になる');
select is(pg_temp.field('qS1', 'number'), 'Q-' || pg_temp.yr() || '-' || lpad(((select v from _ctr) + 1)::text, 4, '0'), 'R-004-8 番号が付く（Q-西暦-4桁）');
select is(pg_temp.field('qS1', 'issue_date'), (now() at time zone 'Asia/Tokyo')::date::text, 'R-004-8 発行日は日本時間の今日');
select is(pg_temp.field('qS1', 'valid_until'), ((now() at time zone 'Asia/Tokyo')::date + 30)::text, 'R-004-8 有効期限が空なら、発行日の 30 日後');
select ok(pg_temp.field('qS1', 'submitted_at') is not null, 'R-004-8 提出した日時が入る');
-- 税は帳票ごとに1回
select pg_temp.mkq('qS2', 'request', 0.1);
select pg_temp.mkl('qS2', 1, 'one_time', 1, 15); select pg_temp.mkl('qS2', 2, 'one_time', 1, 15); select pg_temp.mkl('qS2', 3, 'one_time', 1, 15);
select pg_temp.mkq('qS2v', 'request', 0.1, 'A', current_date + 5);
select pg_temp.mkl('qS2v', 1, 'one_time', 1, 100);
select is(pg_temp.call(tests.u('adminA'), 'submit_quote', pg_temp.qid('qS2')) ->> 'ok', 'true', '（準備）2通目を提出する');
select is(pg_temp.field('qS2', 'subtotal') || '/' || pg_temp.field('qS2', 'tax') || '/' || pg_temp.field('qS2', 'total'), '45/4/49', 'R-004-9 税は明細ごとではなく帳票ごとに1回（15×3 = 45、税 4.5 → 4）');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qS2v')) ->> 'ok', 'true', '（準備）有効期限つきの下書きを提出する');
select is(pg_temp.field('qS2v', 'valid_until'), (current_date + 5)::text, 'R-004-8 入れた有効期限は、そのまま残る');
select pg_temp.mkq('qS3', 'request', 0.08);
select pg_temp.mkl('qS3', 1, 'one_time', 1, 12345);
select pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qS3'));
select is(pg_temp.field('qS3', 'tax') || '/' || pg_temp.field('qS3', 'total'), '987/13332', 'R-004-9 税率は帳票の値（8% で 987）');
-- 消した明細は合計に入れない
select pg_temp.mkq('qS4'); select pg_temp.mkl('qS4', 1, 'one_time', 1, 1000); select pg_temp.mkl('qS4', 2, 'one_time', 1, 9000);
update public.quote_lines set deleted_at = now() where id = tests.id('ln:qS4:2');
select pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qS4'));
select is(pg_temp.field('qS4', 'subtotal'), '1000', 'R-004-8 消した明細は合計に入れない');

-- ===== R-004-10 番号 =====
select is(pg_temp.field('qS2', 'number'), 'Q-' || pg_temp.yr() || '-' || lpad(((select v from _ctr) + 2)::text, 4, '0'), 'R-004-10 次の提出には次の番号（欠番も重複もない）');
select is((select count(distinct number)::int from public.quotes where tenant_id = tests.t('A') and number like 'Q-' || pg_temp.yr() || '-%'), 5, 'R-004-10 今年の番号は、5通で重ならない');
select is(app.quote_number(pg_temp.yr() + 1, 1), 'Q-' || (pg_temp.yr() + 1) || '-0001', 'R-004-10 番号の形は Q-西暦-4桁');
select is(app.next_doc_no(tests.t('A'), 'quote', pg_temp.yr() + 1), 1, 'R-004-10 年が変わると、1 から振り直す');
select is(app.next_doc_no(tests.t('A'), 'quote', pg_temp.yr() + 1), 2, 'R-004-10 同じ年の次は 2');
select is((select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'quote' and year = pg_temp.yr()), (select v from _ctr) + 5, 'R-004-10 今年の番号は、提出した数だけ進んでいる');
select pg_temp.mkq('qBn', 'request', 0.1, 'B'); select pg_temp.mkl('qBn', 1, 'one_time', 1, 100, null, 'B');
select is(pg_temp.call(tests.u('adminB'), 'submit_quote', pg_temp.qid('qBn')) ->> 'ok', 'true', '（準備）B 社の見積を提出する');
select is(pg_temp.field('qBn', 'number'), 'Q-' || pg_temp.yr() || '-' || lpad((select last_no from public.document_counters where tenant_id = tests.t('B') and kind = 'quote' and year = pg_temp.yr())::text, 4, '0'), 'R-004-10 会社ごとに別の番号（B 社の番号は B 社の分だけ進む）');
select is((select count(*)::int from public.document_counters where tenant_id = tests.t('A') and kind = 'invoice'), 0, 'R-004-10 見積の番号は、請求の番号を進めない');

-- ===== R-004-11・12 提出できない見積 =====
create temp table _ctr2 (v int) on commit drop;
select pg_temp.mkq('qE1');
insert into _ctr2 select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'quote' and year = pg_temp.yr();
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qE1')) ->> 'reason', 'no_lines', 'R-004-11 明細が1つもなければ提出できない');
select is(pg_temp.field('qE1', 'status'), 'draft', 'R-004-11 提出できなかった見積は下書きのまま');
select is((select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'quote' and year = pg_temp.yr()), (select v from _ctr2), 'R-004-10 提出できなかったときは、番号を進めない（欠番を作らない）');
select pg_temp.mkl('qE1', 1, 'one_time', 1, 100);
update public.quote_lines set deleted_at = now() where id = tests.id('ln:qE1:1');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qE1')) ->> 'reason', 'no_lines', 'R-004-11 消した明細だけでも、明細なしとして断る');
select pg_temp.mkq('qE2', 'request', 0.1, 'A', current_date - 1); select pg_temp.mkl('qE2', 1, 'one_time', 1, 100);
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qE2')) ->> 'reason', 'valid_until_before_issue', 'R-004-11 有効期限が発行日より前ならば提出できない');
-- 定期
select pg_temp.mkq('qR1', 'recurring'); select pg_temp.mkl('qR1', 1, 'option', 1, 5000, 'FREQ=MONTHLY');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qR1')) ->> 'reason', 'recurring_needs_base', 'R-004-12 定期の見積は、基本の明細がなければ提出できない');
select pg_temp.mkq('qR2', 'recurring'); select pg_temp.mkl('qR2', 1, 'base', 1, 30000, 'FREQ=MONTHLY'); select pg_temp.mkl('qR2', 2, 'option', 1, 5000);
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qR2')) ->> 'reason', 'recurrence_missing', 'R-004-12 定期の見積は、オプションに繰り返しがなければ提出できない');
select pg_temp.mkq('qR3', 'request'); select pg_temp.mkl('qR3', 1, 'one_time', 1, 5000, 'FREQ=MONTHLY');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qR3')) ->> 'reason', 'recurrence_not_allowed', 'R-004-12 定期でない見積は、繰り返しのある明細があれば提出できない');
select pg_temp.mkq('qR4', 'recurring'); select pg_temp.mkl('qR4', 1, 'base', 1, 30000, 'FREQ=MONTHLY'); select pg_temp.mkl('qR4', 2, 'option', 1, 12000, 'FREQ=MONTHLY;INTERVAL=3'); select pg_temp.mkl('qR4', 3, 'one_time', 1, 8000);
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qR4')) ->> 'ok', 'true', 'R-004-12 基本とオプションに繰り返しがあれば、定期の見積を提出できる（単発は繰り返しなしでよい）');
select is(pg_temp.field('qR4', 'subtotal') || '/' || pg_temp.field('qR4', 'tax') || '/' || pg_temp.field('qR4', 'total'), '50000/5000/55000', 'R-004-12 定期の合計は、全部の明細の金額の合計に税を1回かける');

-- ===== R-004-13 二度提出 =====
create temp table _ctr3 (v int) on commit drop;
insert into _ctr3 select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'quote' and year = pg_temp.yr();
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qS1')) ->> 'already', 'true', 'R-004-13 提出済みをもう一度提出すると、何もしないで終わる');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qS1')) ->> 'number', pg_temp.field('qS1', 'number'), 'R-004-13 前の番号を返す');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qS1')) -> 'total', '11005'::jsonb, 'R-004-13 前の合計を返す');
select is((select last_no from public.document_counters where tenant_id = tests.t('A') and kind = 'quote' and year = pg_temp.yr()), (select v from _ctr3), 'R-004-13 番号は進まない');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qA-app')) ->> 'reason', 'not_draft', 'R-004-13 承認済みの見積は、提出できない（下書きではない）');

-- ===== R-004-14 提出のあとは直せない =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set note = '直す' where id = %L$q$, tests.id('qS1'))), 0::bigint, 'R-004-14 提出した見積は直せない（0 行）');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set valid_until = date '2031-01-01' where id = %L$q$, tests.id('qS1'))), 0::bigint, 'R-004-14 有効期限も直せない');
select is(tests.cnt(tests.u('adminA'), format($q$update public.quotes set tax_rate = 0.2 where id = %L$q$, tests.id('qS1'))), 0::bigint, 'R-004-14 管理者も直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quote_lines set unit_price = 1 where id = %L$q$, tests.id('ln:qS1:1'))), 0::bigint, 'R-004-14 提出した見積の明細は直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quote_lines set deleted_at = now() where id = %L$q$, tests.id('ln:qS1:1'))), 0::bigint, 'R-004-14 提出した見積の明細は消せない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price) values (%L, %L, 'one_time', '後から足す', 1, 100)$q$, tests.t('A'), tests.id('qS1'))), '42501', 'R-004-14 提出した見積に明細を足せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set deleted_at = now() where id = %L$q$, tests.id('qS1'))), 0::bigint, 'R-004-14 提出した見積は消せない');
select is((select count(*)::int from public.quote_lines where quote_id = tests.id('qS1') and deleted_at is null), 1, 'R-004-14 明細はそのまま残っている');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set status = 'draft' where id = %L$q$, tests.id('qS1'))), -1::bigint, 'R-004-14 状況を下書きに戻せない（列の権限で拒まれる）');

-- ===== R-004-15 承認 =====
select is(pg_temp.call(tests.u('memberA'), 'approve_quote', pg_temp.qid('qA-sub')) ->> 'ok', 'true', 'R-004-15 社員は提出した見積を承認できる');
select is(pg_temp.field('qA-sub', 'status'), 'approved', 'R-004-15 状況は「承認」');
select is(pg_temp.field('qA-sub', 'decided_by'), tests.u('memberA')::text, 'R-004-15 決めた人が入る');
select ok(pg_temp.field('qA-sub', 'decided_at') is not null, 'R-004-15 決めた日時が入る');
select is(pg_temp.call(tests.u('memberA'), 'approve_quote', pg_temp.qid('qA-sub')) ->> 'already', 'true', 'R-004-15 承認を二度呼んでも、同じ結果で終わる');
select is(pg_temp.callerr(tests.u('memberA'), 'approve_quote', pg_temp.qid('qB-draft')), '42501', '（前提）別の会社の見積の承認は 42501');
select pg_temp.mkq('qD1'); select pg_temp.mkl('qD1', 1, 'one_time', 1, 100);
select is(pg_temp.call(tests.u('memberA'), 'approve_quote', pg_temp.qid('qD1')) ->> 'reason', 'not_submitted', 'R-004-15 下書きは承認させない');
select is(pg_temp.call(tests.u('memberA'), 'approve_quote', pg_temp.qid('qA-rej')) ->> 'reason', 'not_submitted', 'R-004-15 不成立の見積は承認させない');
select is(pg_temp.field('qD1', 'status') || '/' || pg_temp.field('qA-rej', 'status'), 'draft/rejected', 'R-004-15 断ったあとも状況は変わらない');

-- ===== R-004-16 不成立 =====
select is(pg_temp.call(tests.u('memberA'), 'reject_quote', pg_temp.qid('qS2') || ', ' || quote_literal('価格が合わなかった')) ->> 'ok', 'true', 'R-004-16 社員は提出した見積を不成立にできる');
select is(pg_temp.field('qS2', 'status') || '/' || pg_temp.field('qS2', 'decision_note') || '/' || pg_temp.field('qS2', 'decided_by'), 'rejected/価格が合わなかった/' || tests.u('memberA')::text, 'R-004-16 状況・理由・決めた人が入る');
select ok(pg_temp.field('qS2', 'decided_at') is not null, 'R-004-16 決めた日時が入る');
select is(pg_temp.call(tests.u('memberA'), 'reject_quote', pg_temp.qid('qS2')) ->> 'already', 'true', 'R-004-16 二度呼んでも、同じ結果で終わる');
select is(pg_temp.call(tests.u('memberA'), 'reject_quote', pg_temp.qid('qD1')) ->> 'reason', 'not_submitted', 'R-004-16 下書きは不成立にさせない');
select is(pg_temp.call(tests.u('memberA'), 'reject_quote', pg_temp.qid('qA-app')) ->> 'reason', 'not_submitted', 'R-004-16 承認済みは不成立にさせない');
select is(pg_temp.call(tests.u('memberA'), 'reject_quote', pg_temp.qid('qS3')) ->> 'ok', 'true', 'R-004-16 理由は空でもよい');
select is(pg_temp.field('qS3', 'decision_note'), null, 'R-004-16 理由なしならば、理由は空');

-- ===== R-004-17 承認のお知らせ =====
-- qA-sub は memberA が承認した。受け取るのは、amount.read を持つ所属（adminA と multi。承認した memberA 本人・スタッフ・外部は除く）
select is((select count(*)::int from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qA-sub') and channel = 'app'), 2, 'R-004-17 承認すると、金額を見られる所属（本人を除く）に一覧のお知らせを作る');
select is((select string_agg(membership_id::text, ',' order by membership_id::text) from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qA-sub') and channel = 'app'),
          (select string_agg(x, ',' order by x) from unnest(array[tests.id('m:A:adminA')::text, tests.id('m:A:multi')::text]) x), 'R-004-17 受け取るのは 管理者と、もう一人の社員だけ');
select is((select count(*)::int from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qA-sub') and kind = 'quote_approved' and status = 'pending'), 2, 'R-004-17 メールは「送る前」で作る（種類の初めの値がメール入）');
select is((select count(*)::int from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qA-sub') and membership_id in (tests.id('m:A:staffA'), tests.id('m:A:extA'), tests.id('m:A:memberA'))), 0, 'R-004-17 スタッフ・外部・承認した本人には作らない');
select is((select count(*)::int from public.notifications where tenant_id = tests.t('B') and dedupe_key = 'quote_approved:' || tests.id('qA-sub')), 0, 'R-004-17 別の会社には作らない');
select is((select link from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qA-sub') and channel = 'app' limit 1), '/quotes/edit/?id=' || tests.id('qA-sub'), 'R-004-17 リンクは見積の画面');
select is((select title from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qA-sub') and channel = 'app' limit 1), '見積が承認されました：Q-2025-0001', 'R-004-17 題名に見積の番号が入る');
select pg_temp.call(tests.u('memberA'), 'approve_quote', pg_temp.qid('qA-sub'));
select is((select count(*)::int from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qA-sub')), 4, 'R-004-17 二度承認を呼んでも、お知らせは増えない');
select is((select count(*)::int from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qS2') or dedupe_key = 'quote_approved:' || tests.id('qS3')), 0, 'R-004-17 不成立ではお知らせを作らない');
select is(pg_temp.call(tests.u('adminA'), 'approve_quote', pg_temp.qid('qS1')) ->> 'ok', 'true', '（準備）管理者が別の見積を承認する');
select is((select string_agg(membership_id::text, ',' order by membership_id::text) from public.notifications where dedupe_key = 'quote_approved:' || tests.id('qS1') and channel = 'app'),
          (select string_agg(x, ',' order by x) from unnest(array[tests.id('m:A:memberA')::text, tests.id('m:A:multi')::text]) x), 'R-004-17 管理者が承認したときは、本人（管理者）を除いた社員が受け取る');

-- ===== R-004-18 承認・不成立のあと =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set note = 'x' where id = %L$q$, tests.id('qA-sub'))), 0::bigint, 'R-004-18 承認した見積は直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quotes set note = 'x' where id = %L$q$, tests.id('qS2'))), 0::bigint, 'R-004-18 不成立の見積は直せない');
select is(pg_temp.call(tests.u('memberA'), 'reject_quote', pg_temp.qid('qA-sub')) ->> 'reason', 'not_submitted', 'R-004-18 承認した見積を不成立に戻せない');
select is(pg_temp.call(tests.u('memberA'), 'approve_quote', pg_temp.qid('qS2')) ->> 'reason', 'not_submitted', 'R-004-18 不成立の見積を承認に戻せない');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', pg_temp.qid('qS2')) ->> 'reason', 'not_draft', 'R-004-18 不成立の見積を、もう一度提出できない');

-- ===== R-004-19 直す（新しい版） =====
select is(pg_temp.call(tests.u('memberA'), 'revise_quote', pg_temp.qid('qA-subOther')) ->> 'ok', 'true', 'R-004-19 提出済みの見積から、直した版（下書き）を作れる');
create temp table _rev (id uuid) on commit drop;
insert into _rev select id from public.quotes where previous_id = tests.id('qA-subOther');
select is((select count(*)::int from _rev), 1, 'R-004-19 新しい下書きが1つできる');
select is((select status || '/' || coalesce(number, 'null') || '/' || subtotal::text from public.quotes where id = (select id from _rev)), 'draft/null/0', 'R-004-19 新しい版は番号なしの下書き（合計はまだ 0）');
select is((select client_id::text || building_id::text || kind || tax_rate::text from public.quotes where id = (select id from _rev)),
          (select client_id::text || building_id::text || kind || tax_rate::text from public.quotes where id = tests.id('qA-subOther')), 'R-004-19 取引先・建物・種類・税率を引き継ぐ');
select is((select count(*)::int from public.quote_lines where quote_id = (select id from _rev) and deleted_at is null), 2, 'R-004-19 明細も写す');
select is((select string_agg(name || qty::text || unit_price::text || coalesce(recurrence, '-'), ',' order by sort) from public.quote_lines where quote_id = (select id from _rev)),
          (select string_agg(name || qty::text || unit_price::text || coalesce(recurrence, '-'), ',' order by sort) from public.quote_lines where quote_id = tests.id('qA-subOther')), 'R-004-19 明細の中身（品名・数量・単価・繰り返し）が同じ');
select is((select count(*)::int from public.quote_lines where quote_id = tests.id('qA-subOther') and deleted_at is null), 2, 'R-004-19 元の版は変わらない');
select is(pg_temp.call(tests.u('memberA'), 'revise_quote', pg_temp.qid('qA-subOther')) ->> 'already', 'true', 'R-004-19 同じ元からの下書きは1つだけ（もう一度呼ぶと、その下書きを返す）');
select is(pg_temp.call(tests.u('memberA'), 'revise_quote', pg_temp.qid('qA-subOther')) ->> 'id', (select id::text from _rev), 'R-004-19 返す id は、できている下書き');
select is(pg_temp.call(tests.u('memberA'), 'revise_quote', pg_temp.qid('qA-app')) ->> 'reason', 'not_revisable', 'R-004-19 承認済みの見積からは作らせない');
select is(pg_temp.call(tests.u('memberA'), 'revise_quote', pg_temp.qid('qD1')) ->> 'reason', 'not_revisable', 'R-004-19 下書きからは作らせない（下書きは直接直す）');
select is(pg_temp.call(tests.u('memberA'), 'revise_quote', pg_temp.qid('qA-rej')) ->> 'ok', 'true', 'R-004-19 不成立の見積からも、直した版を作れる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.quote_lines set qty = 3 where quote_id = %L$q$, (select id from _rev))), 2::bigint, 'R-004-19 直した版（下書き）の明細は直せる');

-- ===== R-004-20 直した版を提出する =====
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', quote_literal((select id::text from _rev))) ->> 'ok', 'true', 'R-004-20 直した版を提出できる');
select is(pg_temp.field('qA-subOther', 'status') || '/' || pg_temp.field('qA-subOther', 'decision_note'), 'rejected/改訂版に置き換え', 'R-004-20 提出のままだった元の版は、不成立（理由：改訂版に置き換え）になる');
select is((select subtotal from public.quotes where id = (select id from _rev)), 126000::bigint, 'R-004-20 直した版の合計は、直した明細で計算する（(30000+12000)×3）');
select is(pg_temp.call(tests.u('memberA'), 'revise_quote', pg_temp.qid('qA-subOther')) ->> 'reason', 'already_revised', 'R-004-19 直した版がすでに提出されている元からは、さらに直せない（新しい版から直す）');
-- 元がすでに不成立のとき、その状況は変えない
create temp table _rev2 (id uuid) on commit drop;
insert into _rev2 select id from public.quotes where previous_id = tests.id('qA-rej');
select is(pg_temp.call(tests.u('memberA'), 'submit_quote', quote_literal((select id::text from _rev2))) ->> 'ok', 'true', '（準備）不成立だった見積の直した版を提出する');
select is(pg_temp.field('qA-rej', 'status') || '/' || coalesce(pg_temp.field('qA-rej', 'decision_note'), 'null'), 'rejected/null', 'R-004-20 元がもう不成立ならば、そのまま（理由も変えない）');

-- ===== R-004-21 権限のない人 =====
create or replace function pg_temp.rpc_blocked(p_uid uuid) returns text language plpgsql as $$
declare v text := ''; e text; fn text;
begin
  foreach fn in array array['submit_quote', 'approve_quote', 'reject_quote', 'revise_quote'] loop
    e := case when p_uid is null then tests.run_as_anon(format('select public.%I(%L)', fn, tests.id('qR4'))) ->> 'error'
              else pg_temp.callerr(p_uid, fn, pg_temp.qid('qR4')) end;
    if e is distinct from '42501' then v := v || fn || ':' || coalesce(e, 'ok') || ','; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.rpc_blocked(tests.u('staffA')), '', 'R-004-21 スタッフは、提出・承認・不成立・直すを呼べない');
select is(pg_temp.rpc_blocked(tests.u('extA')), '', 'R-004-21 外部の人は、4つの RPC を呼べない');
select is(pg_temp.rpc_blocked(tests.u('operator')), '', 'R-004-21 運営は（許可がなくても）4つの RPC を呼べない');
select is(pg_temp.rpc_blocked(tests.u('nobody')), '', 'R-004-21 どの会社にも属さない人は、4つの RPC を呼べない');
select is(pg_temp.rpc_blocked(null), '', 'R-004-21 ログインしていない人は、4つの RPC を呼べない');
select is(pg_temp.field('qR4', 'status'), 'submitted', 'R-004-21 呼べなかったあとも、見積は変わらない');
create temp table _w4 (n int, label text, ins text, upd text) on commit drop;
insert into _w4 values
  (1, 'items', format($q$insert into public.items (tenant_id, name, kind) values (%L, 'x4', 'base')$q$, tests.t('A')), format($q$update public.items set unit_price = 1 where id = %L$q$, tests.id('itemA-base'))),
  (2, 'quotes', format($q$insert into public.quotes (tenant_id, client_id, building_id, kind) values (%L, %L, %L, 'request')$q$, tests.t('A'), tests.id('clientA4'), tests.id('buildingA4')), format($q$update public.quotes set note = 'z' where id = %L$q$, tests.id('qNew'))),
  (3, 'quote_lines', format($q$insert into public.quote_lines (tenant_id, quote_id, line_kind, name, qty, unit_price) values (%L, %L, 'base', 'x', 1, 1)$q$, tests.t('A'), tests.id('qNew')), format($q$update public.quote_lines set qty = 9 where id = %L$q$, tests.id('ln:qA-draft:1')));
create or replace function pg_temp.blocked4(p_uid uuid) returns text language plpgsql as $$
declare r record; v text := ''; e text; c bigint;
begin
  for r in select * from _w4 order by n loop
    e := case when p_uid is null then tests.run_as_anon(r.ins) ->> 'error' else tests.err(p_uid, r.ins) end;
    if e is null then v := v || r.label || ':insert,'; end if;
    if p_uid is null then e := tests.run_as_anon(r.upd) ->> 'error'; c := 0;
    else e := tests.err(p_uid, r.upd); c := tests.cnt(p_uid, r.upd); end if;
    if e is null and c > 0 then v := v || r.label || ':update,'; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.blocked4(tests.u('staffA')), '', 'R-004-21 スタッフは、3つの表のどれも作れず・直せない');
select is(pg_temp.blocked4(tests.u('extA')), '', 'R-004-21 外部の人は、3つの表のどれも作れず・直せない');
select is(pg_temp.blocked4(tests.u('operator')), '', 'R-004-21 運営は、3つの表のどれも作れず・直せない');
select is(pg_temp.blocked4(tests.u('nobody')), '', 'R-004-21 どの会社にも属さない人は、3つの表のどれも作れず・直せない');
select is(pg_temp.blocked4(null), '', 'R-004-21 ログインしていない人は、3つの表のどれも作れず・直せない');
select is(pg_temp.blocked4(tests.u('adminA')), 'items:insert,items:update,quotes:insert,quotes:update,quote_lines:insert,quote_lines:update,', '（対照）管理者は3つの表とも作れて直せる');

-- ===== R-004-22 読める人 =====
select ok(tests.n(tests.u('memberA'), 'select 1 from public.quotes') >= 8, 'R-004-22 社員は見積を読める');
select ok(tests.n(tests.u('adminA'), 'select 1 from public.quote_lines') >= 8, 'R-004-22 管理者は明細を読める');
select ok(tests.n(tests.u('memberA'), 'select 1 from public.items') >= 2, 'R-004-22 社員は品名の候補を読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.quotes'), 0::bigint, 'R-004-22 スタッフは見積を読めない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.quote_lines'), 0::bigint, 'R-004-22 スタッフは明細を読めない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.items'), 0::bigint, 'R-004-22 スタッフは品名の候補を読めない');
select is(tests.n(tests.u('operator'), 'select 1 from public.quotes'), 0::bigint, 'R-004-22 運営は、許可がなければ見積を読めない');

-- ===== R-004-23 外部の人 =====
insert into public.external_building_access (tenant_id, membership_id, building_id) values (tests.t('A'), tests.id('m:A:extA'), tests.id('buildingA4'));
select is(tests.n(tests.u('extA'), 'select 1 from public.quotes'), (select count(*)::bigint from public.quotes where tenant_id = tests.t('A') and building_id in (tests.id('buildingA4'), tests.id('buildingA1')) and status in ('submitted', 'approved') and deleted_at is null),
          'R-004-23 外部の人は、許された建物の、提出・承認の見積だけを読める');
select ok(tests.n(tests.u('extA'), 'select 1 from public.quotes') >= 3, '（前提）読める見積が1つ以上ある');
select is(tests.n(tests.u('extA'), 'select 1 from public.quotes where status in (''draft'', ''rejected'')'), 0::bigint, 'R-004-23 下書き・不成立の見積は読めない');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.quotes where building_id = %L$q$, tests.id('buildingA2'))), 0::bigint, 'R-004-23 許されていない建物の見積は読めない');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.quote_lines where quote_id = %L$q$, tests.id('qA-app'))), 2::bigint, 'R-004-23 読める見積の明細は読める');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.quote_lines where quote_id in (%L, %L, %L)$q$, tests.id('qA-rej'), tests.id('qA-draft'), tests.id('qA-subOther'))), 0::bigint, 'R-004-23 読めない見積の明細は読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.items'), 0::bigint, 'R-004-23 外部の人は品名の候補を読めない');
select is(tests.cnt(tests.u('extA'), format($q$update public.quotes set note = 'x' where id = %L$q$, tests.id('qA-app'))), 0::bigint, 'R-004-23 外部の人は書けない');
select is(tests.n(tests.u('extB'), 'select 1 from public.quotes where tenant_id = ''' || tests.t('A') || ''''), 0::bigint, 'R-004-23 別の会社の外部の人は、A の見積を読めない');
update public.quotes set deleted_at = now() where id = tests.id('qA-app');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.quotes where id = %L$q$, tests.id('qA-app'))), 0::bigint, 'R-004-23 消した見積は、外部の人に見せない');
update public.quotes set deleted_at = null where id = tests.id('qA-app');

-- ===== R-004-24 別の会社 =====
select is(tests.n(tests.u('adminB'), format($q$select 1 from public.quotes where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-004-24 B の管理者は、A の見積を読めない');
select is(tests.n(tests.u('adminB'), format($q$select 1 from public.quote_lines where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-004-24 B の管理者は、A の明細を読めない');
select is(tests.n(tests.u('adminB'), format($q$select 1 from public.items where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-004-24 B の管理者は、A の品名の候補を読めない');
select is(tests.cnt(tests.u('adminB'), format($q$update public.quotes set note = 'x' where id = %L$q$, tests.id('qA-draft'))), 0::bigint, 'R-004-24 B の管理者は、A の見積を直せない');
select is(pg_temp.callerr(tests.u('adminB'), 'submit_quote', pg_temp.qid('qNew')), '42501', 'R-004-24 B の管理者は、A の見積を提出できない');
select is(pg_temp.callerr(tests.u('adminB'), 'approve_quote', pg_temp.qid('qA-subOther')), '42501', 'R-004-24 承認も効かない');
select is(pg_temp.callerr(tests.u('adminB'), 'revise_quote', pg_temp.qid('qA-app')), '42501', 'R-004-24 直すも効かない');
select is(pg_temp.callerr(tests.u('adminB'), 'submit_quote', quote_literal(tests.id('nothing'))), '42501', 'R-004-24 見つからない見積も、同じ 42501（存在を探らせない）');
select is(pg_temp.callerr(tests.u('adminA'), 'submit_quote', quote_literal(tests.id('nothing'))), '42501', 'R-004-24 見つからない見積は、A の管理者にも 42501');
select is(tests.err(tests.u('adminB'), format($q$insert into public.quotes (tenant_id, client_id, building_id, kind) values (%L, %L, %L, 'request')$q$, tests.t('A'), tests.id('clientA4'), tests.id('buildingA4'))), '42501', 'R-004-24 B の管理者は、A の会社として見積を作れない');

-- ===== R-004-25 履歴 =====
select is((select count(*)::int from public.audit_logs where table_name = 'quotes' and row_id = tests.id('qNew') and action = 'insert' and actor = tests.u('memberA') and source = 'ui'), 1, 'R-004-25 見積を作ると、履歴に残る（source は ui）');
select is((select count(*)::int from public.audit_logs where table_name = 'quotes' and row_id = tests.id('qS1') and action = 'update' and source = 'rpc' and changed -> 'status' ->> 'new' = 'submitted'), 1, 'R-004-25 提出は、source が rpc の履歴に残る');
select is((select count(*)::int from public.audit_logs where table_name = 'quotes' and row_id = tests.id('qS2') and action = 'update' and source = 'rpc' and changed -> 'status' ->> 'new' = 'rejected'), 1, 'R-004-25 不成立は、source が rpc の履歴に残る');
select is((select count(*)::int from public.audit_logs where table_name = 'quote_lines' and row_id = tests.id('lnNew') and action = 'update' and changed ? 'deleted_at' and source = 'ui'), 1, 'R-004-25 明細の変更も履歴に残る');
select is((select count(*)::int from public.audit_logs where table_name = 'items' and row_id = tests.id('itemA-base') and action = 'update' and changed -> 'unit_price' ->> 'new' = '31000'), 1, 'R-004-25 品名の候補の変更も履歴に残る');
select is((select count(*)::int from pg_trigger where tgname = 'tp_audit' and tgrelid in ('public.items'::regclass, 'public.quotes'::regclass, 'public.quote_lines'::regclass)), 3, 'R-004-25 3つの表すべてに履歴のトリガーがある');
select is((select count(*)::int from public.audit_logs where table_name = 'quotes' and row_id = (select id from _rev) and action = 'insert' and source = 'rpc'), 1, 'R-004-25 直す RPC で作った見積も、source が rpc で残る');

-- ===== R-004-26 取引先・建物の削除を止める =====
select is((select string_agg(b ->> 'reason', ',' order by b ->> 'reason') from jsonb_array_elements(pg_temp.call(tests.u('memberA'), 'delete_client', pg_temp.qid('clientA4')) -> 'blockers') b), 'has_buildings,has_quotes', 'R-004-26 見積がある取引先は、消さない（理由 has_quotes）');
select ok((select (b ->> 'count')::int >= 5 from jsonb_array_elements(pg_temp.call(tests.u('memberA'), 'delete_client', pg_temp.qid('clientA4')) -> 'blockers') b where b ->> 'reason' = 'has_quotes'), 'R-004-26 理由に件数が付く');
select is((select string_agg(b ->> 'reason', ',') from jsonb_array_elements(pg_temp.call(tests.u('memberA'), 'delete_building', pg_temp.qid('buildingA4')) -> 'blockers') b), 'has_quotes', 'R-004-26 見積がある建物は、消さない（理由 has_quotes）');
update public.quotes set deleted_at = now() where building_id = tests.id('buildingA4');
select is(pg_temp.call(tests.u('memberA'), 'delete_building', pg_temp.qid('buildingA4')) ->> 'ok', 'true', 'R-004-26 見積が消されていれば、建物を消せる');

select * from finish();
rollback;
