-- 機能 014：データの取り込み（R-014-12〜16 のサーバー側）。
-- 画面の確かめ（R-014-1〜11）は apps/web/src/lib/import/import.test.ts、画面の流れ（R-014-17〜19）は apps/web/e2e/import.e2e.ts。
begin;
select * from no_plan();
select tests.seed();

-- ---- 道具 ----
create or replace function pg_temp.imp(p_uid uuid, p_kind text, p_rows jsonb, p_excl jsonb default '[]'::jsonb, p_tenant text default 'A', p_file text default 'テスト.csv')
returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.import_rows(%L, %L, %L, %s, %L::jsonb, %L::jsonb) as r',
    tests.t(p_tenant), p_kind, p_file, case when jsonb_typeof(p_rows) = 'array' then jsonb_array_length(p_rows) else 0 end, p_excl, p_rows)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.imperr(p_uid uuid, p_kind text, p_rows jsonb, p_tenant text default 'A') returns text language sql as $$
  select tests.run_as(p_uid, format('select public.import_rows(%L, %L, %L, %s, %L::jsonb, %L::jsonb) as r',
    tests.t(p_tenant), p_kind, 'x.csv', case when jsonb_typeof(p_rows) = 'array' then jsonb_array_length(p_rows) else 0 end, '[]', p_rows)) ->> 'error'
$$;
-- 取り込まなかった行の理由（行番号:理由,…）
create or replace function pg_temp.why(p jsonb) returns text language sql as $$
  select coalesce(string_agg((d ->> 'row') || ':' || (d -> 'messages' ->> 0), ',' order by (d ->> 'row')::int), '')
  from jsonb_array_elements(coalesce(p -> 'details', '[]')) d
$$;
create temp table _keep (k text primary key, v jsonb);
create or replace function pg_temp.keep(p_k text, p_v jsonb) returns text language plpgsql as $$
begin insert into _keep values (p_k, p_v); return 'kept'; end $$;
create or replace function pg_temp.got(p_k text) returns jsonb language sql as $$ select v from _keep where k = p_k $$;
create or replace function pg_temp.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute p_sql into n; return n; end $$;

-- ===== R-014-12 権限 =====
select is(pg_temp.imperr(tests.u('staffA'), 'clients', '[{"row":2,"name":"スタッフの取引先"}]'), '42501', 'R-014-12 スタッフは取り込めない');
select is(pg_temp.imperr(tests.u('extA'), 'clients', '[{"row":2,"name":"外部の取引先"}]'), '42501', 'R-014-12 外部の人は取り込めない');
select is(pg_temp.imperr(tests.u('nobody'), 'clients', '[{"row":2,"name":"他人の取引先"}]'), '42501', 'R-014-12 どの会社にも属さない人は取り込めない');
select is(pg_temp.imperr(tests.u('operator'), 'clients', '[{"row":2,"name":"運営の取引先"}]'), '42501', 'R-014-12 運営は取り込めない');
select is(pg_temp.imperr(tests.u('adminB'), 'clients', '[{"row":2,"name":"B から A へ"}]', 'A'), '42501', 'R-014-12 別の会社の人は、この会社には取り込めない');
select is(tests.run_as_anon(format('select public.import_rows(%L, ''clients'', ''x.csv'', 0, ''[]'', ''[]'')', tests.t('A'))) ->> 'error', '42501', 'R-014-12 ログインしていない人は取り込めない');
select is(pg_temp.cnt($$select count(*) from public.clients where name in ('スタッフの取引先','外部の取引先','他人の取引先','運営の取引先','B から A へ')$$), 0::bigint, 'R-014-12 断られた取り込みは何も書かない');
select is(pg_temp.cnt($$select count(*) from public.import_jobs where file_name = 'x.csv'$$), 0::bigint, 'R-014-12 断られた取り込みは記録も残さない');
select is(pg_temp.imp(tests.u('memberA'), 'bogus', '[]') ->> 'reason', 'invalid_kind', 'R-014-12 知らない種類は断る');
select is(pg_temp.imp(tests.u('memberA'), 'clients', '{"a":1}') ->> 'reason', 'invalid_rows', 'R-014-12 行が配列でなければ断る');

-- ===== 取引先：R-014-13・15・16 =====
select pg_temp.keep('c1', pg_temp.imp(tests.u('memberA'), 'clients', $j$[
  {"row":2,"name":"取り込み商事","kind":"owner","address":"東京都1","phone":"03-0000-0000","email":"in@example.test","closing_day":"25","payment_terms":"末締め"},
  {"row":3,"name":"取り込み管理","kind":"","closing_day":""}
]$j$::jsonb));
select is((pg_temp.got('c1')) ->> 'created', '2', 'R-014-13 取引先を2件取り込めた');
select is(pg_temp.cnt($$select count(*) from public.clients where tenant_id = tests.t('A') and name in ('取り込み商事','取り込み管理')$$), 2::bigint, 'R-014-13 会社 A に取引先ができた');
select is((select kind || '/' || closing_day::text || '/' || email from public.clients where name = '取り込み商事'), 'owner/25/in@example.test', 'R-014-13 項目が入った');
select is((select kind from public.clients where name = '取り込み管理'), 'management_company', 'R-014-13 種類が空なら管理会社');
select is((select created_by from public.clients where name = '取り込み商事'), tests.u('memberA'), 'R-014-16 作った人は取り込んだ人');
select is((select source from public.audit_logs where table_name = 'clients' and row_id = (select id from public.clients where name = '取り込み商事') and action = 'insert'), 'import', 'R-014-16 履歴の source は import');

-- 重なり（サーバーでもやり直す）：全角半角・空白・大文字小文字の違い、同じ取り込みの中の2回目
select pg_temp.keep('c2', pg_temp.imp(tests.u('memberA'), 'clients', $j$[
  {"row":2,"name":"ﾃｽﾄ管理会社Ａ"},
  {"row":3,"name":"  新規ＡＢＣ　商会 "},
  {"row":4,"name":"新規abc 商会"}
]$j$::jsonb));
select is((pg_temp.got('c2')) ->> 'created', '1', 'R-014-13 重なりを除いて1件だけ取り込む');
select is(pg_temp.why(pg_temp.got('c2')), '2:duplicate,4:duplicate', 'R-014-13 既存と同じ（全角半角の違い）・同じ取り込みの2回目は重なりとして飛ばす');
select is((pg_temp.got('c2')) ->> 'skipped', '2', 'R-014-13 重なりの数');

-- 正しくない行は書かず、理由を返す
select pg_temp.keep('c3', pg_temp.imp(tests.u('memberA'), 'clients', $j$[
  {"row":2,"name":""},
  {"row":3,"name":"種類が変","kind":"tenant"},
  {"row":4,"name":"メールが変","email":"not-an-email"},
  {"row":5,"name":"締め日が変","closing_day":"32"},
  {"row":6,"name":"締め日が文字","closing_day":"月末"},
  {"row":7,"name":"これは入る"}
]$j$::jsonb));
select is(pg_temp.why(pg_temp.got('c3')), '2:name_required,3:invalid_kind,4:invalid_email,5:invalid_closing_day,6:invalid_closing_day', 'R-014-13 正しくない行は理由つきで断る');
select is((pg_temp.got('c3')) ->> 'created', '1', 'R-014-13 正しい行だけ取り込む');
select is(pg_temp.cnt($$select count(*) from public.clients where name in ('種類が変','メールが変','締め日が変','締め日が文字')$$), 0::bigint, 'R-014-13 正しくない行は書かない');

-- ===== 建物 =====
select pg_temp.keep('b1', pg_temp.imp(tests.u('memberA'), 'buildings', $j$[
  {"row":2,"client_name":"テスト管理会社A","name":"取り込みビル","address":"東京都2","owner_name":"テストオーナーA"},
  {"row":3,"client_name":"ﾃｽﾄ管理会社Ａ","name":"取り込みビル２","address":"東京都3"},
  {"row":4,"client_name":"存在しない会社","name":"建物X","address":"x"},
  {"row":5,"client_name":"テスト管理会社A","name":"建物Y","address":"y","owner_name":"存在しないオーナー"},
  {"row":6,"client_name":"テスト管理会社A","name":"テストマンションA1","address":"重なり"},
  {"row":7,"client_name":"テスト管理会社A","name":"","address":"名前なし"},
  {"row":8,"client_name":"テスト管理会社A","name":"住所なし","address":""},
  {"row":9,"client_name":"テスト管理会社B","name":"別の会社の取引先","address":"b"}
]$j$::jsonb));
select is((pg_temp.got('b1')) ->> 'created', '2', 'R-014-13 建物を2件取り込めた');
select is(pg_temp.why(pg_temp.got('b1')), '4:client_not_found,5:owner_not_found,6:duplicate,7:name_required,8:address_required,9:client_not_found', 'R-014-13 取引先がない・所有者がない・重なり・必須の欠け・別の会社の取引先は取り込まない');
select is((select count(*) from public.buildings where name = '取り込みビル' and tenant_id = tests.t('A') and client_id = tests.id('clientA1') and owner_client_id = tests.id('ownerA')), 1::bigint, 'R-014-13 建物は取引先・所有者につく');
select is((select source from public.audit_logs where table_name = 'buildings' and row_id = (select id from public.buildings where name = '取り込みビル') and action = 'insert'), 'import', 'R-014-16 建物の履歴の source は import');
-- 同じ名前の取引先が2つあれば決まらない
insert into public.clients (tenant_id, kind, name) values (tests.t('A'), 'owner', '同名の会社'), (tests.t('A'), 'owner', '同名の会社');
select is(pg_temp.why(pg_temp.imp(tests.u('memberA'), 'buildings', '[{"row":2,"client_name":"同名の会社","name":"建物Z","address":"z"}]')), '2:client_ambiguous', 'R-014-13 同じ名前の取引先が2つあれば、決まらないので取り込まない');

-- ===== 部屋 =====
select pg_temp.keep('r1', pg_temp.imp(tests.u('memberA'), 'rooms', $j$[
  {"row":2,"client_name":"テスト管理会社A","building_name":"テストマンションA1","room_no":"102","floor":"1"},
  {"row":3,"client_name":"テスト管理会社A","building_name":"テストマンションA1","room_no":"１０１"},
  {"row":4,"client_name":"テスト管理会社A","building_name":"建物がない","room_no":"103"},
  {"row":5,"client_name":"テスト管理会社A","building_name":"テストマンションA1","room_no":""},
  {"row":6,"client_name":"テスト管理会社A","building_name":"テストマンションA1","room_no":"104","floor":"一階"},
  {"row":7,"client_name":"テスト管理会社A","building_name":"テストマンションA1","room_no":"105"},
  {"row":8,"client_name":"テスト管理会社A","building_name":"テストマンションA1","room_no":"105"}
]$j$::jsonb));
select is((pg_temp.got('r1')) ->> 'created', '2', 'R-014-13 部屋を2件取り込めた');
select is(pg_temp.why(pg_temp.got('r1')), '3:duplicate,4:building_not_found,5:room_no_required,6:invalid_floor,8:duplicate', 'R-014-13 部屋の重なり・建物がない・必須の欠け・階が変は取り込まない');
select is((select count(*) from public.rooms where building_id = tests.id('buildingA1') and room_no = '102' and floor = 1), 1::bigint, 'R-014-13 部屋は建物につく');

-- ===== 契約：010 の create_contract_import を呼ぶ =====
select pg_temp.keep('k1', pg_temp.imp(tests.u('memberA'), 'contracts', $j$[
  {"row":2,"client_name":"テスト管理会社A","building_name":"テストビルA2","kind":"recurring","start_date":"2027-01-01","end_date":"",
   "services":[{"service_kind":"base","name":"取り込み定期清掃","amount":30000,"billing":"monthly","recurrence":"FREQ=WEEKLY;BYDAY=MO","start_time":"09:00","end_time":"12:00"},
               {"service_kind":"option","name":"取り込み窓清掃","amount":12000,"billing":"per_visit","recurrence":"FREQ=MONTHLY;INTERVAL=3"}]}
]$j$::jsonb));
select is((pg_temp.got('k1')) ->> 'created', '1', 'R-014-14 契約を取り込めた');
select is((select source || '/' || kind || '/' || status || '/' || coalesce(quote_id::text, 'none') from public.contracts where building_id = tests.id('buildingA2') and start_date = date '2027-01-01'), 'import/recurring/active/none', 'R-014-14 元は取り込み・見積なし');
select is((select count(*) from public.contract_services s join public.contracts c on c.id = s.contract_id where c.building_id = tests.id('buildingA2') and c.start_date = date '2027-01-01'), 2::bigint, 'R-014-14 清掃の中身も同時にできる');
select is((select created_by from public.contracts where building_id = tests.id('buildingA2') and start_date = date '2027-01-01'), tests.u('memberA'), 'R-014-16 契約を作った人は取り込んだ人');
-- 同じ契約をもう一度：重なり
select is(pg_temp.why(pg_temp.imp(tests.u('memberA'), 'contracts', $j$[
  {"row":2,"client_name":"テスト管理会社A","building_name":"テストビルA2","kind":"recurring","start_date":"2027-01-01",
   "services":[{"service_kind":"option","name":"取り込み窓清掃","amount":1,"recurrence":"FREQ=DAILY;COUNT=1"},{"service_kind":"base","name":"取り込み定期清掃","amount":1}]}]$j$::jsonb)), '2:duplicate', 'R-014-14 同じ建物・種類・開始日・清掃の名前の契約は、重なりとして飛ばす');
select is(pg_temp.cnt($$select count(*) from public.contracts where building_id = tests.id('buildingA2') and start_date = date '2027-01-01'$$), 1::bigint, 'R-014-14 重なりの契約は増えない');
-- 中身が1つでも正しくなければ、契約を作らない（半分だけ作らない）
select is(pg_temp.why(pg_temp.imp(tests.u('memberA'), 'contracts', $j$[
  {"row":2,"client_name":"テスト管理会社A","building_name":"テストビルA2","kind":"one_time","start_date":"2027-02-01",
   "services":[{"service_kind":"base","name":"良い中身","amount":1000},{"service_kind":"base","name":"悪い中身","amount":-5}]},
  {"row":4,"client_name":"テスト管理会社A","building_name":"テストビルA2","kind":"one_time","start_date":"2027-03-01","services":[]},
  {"row":5,"client_name":"テスト管理会社A","building_name":"建物がない","kind":"one_time","start_date":"2027-03-01","services":[{"service_kind":"base","name":"x","amount":1}]},
  {"row":6,"client_name":"テスト管理会社A","building_name":"テストビルA2","kind":"one_time","start_date":"2027-13-45","services":[{"service_kind":"base","name":"x","amount":1}]},
  {"row":7,"client_name":"テスト管理会社A","building_name":"テストビルA2","kind":"one_time","start_date":"2027-04-10","end_date":"2027-04-01","services":[{"service_kind":"base","name":"x","amount":1}]}
]$j$::jsonb)), '2:invalid_amount,4:no_services,5:building_not_found,6:invalid_value,7:end_before_start', 'R-014-14 正しくない契約は理由つきで断る');
select is(pg_temp.cnt($$select count(*) from public.contracts where building_id = tests.id('buildingA2') and start_date in (date '2027-02-01', date '2027-03-01', date '2027-04-10')$$), 0::bigint, 'R-014-14 正しくない契約は、半分も作らない');
select is(pg_temp.cnt($$select count(*) from public.contract_services where name in ('良い中身','悪い中身')$$), 0::bigint, 'R-014-14 契約の中身も残らない');
select is(pg_temp.imperr(tests.u('staffA'), 'contracts', '[]'), '42501', 'R-014-12 スタッフは契約も取り込めない');
select is(pg_temp.imperr(tests.u('adminB'), 'contracts', '[{"row":2}]', 'A'), '42501', 'R-014-12 別の会社の人は契約を取り込めない');
select is(pg_temp.why(pg_temp.imp(tests.u('adminB'), 'contracts', $j$[
  {"row":2,"client_name":"テスト管理会社A","building_name":"テストビルA2","kind":"one_time","start_date":"2027-05-01","services":[{"service_kind":"base","name":"x","amount":1}]}]$j$::jsonb, '[]', 'B')),
  '2:client_not_found', 'R-014-13 別の会社の取引先・建物の名前では、契約を作れない（見つからない扱い）');

-- ===== R-014-15 取り込みの記録 =====
select pg_temp.keep('j1', pg_temp.imp(tests.u('adminA'), 'clients', '[{"row":2,"name":"記録の確かめ"},{"row":3,"name":""}]'::jsonb,
  '[{"row":4,"status":"error","messages":["メールの形が正しくありません"]},{"row":5,"status":"duplicate","messages":["重なり"]}]'::jsonb, 'A', '記録.xlsx'));
select is((pg_temp.got('j1')) ->> 'status', 'partial', 'R-014-15 エラーの行があれば状況は partial');
select is((select kind || '/' || file_name || '/' || status || '/' || total_rows || '/' || created_count || '/' || skipped_count || '/' || error_rows from public.import_jobs where id = ((pg_temp.got('j1')) ->> 'job_id')::uuid),
  'clients/記録.xlsx/partial/2/1/1/2', 'R-014-15 種類・ファイル名・状況・件数が残る（画面が外した行も数える）');
select is((select jsonb_array_length(details) from public.import_jobs where id = ((pg_temp.got('j1')) ->> 'job_id')::uuid), 3, 'R-014-15 取り込まなかった行の一覧が残る（画面 2・サーバー 1）');
select is((select created_by from public.import_jobs where id = ((pg_temp.got('j1')) ->> 'job_id')::uuid), tests.u('adminA'), 'R-014-15 記録に、取り込んだ人が残る');
select is(((pg_temp.imp(tests.u('adminA'), 'clients', '[{"row":2,"name":"全部入る"}]'::jsonb)) ->> 'status'), 'done', 'R-014-15 エラーがなければ状況は done');
select ok(tests.n(tests.u('adminA'), 'select 1 from public.import_jobs') >= 3, 'R-014-15 master.edit を持つ人（管理者）は記録を読める');
select ok(tests.n(tests.u('memberA'), 'select 1 from public.import_jobs') >= 3, 'R-014-15 master.edit を持つ人（社員）は記録を読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.import_jobs'), 0::bigint, 'R-014-15 スタッフは記録を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.import_jobs'), 0::bigint, 'R-014-15 外部の人は記録を読めない');
select is(tests.n(tests.u('adminA'), format('select 1 from public.import_jobs where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-014-15 別の会社の記録は読めない');
select is(tests.err(tests.u('adminA'), format($q$insert into public.import_jobs (tenant_id, kind, file_name, status, total_rows) values (%L, 'clients', 'x', 'done', 0)$q$, tests.t('A'))), '42501', 'R-014-15 画面から直接は書けない（insert）');
select is(tests.cnt(tests.u('adminA'), format($q$update public.import_jobs set file_name = 'y' where id = %L$q$, tests.id('importA'))), -1::bigint, 'R-014-15 画面から直接は直せない（update）');
select is(tests.run_as(tests.u('adminA'), format($q$delete from public.import_jobs where id = %L$q$, tests.id('importA'))) ->> 'error', '42501', 'R-014-15 画面から直接は消せない（delete）');

select * from finish();
rollback;
