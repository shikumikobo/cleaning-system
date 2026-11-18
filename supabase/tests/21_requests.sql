-- 機能 003：案件（R-003-1〜31。R-003-23・27〜29 は単体のテスト）
begin;
select * from no_plan();
select tests.seed();

-- 便利
create or replace function pg_temp.rpc1(p_uid uuid, p_sql text) returns jsonb language sql as $$
  select tests.run_as(p_uid, p_sql) -> 'rows' -> 0 -> 'r'
$$;
-- 状況を from にしてから、その人として set_request_status を呼ぶ。結果と、呼んだあとの状況を返す
create or replace function pg_temp.st(p_uid uuid, p_req uuid, p_from text, p_to text) returns jsonb language plpgsql as $$
declare res jsonb; s text;
begin
  update public.requests set status = p_from where id = p_req;
  res := tests.run_as(p_uid, format('select public.set_request_status(%L, %L) as r', p_req, p_to));
  select status into s from public.requests where id = p_req;
  return jsonb_build_object('r', res -> 'rows' -> 0 -> 'r', 'error', res ->> 'error', 'status', s);
end $$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Tokyo')::date $$;

-- ===== R-003-1 案件の登録 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.requests (id, tenant_id, client_id, building_id, title)
  values (%L, %L, %L, %L, '電話で受けた依頼')$q$, tests.id('n1'), tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), 1::bigint, 'R-003-1 社員は建物・依頼元・題名だけで案件を登録できる');
select is((select status || ',' || source || ',' || category from public.requests where id = tests.id('n1')), 'new,manual,other', 'R-003-1 初めは「受付」・入口は手で登録・分類はその他');
select is(tests.cnt(tests.u('adminA'), format($q$insert into public.requests (tenant_id, client_id, building_id, room_id, source, category, title, detail, due_date, assignee_id)
  values (%L, %L, %L, %L, 'phone', 'repair', '水漏れ', '2階の廊下', %L, %L)$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'), tests.id('roomA1'), pg_temp.today() + 5, tests.id('m:A:staffA'))), 1::bigint,
  'R-003-1 管理者は、部屋・期限・担当・分類・入口・内容も付けて登録できる');

-- ===== R-003-2 登録の検査 =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, '')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '23514', 'R-003-2 題名が空なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, '   ')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '23514', 'R-003-2 題名が空白だけなら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, %L)$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'), repeat('あ', 101))), '23514', 'R-003-2 題名が100字を超えるなら保存しない');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, %L)$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'), repeat('あ', 100))), 1::bigint, 'R-003-2 題名が100字ちょうどなら保存できる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title, category) values (%L, %L, %L, 'x', 'unknown')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '23514', 'R-003-2 分類が決まった値以外なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title, source) values (%L, %L, %L, 'x', 'unknown')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '23514', 'R-003-2 入口が決まった値以外なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title, status) values (%L, %L, %L, 'x', 'done')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '42501', 'R-003-2 「受付」以外の状況では作らせない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title, status) values (%L, %L, %L, 'x', 'bogus')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '42501', 'R-003-2 知らない状況の値でも作らせない');
select is((select count(*) from public.requests where title = 'x'), 0::bigint, 'R-003-2 断ったものは保存されていない');

-- ===== R-003-3 別の会社を指さない・担当は社内の人 =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('clientB1'), tests.id('buildingA1'))), '23503', 'R-003-3 別の会社の取引先を指す案件は受け付けない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingB1'))), '23503', 'R-003-3 別の会社の建物を指す案件は受け付けない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, room_id, title) values (%L, %L, %L, %L, 'x')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'), tests.id('roomB1'))), '23503', 'R-003-3 別の会社の部屋を指す案件は受け付けない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title, assignee_id) values (%L, %L, %L, 'x', %L)$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'), tests.id('m:B:staffB'))), '42501', 'R-003-3 別の会社の人は担当にできない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title, assignee_id) values (%L, %L, %L, 'x', %L)$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'), tests.id('m:A:extA'))), '42501', 'R-003-3 外部の人は担当にできない');
select is(tests.err(tests.u('memberA'), format($q$update public.requests set assignee_id = %L where id = %L$q$, tests.id('m:A:extA'), tests.id('reqA-3'))), '42501', 'R-003-3 直すときも、外部の人は担当にできない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.requests set assignee_id = %L where id = %L$q$, tests.id('m:A:staffA'), tests.id('reqA-3'))), 1::bigint, 'R-003-3 スタッフは担当にできる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.requests set assignee_id = null where id = %L$q$, tests.id('reqA-3'))), 1::bigint, 'R-003-3 担当を空にもできる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.requests set assignee_id = %L where id = %L$q$, tests.id('m:A:memberA'), tests.id('reqA-3'))), 1::bigint, '（準備）担当を社員 A に戻す');

-- ===== R-003-4 直せる人・直せない人 =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.requests set title = '共用部の電球交換（2か所）', detail = '3階と4階', due_date = %L, category = 'repair' where id = %L$q$, pg_temp.today() + 1, tests.id('reqA-1'))), 1::bigint, 'R-003-4 社員は案件の中身を直せる');
select is(tests.cnt(tests.u('adminA'), format($q$update public.requests set building_id = %L where id = %L$q$, tests.id('buildingA1'), tests.id('reqA-3'))), 1::bigint, 'R-003-4 管理者は建物も直せる');
select is(tests.err(tests.u('staffA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '42501', 'R-003-4 スタッフは案件を直接作れない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.requests set title = '書き換え' where id = %L$q$, tests.id('reqA-1'))), 0::bigint, 'R-003-4 スタッフは、担当の案件でも中身を直せない');
select is(tests.err(tests.u('extA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '42501', 'R-003-4 外部の人は案件を作れない');
select is(tests.cnt(tests.u('extA'), format($q$update public.requests set title = '書き換え' where id = %L$q$, tests.id('reqA-1'))), 0::bigint, 'R-003-4 外部の人は案件を直せない');
select is(tests.err(tests.u('operator'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '42501', 'R-003-4 運営は案件を作れない');
select is(tests.err(tests.u('adminB'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '42501', 'R-003-4 別の会社の管理者は、この会社に案件を作れない');
select is(tests.run_as_anon(format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, 'x')$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))) ->> 'error', '42501', 'R-003-4 ログインしていない人は案件を作れない');
select is(tests.run_as_anon(format($q$update public.requests set title = 'x' where id = %L$q$, tests.id('reqA-1'))) ->> 'error', '42501', 'R-003-4 ログインしていない人は案件を直せない');
select is((select title from public.requests where id = tests.id('reqA-1')), '共用部の電球交換（2か所）', 'R-003-4 直せない人の書き込みは、反映されていない');

-- ===== R-003-5 状況と deleted_at は画面から書けない =====
select is(tests.err(tests.u('adminA'), format($q$update public.requests set status = 'done' where id = %L$q$, tests.id('reqA-1'))), '42501', 'R-003-5 管理者も、状況を直接書き換えられない');
select is(tests.err(tests.u('adminA'), format($q$update public.requests set deleted_at = now() where id = %L$q$, tests.id('reqA-1'))), '42501', 'R-003-5 deleted_at を直接書き込めない');
select is(tests.err(tests.u('adminA'), format($q$delete from public.requests where id = %L$q$, tests.id('reqA-1'))), '42501', 'R-003-5 案件を消せない（delete の権限がない）');
select is(tests.err(tests.u('adminA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title, deleted_at) values (%L, %L, %L, 'x', now())$q$, tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'))), '42501', 'R-003-5 消えた行として作ることもできない');
select is((select status from public.requests where id = tests.id('reqA-1')), 'new', 'R-003-5 状況は変わっていない');

-- ===== R-003-6 履歴 =====
select ok((select count(*) from public.audit_logs where table_name = 'requests' and row_id = tests.id('n1') and action = 'insert') = 1, 'R-003-6 案件を作ると履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'requests' and row_id = tests.id('reqA-1') and action = 'update') >= 1, 'R-003-6 案件を直すと履歴に残る');

-- ===== R-003-7 読める人 =====
select is(tests.n(tests.u('adminA'), format($q$select 1 from public.requests where id in (%L, %L, %L, %L)$q$, tests.id('reqA-1'), tests.id('reqA-2'), tests.id('reqA-3'), tests.id('reqA-4'))), 4::bigint, 'R-003-7 管理者は会社の案件を全部読める');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.requests where id in (%L, %L, %L, %L)$q$, tests.id('reqA-1'), tests.id('reqA-2'), tests.id('reqA-3'), tests.id('reqA-4'))), 4::bigint, 'R-003-7 社員は会社の案件を全部読める');
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.requests where id = %L$q$, tests.id('reqA-2'))), 0::bigint, 'R-003-7 スタッフは、担当でない案件（担当なし）を読めない');
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.requests where tenant_id = %L and assignee_id is distinct from %L$q$, tests.t('A'), tests.id('m:A:staffA'))), 0::bigint, 'R-003-7 スタッフが読める行はすべて自分が担当');
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.requests where id in (%L, %L)$q$, tests.id('reqA-1'), tests.id('reqA-4'))), 2::bigint, 'R-003-7 スタッフは担当の案件を読める（完了のものも）');
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.requests where id = %L$q$, tests.id('reqA-3'))), 0::bigint, 'R-003-7 他人の担当の案件は読めない');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.requests where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-003-7 外部の人は案件を読めない');
select is(tests.n(tests.u('adminB'), format($q$select 1 from public.requests where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-003-7 別の会社の管理者は読めない');
select is(tests.n(tests.u('operator'), format($q$select 1 from public.requests where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-003-7 運営は、許可のない間は読めない');
select is(tests.run_as_anon('select 1 from public.requests') ->> 'error', '42501', 'R-003-7 ログインしていない人は読めない');

-- ===== R-003-8 状況の切り替え（request.edit） =====
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'new', 'in_progress') ->> 'status', 'in_progress', 'R-003-8 受付 → 対応中');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'new', 'done') ->> 'status', 'done', 'R-003-8 受付 → 完了');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'new', 'cancelled') ->> 'status', 'cancelled', 'R-003-8 受付 → 取消');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'in_progress', 'new') ->> 'status', 'new', 'R-003-8 対応中 → 受付');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'in_progress', 'done') ->> 'status', 'done', 'R-003-8 対応中 → 完了');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'in_progress', 'cancelled') ->> 'status', 'cancelled', 'R-003-8 対応中 → 取消');
select is(pg_temp.st(tests.u('adminA'), tests.id('reqA-3'), 'done', 'in_progress') ->> 'status', 'in_progress', 'R-003-8 完了 → 対応中（管理者）');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'cancelled', 'new') ->> 'status', 'new', 'R-003-8 取消 → 受付');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'new', 'in_progress') -> 'r' ->> 'changed', 'true', 'R-003-8 切り替えたとき、changed が真');

-- ===== R-003-9 許されない切り替え =====
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'done', 'cancelled') ->> 'status', 'done', 'R-003-9 完了 → 取消は、状況を変えない');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'done', 'cancelled') -> 'r' ->> 'reason', 'invalid_transition', 'R-003-9 理由 invalid_transition を返す');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'cancelled', 'done') ->> 'status', 'cancelled', 'R-003-9 取消 → 完了は、状況を変えない');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'cancelled', 'in_progress') ->> 'status', 'cancelled', 'R-003-9 取消 → 対応中は、状況を変えない');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'done', 'new') ->> 'status', 'done', 'R-003-9 完了 → 受付は、状況を変えない');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'new', 'bogus') ->> 'error', '22023', 'R-003-9 知らない状況の値は断る');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'new', 'bogus') ->> 'status', 'new', 'R-003-9 断ったあとも状況は同じ');

-- ===== R-003-10 同じ状況は何もしない =====
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'in_progress', 'in_progress') -> 'r' ->> 'ok', 'true', 'R-003-10 同じ状況を指定してもエラーにならない');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'in_progress', 'in_progress') -> 'r' ->> 'changed', 'false', 'R-003-10 changed は偽');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-3'), 'done', 'done') ->> 'status', 'done', 'R-003-10 完了を完了にしても、そのまま');

-- ===== R-003-11 担当のスタッフの切り替え =====
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-1'), 'new', 'in_progress') ->> 'status', 'in_progress', 'R-003-11 担当のスタッフ：受付 → 対応中');
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-1'), 'new', 'done') ->> 'status', 'done', 'R-003-11 担当のスタッフ：受付 → 完了');
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-1'), 'in_progress', 'done') ->> 'status', 'done', 'R-003-11 担当のスタッフ：対応中 → 完了');
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-1'), 'new', 'cancelled') -> 'r' ->> 'reason', 'forbidden_transition', 'R-003-11 スタッフは取消にできない');
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-1'), 'new', 'cancelled') ->> 'status', 'new', 'R-003-11 取消にできないとき、状況は同じ');
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-1'), 'in_progress', 'new') ->> 'status', 'in_progress', 'R-003-11 スタッフは戻せない（対応中 → 受付）');
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-1'), 'done', 'in_progress') ->> 'status', 'done', 'R-003-11 スタッフは戻せない（完了 → 対応中）');
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-2'), 'new', 'in_progress') ->> 'error', '42501', 'R-003-11 担当でない案件は、スタッフに切り替えさせない');
select is(pg_temp.st(tests.u('staffA'), tests.id('reqA-3'), 'new', 'in_progress') ->> 'status', 'new', 'R-003-11 他人が担当の案件の状況は変わらない');
select is(pg_temp.st(tests.u('staffB'), tests.id('reqA-1'), 'new', 'in_progress') ->> 'error', '42501', 'R-003-11 別の会社のスタッフは切り替えられない');

-- ===== R-003-12 見つからない・権限がない =====
select is(pg_temp.st(tests.u('memberA'), tests.id('reqB-1'), 'new', 'in_progress') ->> 'error', '42501', 'R-003-12 別の会社の案件は、42501 で断る');
select is(tests.err(tests.u('memberA'), format($q$select public.set_request_status(%L, 'done')$q$, tests.id('no-such-request'))), '42501', 'R-003-12 見つからない案件も、同じ 42501');
select is(pg_temp.st(tests.u('extA'), tests.id('reqA-1'), 'new', 'in_progress') ->> 'error', '42501', 'R-003-12 外部の人は切り替えられない');
select is(pg_temp.st(tests.u('nobody'), tests.id('reqA-1'), 'new', 'in_progress') ->> 'error', '42501', 'R-003-12 どの会社にも属さない人は切り替えられない');
select is(tests.run_as_anon(format($q$select public.set_request_status(%L, 'done')$q$, tests.id('reqA-1'))) ->> 'error', '42501', 'R-003-12 ログインしていない人は切り替えられない');

-- ===== R-003-13 請求済みなら取消にさせない =====
-- 請求書の明細（011）に載せる（この transaction の中だけ。管理者の権限で作る）
insert into public.invoices (id, tenant_id, client_id, period) values (tests.id('inv-r1'), tests.t('A'), tests.id('clientA1'), date '2031-01-01');
insert into public.invoice_lines (id, tenant_id, invoice_id, request_id, name, unit_price) values (tests.id('il-1'), tests.t('A'), tests.id('inv-r1'), tests.id('reqA-1'), '案件の金額', 5000);
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-1'), 'new', 'cancelled') -> 'r' ->> 'reason', 'billed', 'R-003-13 請求書に載った金額がある案件は、取消にさせない');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-1'), 'new', 'cancelled') ->> 'status', 'new', 'R-003-13 取消にならず、状況は同じ');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-1'), 'new', 'done') ->> 'status', 'done', 'R-003-13 請求済みでも、完了にはできる');
update public.invoice_lines set deleted_at = now() where id = tests.id('il-1');
select is(pg_temp.st(tests.u('memberA'), tests.id('reqA-1'), 'new', 'cancelled') ->> 'status', 'cancelled', 'R-003-13 明細が取り消されたら、取消にできる');
update public.requests set status = 'new' where id = tests.id('reqA-1');
update public.invoice_lines set deleted_at = null where id = tests.id('il-1');

-- ===== R-003-14 気づきから案件を作る =====
select is(pg_temp.rpc1(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, '廊下の天井にしみ', '3階の北側', null, 'repair') as r$q$, tests.id('obs1'), tests.id('buildingA1'))) ->> 'ok', 'true', 'R-003-14 スタッフは気づきから案件を作れる');
select is((select source || ',' || status || ',' || category || ',' || client_id::text || ',' || assignee_id::text from public.requests where id = tests.id('obs1')),
  'field,new,repair,' || tests.id('clientA1')::text || ',' || tests.id('m:A:staffA')::text, 'R-003-14 入口は現場の気づき・受付・依頼元は建物の依頼元・担当は本人');
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.requests where id = %L$q$, tests.id('obs1'))), 1::bigint, 'R-003-14 作ったスタッフは、その案件を読める');
select is(tests.n(tests.u('staffB'), format($q$select 1 from public.requests where id = %L$q$, tests.id('obs1'))), 0::bigint, 'R-003-14 ほかの会社のスタッフには読めない');
select is(pg_temp.rpc1(tests.u('memberA'), format($q$select public.create_request_from_observation(%L, %L, '社員の気づき') as r$q$, tests.id('obs2'), tests.id('buildingA2'))) ->> 'ok', 'true', 'R-003-14 社員（field.record あり）も作れる');
select is((select category from public.requests where id = tests.id('obs2')), 'other', 'R-003-14 分類を省くと「その他」');
select is(pg_temp.rpc1(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, '部屋つき', null, %L) as r$q$, tests.id('obs4'), tests.id('buildingA1'), tests.id('roomA1'))) ->> 'ok', 'true', 'R-003-14 その建物の部屋を付けられる');

-- ===== R-003-15 二度呼んでも1件 =====
select is(pg_temp.rpc1(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, '廊下の天井にしみ', '3階の北側', null, 'repair') as r$q$, tests.id('obs1'), tests.id('buildingA1'))) ->> 'already', 'true', 'R-003-15 同じ uuid の二度目は、前の結果（already）を返す');
select is((select count(*) from public.requests where id = tests.id('obs1')), 1::bigint, 'R-003-15 案件は1件だけ');
select is(tests.err(tests.u('memberA'), format($q$select public.create_request_from_observation(%L, %L, 'のっとり')$q$, tests.id('obs1'), tests.id('buildingA1'))), '42501', 'R-003-15 別の人が作った uuid では呼べない');
select is(tests.err(tests.u('staffB'), format($q$select public.create_request_from_observation(%L, %L, 'のっとり')$q$, tests.id('obs1'), tests.id('buildingB1'))), '42501', 'R-003-15 別の会社の人が、この uuid を使うことはできない');
select is((select title from public.requests where id = tests.id('obs1')), '廊下の天井にしみ', 'R-003-15 前の案件は書き換わらない');

-- ===== R-003-16 作らせない場合 =====
select is(tests.err(tests.u('extA'), format($q$select public.create_request_from_observation(%L, %L, 'x')$q$, tests.id('obs3'), tests.id('buildingA1'))), '42501', 'R-003-16 外部の人は気づきから案件を作れない');
select is(tests.err(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, 'x')$q$, tests.id('obs3'), tests.id('buildingB1'))), '42501', 'R-003-16 別の会社の建物には作れない');
select is(tests.err(tests.u('nobody'), format($q$select public.create_request_from_observation(%L, %L, 'x')$q$, tests.id('obs3'), tests.id('buildingA1'))), '42501', 'R-003-16 どの会社にも属さない人は作れない');
select is(tests.run_as_anon(format($q$select public.create_request_from_observation(%L, %L, 'x')$q$, tests.id('obs3'), tests.id('buildingA1'))) ->> 'error', '42501', 'R-003-16 ログインしていない人は作れない');
select is(tests.err(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, 'x', null, %L)$q$, tests.id('obs3'), tests.id('buildingA2'), tests.id('roomA1'))), '22023', 'R-003-16 その建物にない部屋は指せない');
select is(tests.err(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, '')$q$, tests.id('obs3'), tests.id('buildingA1'))), '23514', 'R-003-16 題名が空なら作らない');
select is(tests.err(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, 'x', null, null, 'bogus')$q$, tests.id('obs3'), tests.id('buildingA1'))), '23514', 'R-003-16 分類が決まった値以外なら作らない');
update public.buildings set deleted_at = now() where id = tests.id('buildingA2');
select is(tests.err(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, 'x')$q$, tests.id('obs3'), tests.id('buildingA2'))), '42501', 'R-003-16 消した建物には作れない');
update public.buildings set deleted_at = null where id = tests.id('buildingA2');
select is((select count(*) from public.requests where id = tests.id('obs3')), 0::bigint, 'R-003-16 断ったものは作られていない');

-- ===== R-003-17 写真なしで作る（写真との つなぎは 008） =====
select is(pg_temp.rpc1(tests.u('staffA'), format($q$select public.create_request_from_observation(%L, %L, '写真なしの気づき') as r$q$, tests.id('obs5'), tests.id('buildingA1'))) ->> 'ok', 'true', 'R-003-17 写真を付けずに、気づきから案件を作れる');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_request_from_observation' and pg_get_function_arguments(p.oid) ~* 'p_photo_ids uuid\[\] DEFAULT NULL'), 1::bigint, 'R-003-17 写真の引数（p_photo_ids。省略できる）は 008 が足した。関数は1つだけ');

-- ===== R-003-18 金額 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.request_charges (tenant_id, request_id, amount, billable) values (%L, %L, 8000, true)$q$, tests.t('A'), tests.id('reqA-2'))), 1::bigint, 'R-003-18 社員は案件に金額を付けられる');
select is(tests.cnt(tests.u('adminA'), format($q$insert into public.request_charges (tenant_id, request_id, amount) values (%L, %L, 0)$q$, tests.t('A'), tests.id('reqA-3'))), 1::bigint, 'R-003-18 管理者は 0 円も付けられる');
select is((select billable from public.request_charges where request_id = tests.id('reqA-3')), true, 'R-003-18 請求するかの初めの値は「する」');
select is(tests.err(tests.u('memberA'), format($q$insert into public.request_charges (tenant_id, request_id, amount) values (%L, %L, 100)$q$, tests.t('A'), tests.id('reqA-2'))), '23505', 'R-003-18 1つの案件に2つ目の金額は付けられない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set amount = 9000, billable = false where request_id = %L$q$, tests.id('reqA-2'))), 1::bigint, 'R-003-18 金額を直せる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set deleted_at = now() where request_id = %L$q$, tests.id('reqA-2'))), 1::bigint, 'R-003-18 金額を消せる（論理削除）');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.request_charges (tenant_id, request_id, amount) values (%L, %L, 7000)$q$, tests.t('A'), tests.id('reqA-2'))), 1::bigint, 'R-003-18 消したあとは、新しい金額を付けられる');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.request_charges where request_id = %L$q$, tests.id('reqA-1'))), 1::bigint, 'R-003-18 金額を読める');

-- ===== R-003-19 金額を見られない人 =====
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.request_charges where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-003-19 スタッフは担当の案件の金額も読めない');
select is(tests.err(tests.u('staffA'), format($q$insert into public.request_charges (tenant_id, request_id, amount) values (%L, %L, 1)$q$, tests.t('A'), tests.id('n1'))), '42501', 'R-003-19 スタッフは金額を作れない');
select is(tests.cnt(tests.u('staffA'), format($q$update public.request_charges set amount = 1 where request_id = %L$q$, tests.id('reqA-4'))), 0::bigint, 'R-003-19 スタッフは金額を直せない');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.request_charges where tenant_id = %L$q$, tests.t('A'))), 0::bigint, 'R-003-19 外部の人は金額を読めない');
select is(tests.err(tests.u('extA'), format($q$insert into public.request_charges (tenant_id, request_id, amount) values (%L, %L, 1)$q$, tests.t('A'), tests.id('n1'))), '42501', 'R-003-19 外部の人は金額を作れない');
select is(tests.run_as_anon('select 1 from public.request_charges') ->> 'error', '42501', 'R-003-19 ログインしていない人は金額を読めない');

-- ===== R-003-20 金額の検査 =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.request_charges (tenant_id, request_id, amount) values (%L, %L, -1)$q$, tests.t('A'), tests.id('n1'))), '23514', 'R-003-20 負の金額は保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.request_charges (tenant_id, request_id, amount) values (%L, %L, 100)$q$, tests.t('A'), tests.id('reqB-1'))), '23503', 'R-003-20 別の会社の案件には付けられない');
select is(tests.err(tests.u('memberA'), format($q$update public.request_charges set request_id = %L where request_id = %L$q$, tests.id('n1'), tests.id('reqA-1'))), '42501', 'R-003-20 金額を別の案件に付け替えられない');
select is(tests.err(tests.u('memberA'), format($q$update public.request_charges set tenant_id = %L where request_id = %L$q$, tests.t('B'), tests.id('reqA-1'))), '42501', 'R-003-20 金額の会社を変えられない');
select is(tests.err(tests.u('memberA'), format($q$update public.request_charges set amount = -5 where request_id = %L$q$, tests.id('reqA-4'))), '23514', 'R-003-20 直すときも、負の金額は保存しない');

-- ===== R-003-21 請求書に載ったら直せない =====
update public.invoice_lines set deleted_at = now() where id = tests.id('il-1');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set amount = 5100 where request_id = %L$q$, tests.id('reqA-1'))), 1::bigint, 'R-003-21 invoice_lines に載っていない間は直せる');
update public.invoice_lines set deleted_at = null where id = tests.id('il-1');
select is(app.request_charge_locked(tests.t('A'), tests.id('reqA-1')), true, 'R-003-21 載っているか（関数）：載っている');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set amount = 5200 where request_id = %L$q$, tests.id('reqA-1'))), 0::bigint, 'R-003-21 請求書の明細に載った金額は直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set deleted_at = now() where request_id = %L$q$, tests.id('reqA-1'))), 0::bigint, 'R-003-21 請求書の明細に載った金額は消せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set billable = false where request_id = %L$q$, tests.id('reqA-1'))), 0::bigint, 'R-003-21 請求するかの印も直せない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set amount = 5100 where request_id = %L$q$, tests.id('reqA-4'))), 1::bigint, 'R-003-21 載っていない案件の金額は直せる');
select is((select amount from public.request_charges where request_id = tests.id('reqA-1')), 5100, 'R-003-21 載った金額は変わっていない');
update public.invoice_lines set deleted_at = now() where id = tests.id('il-1');
select is(tests.cnt(tests.u('memberA'), format($q$update public.request_charges set amount = 5200 where request_id = %L$q$, tests.id('reqA-1'))), 1::bigint, 'R-003-21 明細が取り消されたら、また直せる');
update public.invoice_lines set deleted_at = null where id = tests.id('il-1');
select is(app.request_charge_locked(tests.t('B'), tests.id('reqA-1')), false, 'R-003-21 別の会社の印では、載っていない扱い');

-- ===== R-003-22 金額の履歴 =====
select ok((select count(*) from public.audit_logs where table_name = 'request_charges' and action = 'insert') >= 1, 'R-003-22 金額を作ると履歴に残る');
select ok((select count(*) from public.audit_logs where table_name = 'request_charges' and action = 'update') >= 1, 'R-003-22 金額を直す・消すと履歴に残る');

-- ===== R-003-24〜26 期限のお知らせ =====
-- 見やすくするため、会社 A の既存の案件はすべて完了にし、新しく作る
update public.requests set status = 'done' where tenant_id = tests.t('A');
create or replace function pg_temp.mk(p_name text, p_due date, p_assignee text, p_status text default 'new') returns void language plpgsql as $$
begin
  insert into public.requests (id, tenant_id, client_id, building_id, title, due_date, assignee_id, status)
  values (tests.id(p_name), tests.t('A'), tests.id('clientA1'), tests.id('buildingA1'), p_name, p_due,
          case when p_assignee is null then null else tests.id('m:A:' || p_assignee) end, p_status);
end $$;
create or replace function pg_temp.notes(p_name text) returns bigint language sql as $$
  select count(*) from public.notifications where kind = 'request_due' and channel = 'app' and dedupe_key like 'request_due:' || tests.id(p_name)::text || ':%'
$$;
create or replace function pg_temp.notes_for(p_name text, p_member text) returns bigint language sql as $$
  select count(*) from public.notifications where kind = 'request_due' and channel = 'app' and dedupe_key like 'request_due:' || tests.id(p_name)::text || ':%'
    and membership_id = tests.id('m:A:' || p_member)
$$;
select pg_temp.mk('dueSoon', pg_temp.today() + 3, 'memberA');
select pg_temp.mk('dueToday', pg_temp.today(), 'memberA');
select pg_temp.mk('dueFar', pg_temp.today() + 4, 'memberA');
select pg_temp.mk('dueOver', pg_temp.today() - 1, 'staffA', 'in_progress');
select pg_temp.mk('dueNone', null, 'memberA');
select pg_temp.mk('dueDone', pg_temp.today() - 3, 'memberA', 'done');
select pg_temp.mk('dueCancel', pg_temp.today() - 3, 'memberA', 'cancelled');
select pg_temp.mk('dueNobody', pg_temp.today() - 5, null);
-- B の案件（期限切れ）
insert into public.requests (id, tenant_id, client_id, building_id, title, due_date, assignee_id)
values (tests.id('dueBx'), tests.t('B'), tests.id('clientB1'), tests.id('buildingB1'), 'B の期限切れ', pg_temp.today() - 4, tests.id('m:B:staffB'));

create temp table _run as select public.request_due_start(tests.t('A')) as id;
select isnt((select id from _run), null, 'R-003-26 処理の記録を始められる（service_role の関数）');
select is((select kind || ',' || status from public.job_runs where id = (select id from _run)), 'request_due,running', 'R-003-26 処理の記録は、種類 request_due・実行中で作られる');
select is(tests.run_as_service(format($q$select public.request_due_notify(%L, %L, 3) as r$q$, tests.t('A'), (select id from _run))) -> 'rows' -> 0 -> 'r' ->> 'requests', '4', 'R-003-24 対象の案件の数（近い・今日・切れ・担当なしの4件）');
select is(pg_temp.notes_for('dueSoon', 'memberA'), 1::bigint, 'R-003-24 3日後が期限の案件は、担当者に作る');
select is(pg_temp.notes_for('dueToday', 'memberA'), 1::bigint, 'R-003-24 今日が期限の案件も作る');
select is(pg_temp.notes('dueFar'), 0::bigint, 'R-003-24 4日後の期限は作らない');
select is(pg_temp.notes_for('dueOver', 'staffA'), 1::bigint, 'R-003-24 期限切れの案件は、担当者（スタッフ）に作る');
select is(pg_temp.notes('dueOver'), 1::bigint, 'R-003-24 担当者だけに作る');
select is(pg_temp.notes('dueNone'), 0::bigint, 'R-003-24 期限なしは作らない');
select is(pg_temp.notes('dueDone'), 0::bigint, 'R-003-24 完了は作らない');
select is(pg_temp.notes('dueCancel'), 0::bigint, 'R-003-24 取消は作らない');
select is(pg_temp.notes('dueNobody'), 3::bigint, 'R-003-24 担当のいない案件は、request.edit を持つ有効な所属の全員（3人）に作る');
select is(pg_temp.notes_for('dueNobody', 'staffA'), 0::bigint, 'R-003-24 request.edit を持たないスタッフには作らない');
select is((select count(*) from public.notifications n where n.kind = 'request_due' and n.channel = 'app' and n.dedupe_key like 'request_due:' || tests.id('dueSoon')::text || ':%' and n.title like '%dueSoon%'), 1::bigint, 'R-003-24 題名に案件の題名が入る');
select is((select count(*) from public.notifications where kind = 'request_due' and tenant_id = tests.t('A') and run_id = (select id from _run) and channel = 'app'), 6::bigint, 'R-003-24 作ったお知らせは処理の記録につながる（1＋1＋1＋3）');
select is((select link from public.notifications where kind = 'request_due' and dedupe_key like 'request_due:' || tests.id('dueSoon')::text || ':%' limit 1), '/requests/detail/?id=' || tests.id('dueSoon')::text, 'R-003-24 リンクは案件の詳細');

-- 止められた担当者のとき：request.edit を持つ人に回す
select tests.make_user('susp');
select tests.make_member('A', 'susp', 'staff', 'suspended');
select pg_temp.mk('dueSusp', pg_temp.today() - 1, 'susp');
select is(tests.run_as_service(format($q$select public.request_due_notify(%L, null, 3) as r$q$, tests.t('A'))) -> 'rows' -> 0 -> 'r' ->> 'requests', '5', '（準備）もう一度呼ぶ');
select is(pg_temp.notes('dueSusp'), 3::bigint, 'R-003-24 担当者が止められているときは、request.edit を持つ所属の全員に作る');

-- R-003-25 二度作らない・変わったら作る
select is(tests.run_as_service(format($q$select public.request_due_notify(%L, null, 3) as r$q$, tests.t('A'))) -> 'rows' -> 0 -> 'r' ->> 'notified', '0', 'R-003-25 もう一度呼んでも、新しく作らない');
select is((select count(*) from public.notifications where kind = 'request_due' and channel = 'app' and tenant_id = tests.t('A') and dedupe_key is not null), 9::bigint, 'R-003-25 お知らせの数は増えない');
update public.requests set due_date = pg_temp.today() - 1 where id = tests.id('dueSoon');
select is((tests.run_as_service(format($q$select public.request_due_notify(%L, null, 3) as r$q$, tests.t('A'))) -> 'rows' -> 0 -> 'r' ->> 'notified')::int > 0, true, 'R-003-25 近いから切れに変わった（期限を直した）ら、新しく作る');
select is(pg_temp.notes_for('dueSoon', 'memberA'), 2::bigint, 'R-003-25 同じ人に、新しいお知らせが1件増える');

-- R-003-26 会社ごと
select is((select count(*) from public.notifications where kind = 'request_due' and tenant_id = tests.t('B')), 0::bigint, 'R-003-26 A を呼んでも、ほかの会社（B）には何も作らない');
select is((select count(*) from public.notifications n join public.requests r on r.id = (regexp_match(n.dedupe_key, '^request_due:([0-9a-f-]+):'))[1]::uuid where n.kind = 'request_due' and n.tenant_id <> r.tenant_id), 0::bigint, 'R-003-26 お知らせの会社は、すべて案件と同じ');
select is(tests.run_as_service(format($q$select public.request_due_notify(%L, null, 3) as r$q$, tests.t('B'))) -> 'rows' -> 0 -> 'r' ->> 'requests', '2', 'R-003-26 B を呼ぶと、B の案件だけを見る');
select is((select count(*) from public.notifications where kind = 'request_due' and channel = 'app' and tenant_id = tests.t('B') and membership_id = tests.id('m:B:staffB')), 2::bigint, 'R-003-26 B の担当者に作る（近い1件・切れ1件）');
select is(tests.run_as_service(format($q$select public.request_due_finish(%L, %L, 'success', '{"requests": 4}'::jsonb, null) as r$q$, tests.t('A'), (select id from _run))) -> 'rows' -> 0 ->> 'r', 'true', 'R-003-26 処理の記録を閉じられる');
select is((select status || ',' || (counts ->> 'requests') from public.job_runs where id = (select id from _run)), 'success,4', 'R-003-26 記録に結果が残る');
select is(tests.run_as_service(format($q$select public.request_due_finish(%L, %L, 'success', '{}'::jsonb, null) as r$q$, tests.t('B'), (select id from _run))) -> 'rows' -> 0 ->> 'r', 'false', 'R-003-26 別の会社の記録は閉じられない');
select is(tests.err(tests.u('memberA'), format($q$select public.request_due_notify(%L, null, 3)$q$, tests.t('A'))), '42501', 'R-003-26 ログインした利用者は、定時の処理を呼べない');
select is(tests.err(tests.u('adminA'), format($q$select public.request_due_start(%L)$q$, tests.t('A'))), '42501', 'R-003-26 管理者も、処理の記録を始められない');
select is(tests.err(tests.u('adminA'), $q$select public.request_due_tenants()$q$), '42501', 'R-003-26 管理者は、定時の処理の会社の一覧を呼べない');
select is(tests.run_as_anon(format($q$select public.request_due_notify(%L, null, 3)$q$, tests.t('A'))) ->> 'error', '42501', 'R-003-26 anon は呼べない');
select is(jsonb_array_length(tests.run_as_service($q$select public.request_due_tenants() as r$q$) -> 'rows'), 2::bigint::int, 'R-003-26 定時の処理の対象の会社の一覧（期限のある終わっていない案件がある会社）');

-- ===== R-003-30 ほかの機能とのつなぎ =====
insert into public.buildings (id, tenant_id, client_id, name, address) values (tests.id('bR'), tests.t('A'), tests.id('clientA1'), '案件のある建物', '東京都A区7-7');
insert into public.requests (id, tenant_id, client_id, building_id, title, status) values (tests.id('bR-open'), tests.t('A'), tests.id('clientA1'), tests.id('bR'), '受付の案件', 'new');
select is(tests.run_as(tests.u('memberA'), format($q$select public.delete_building(%L) as r$q$, tests.id('bR'))) -> 'rows' -> 0 -> 'r' -> 'blockers' -> 0 ->> 'reason', 'has_open_requests', 'R-003-30 終わっていない案件がある建物は、消さず理由を返す');
update public.requests set status = 'in_progress' where id = tests.id('bR-open');
select is(tests.run_as(tests.u('memberA'), format($q$select public.delete_building(%L) as r$q$, tests.id('bR'))) -> 'rows' -> 0 -> 'r' -> 'blockers' -> 0 ->> 'count', '1', 'R-003-30 対応中の案件も数える（件数つき）');
update public.requests set status = 'done' where id = tests.id('bR-open');
select is(tests.run_as(tests.u('memberA'), format($q$select public.delete_building(%L) as r$q$, tests.id('bR'))) -> 'rows' -> 0 -> 'r' ->> 'ok', 'true', 'R-003-30 完了した案件だけなら、建物を消せる');
insert into public.rooms (id, tenant_id, building_id, room_no) values (tests.id('rq-room'), tests.t('A'), tests.id('buildingA2'), 'rq');
insert into public.requests (tenant_id, client_id, building_id, room_id, title) values (tests.t('A'), tests.id('clientA1'), tests.id('buildingA2'), tests.id('rq-room'), '部屋の案件');
select is(tests.run_as(tests.u('memberA'), format($q$select public.delete_room(%L) as r$q$, tests.id('rq-room'))) -> 'rows' -> 0 -> 'r' ->> 'deactivated', 'true', 'R-003-30 案件から使われている部屋は、消さず「使わない」にする');
select is((select active from public.rooms where id = tests.id('rq-room')), false, 'R-003-30 部屋は「使わない」になっている');

-- ===== R-003-31 別の会社の行 =====
select is(tests.n(tests.u('adminA'), format($q$select 1 from public.requests where tenant_id = %L$q$, tests.t('B'))), 0::bigint, 'R-003-31 A の管理者は、B の案件を読めない');
select is(tests.n(tests.u('adminA'), format($q$select 1 from public.request_charges where tenant_id = %L$q$, tests.t('B'))), 0::bigint, 'R-003-31 A の管理者は、B の金額を読めない');
select is(tests.cnt(tests.u('adminA'), format($q$update public.requests set title = 'x' where tenant_id = %L$q$, tests.t('B'))), 0::bigint, 'R-003-31 B の案件を直せない');
select is(tests.cnt(tests.u('adminA'), format($q$update public.request_charges set amount = 1 where tenant_id = %L$q$, tests.t('B'))), 0::bigint, 'R-003-31 B の金額を直せない');
select is(tests.err(tests.u('adminA'), format($q$insert into public.requests (tenant_id, client_id, building_id, title) values (%L, %L, %L, 'x')$q$, tests.t('B'), tests.id('clientB1'), tests.id('buildingB1'))), '42501', 'R-003-31 B に案件を作れない');
select is(tests.err(tests.u('adminA'), format($q$insert into public.request_charges (tenant_id, request_id, amount) values (%L, %L, 1)$q$, tests.t('B'), tests.id('reqB-1'))), '42501', 'R-003-31 B に金額を作れない');
select is((select count(*) from public.request_charges where tenant_id = tests.t('B') and amount = 3000), 1::bigint, 'R-003-31 B の金額は変わっていない');

-- ===== R-003-32 担当に選べる人 =====
select is(jsonb_array_length(tests.run_as(tests.u('memberA'), format($q$select * from public.request_assignees(%L)$q$, tests.t('A'))) -> 'rows'), 4, 'R-003-32 社員は、担当に選べる人（同じ会社の有効な社内の所属：管理者・社員2・スタッフ）の一覧を取れる');
select is((select count(*) from jsonb_array_elements(tests.run_as(tests.u('adminA'), format($q$select * from public.request_assignees(%L)$q$, tests.t('A'))) -> 'rows') e where e ->> 'role_code' = 'external'), 0::bigint, 'R-003-32 外部の人は含まれない');
select is(tests.run_as(tests.u('adminA'), format($q$select * from public.request_assignees(%L) where display_name = 'staffA'$q$, tests.t('A'))) -> 'rows' -> 0 ->> 'membership_id', tests.id('m:A:staffA')::text, 'R-003-32 表示名と所属の ID が返る');
select is(tests.err(tests.u('staffA'), format($q$select * from public.request_assignees(%L)$q$, tests.t('A'))), '42501', 'R-003-32 スタッフには返さない');
select is(tests.err(tests.u('extA'), format($q$select * from public.request_assignees(%L)$q$, tests.t('A'))), '42501', 'R-003-32 外部の人には返さない');
select is(tests.err(tests.u('memberA'), format($q$select * from public.request_assignees(%L)$q$, tests.t('B'))), '42501', 'R-003-32 別の会社の一覧は取れない');
select is(tests.run_as_anon(format($q$select * from public.request_assignees(%L)$q$, tests.t('A'))) ->> 'error', '42501', 'R-003-32 ログインしていない人は取れない');

select * from finish();
rollback;
