-- 機能 013：地図（R-013-1〜20 の DB の部分）。建物の位置・住所から位置を求める定時の処理の関数・開始と終了の位置と距離・離れたときの知らせ・90 日の掃除。
-- 画面と Edge Function の判断（R-013-8〜11・21〜29）は Vitest と e2e。
begin;
select * from no_plan();
select tests.seed();

select tests.make_user('staff2A');
select tests.make_member('A', 'staff2A', 'staff');

-- ---- 道具 ----
create or replace function pg_temp.call(p_uid uuid, p_fn text, p_args text) returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.callerr(p_uid uuid, p_fn text, p_args text) returns text language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%s) as r', p_fn, p_args)) ->> 'error'
$$;
create or replace function pg_temp.svc(p_fn text, p_args text) returns jsonb language sql as $$
  select tests.run_as_service(format('select public.%I(%s) as r', p_fn, p_args)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.svcerr(p_fn text, p_args text) returns text language sql as $$
  select tests.run_as_service(format('select public.%I(%s) as r', p_fn, p_args)) ->> 'error'
$$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
create or replace function pg_temp.q(p text) returns text language sql as $$ select quote_literal(tests.id(p)::text) $$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Tokyo')::date $$;
create or replace function pg_temp.mkwork(p_name text, p_status text default 'scheduled', p_members text[] default '{}') returns uuid language plpgsql as $$
declare m text;
begin
  insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status)
  values (tests.id(p_name), tests.t('A'), tests.id('buildingA10'), tests.id('svcA10-base'), tests.id('key:A10-base'), 'テスト作業：' || p_name, pg_temp.today() + 1, p_status);
  foreach m in array p_members loop
    insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('wa:' || p_name || ':' || m), tests.t('A'), tests.id(p_name), tests.id('m:A:' || m));
  end loop;
  return tests.id(p_name);
end $$;
-- 開始・終了（位置は 'null' か 緯度, 経度）
create or replace function pg_temp.st(p_uid uuid, p_rec text, p_work text, p_pos text default 'null, null') returns jsonb language sql as $$
  select pg_temp.call(p_uid, 'start_work', format('%s, %s, null, null, null, %s', pg_temp.q(p_rec), pg_temp.q(p_work), p_pos))
$$;
create or replace function pg_temp.fin(p_uid uuid, p_op text, p_work text, p_pos text default 'null, null') returns jsonb language sql as $$
  select pg_temp.call(p_uid, 'finish_work', format('%s, %s, null, %s', pg_temp.q(p_op), pg_temp.q(p_work), p_pos))
$$;
-- 建物 A10 の位置（東京駅のあたり）。0.001 度の緯度は約 111 m、0.01 度は約 1112 m
update public.buildings set lat = 35.681236, lng = 139.767125 where id = tests.id('buildingA10');
create or replace function pg_temp.near() returns text language sql as $$ select '35.682236, 139.767125' $$;
create or replace function pg_temp.far() returns text language sql as $$ select '35.691236, 139.767125' $$;
create or replace function pg_temp.nfar(p_kind text default 'work_far') returns bigint language sql as $$
  select count(*) from public.notifications where tenant_id = tests.t('A') and kind = p_kind and channel = 'app'
$$;
-- 建物 A10 を作り直したあとの作業の状態
create or replace function pg_temp.rec(p_rec text, p_col text) returns text language plpgsql as $$
declare v text;
begin execute format('select %I::text from public.work_records where id = %L', p_col, tests.id(p_rec)) into v; return v; end $$;

-- ===== R-013-1 位置の列 =====
select is(pg_temp.try(format($q$update public.buildings set lat = 10 where id = %L$q$, tests.id('buildingA2'))), '23514', 'R-013-1 緯度だけ（経度が空）では保存できない');
select is(pg_temp.try(format($q$update public.buildings set lat = 91, lng = 10 where id = %L$q$, tests.id('buildingA2'))), '23514', 'R-013-1 緯度が範囲外（91）では保存できない');
select is(pg_temp.try(format($q$update public.buildings set lat = 10, lng = 181 where id = %L$q$, tests.id('buildingA2'))), '23514', 'R-013-1 経度が範囲外（181）では保存できない');
select is(pg_temp.try(format($q$update public.buildings set lat = 35.1, lng = 139.1 where id = %L$q$, tests.id('buildingA2'))), 'ok', 'R-013-1 両方が範囲内なら保存できる');
update public.buildings set lat = null, lng = null where id = tests.id('buildingA2');

-- ===== R-013-2 求める対象 =====
insert into public.buildings (id, tenant_id, client_id, name, address, lat, lng, location_fixed, geocode_failed_at, deleted_at) values
  (tests.id('gA'), tests.t('A'), tests.id('clientA1'), '求める建物', '東京都A区9-1', null, null, false, null, null),
  (tests.id('gB'), tests.t('A'), tests.id('clientA1'), '位置あり', '東京都A区9-2', 35.0, 139.0, false, null, null),
  (tests.id('gC'), tests.t('A'), tests.id('clientA1'), '直した（位置は空）', '東京都A区9-3', null, null, true, null, null),
  (tests.id('gD'), tests.t('A'), tests.id('clientA1'), '消した建物', '東京都A区9-4', null, null, false, null, now()),
  (tests.id('gE'), tests.t('A'), tests.id('clientA1'), '失敗から1日', '東京都A区9-5', null, null, false, now() - interval '1 day', null),
  (tests.id('gF'), tests.t('A'), tests.id('clientA1'), '失敗から8日', '東京都A区9-6', null, null, false, now() - interval '8 days', null),
  (tests.id('gX'), tests.t('B'), tests.id('clientB1'), '会社Bの求める建物', '大阪府B市9-1', null, null, false, null, null);
select is((select count(*) from public.geocode_pending(tests.t('A'), 50) where id in (tests.id('gA'), tests.id('gF'))), 2::bigint, 'R-013-2 位置が空・直していない・失敗から 7 日以上（または失敗なし）の建物が対象');
select is((select count(*) from public.geocode_pending(tests.t('A'), 50) where id in (tests.id('gB'), tests.id('gC'), tests.id('gD'), tests.id('gE'), tests.id('gX'))), 0::bigint,
          'R-013-2 位置あり・直した・消した・失敗から 7 日以内・ほかの会社の建物は対象にしない');
select is((select count(*) from public.geocode_pending(tests.t('A'), 1)), 1::bigint, 'R-013-2 件数の上限を守る');
select is((select count(*) from public.geocode_pending(tests.t('A')) ), (select least(count(*), 50) from public.buildings where tenant_id = tests.t('A') and deleted_at is null and lat is null and location_fixed = false and (geocode_failed_at is null or geocode_failed_at < now() - interval '7 days')),
          'R-013-2 初めの上限は 50 件');
select ok((select array_agg(x order by x) from public.geocode_tenants() x) @> array[tests.t('A'), tests.t('B')], 'R-013-2 対象の建物がある会社が、会社の一覧に出る');

-- ===== R-013-3 保存の時点でも確かめる =====
select is(pg_temp.svc('geocode_apply', format('%L, %L, 35.6812361, 139.7671251', tests.t('A'), tests.id('gA'))), 'true'::jsonb, 'R-013-3 位置が空の建物には書ける');
select is((select lat::text || ',' || lng::text from public.buildings where id = tests.id('gA')), '35.681236,139.767125', 'R-013-3 位置は小数 6 桁で入る');
select is((select location_fixed from public.buildings where id = tests.id('gA')), false, 'R-013-3 求めた位置は「直した」印を付けない');
select is(pg_temp.svc('geocode_apply', format('%L, %L, 10, 10', tests.t('A'), tests.id('gA'))), 'false'::jsonb, 'R-013-3 位置がすでにある建物は、上書きしない');
select is(pg_temp.svc('geocode_apply', format('%L, %L, 10, 10', tests.t('A'), tests.id('gC'))), 'false'::jsonb, 'R-013-3 地図で直した建物は、位置が空でも書かない');
select is(pg_temp.svc('geocode_apply', format('%L, %L, 10, 10', tests.t('B'), tests.id('gF'))), 'false'::jsonb, 'R-013-3 会社が合わない建物には書かない');
select is(pg_temp.svcerr('geocode_apply', format('%L, %L, 95, 10', tests.t('A'), tests.id('gF'))), '22023', 'R-013-3 範囲外の位置は断る');
select is((select lat from public.buildings where id = tests.id('gF')), null, 'R-013-3 断ったときは、書かない');

-- ===== R-013-4 求められなかったとき =====
select is(pg_temp.svc('geocode_fail', format('%L, %L', tests.t('A'), tests.id('gF'))), 'true'::jsonb, 'R-013-4 求められなかった建物に、失敗の時刻が入る');
select is((select count(*) from public.geocode_pending(tests.t('A'), 50) where id = tests.id('gF')), 0::bigint, 'R-013-4 失敗から 7 日以内は、対象にしない');
select is((select lat from public.buildings where id = tests.id('gF')), null, 'R-013-4 位置は空のまま');
select is(pg_temp.svc('geocode_fail', format('%L, %L', tests.t('A'), tests.id('gB'))), 'false'::jsonb, 'R-013-4 位置のある建物には、失敗の印を付けない');

-- ===== R-013-5 住所を変えたとき =====
update public.buildings set geocode_failed_at = now() where id = tests.id('gE');
select is(pg_temp.try(format($q$update public.buildings set address = '東京都A区9-9' where id = %L$q$, tests.id('gB'))), 'ok', 'R-013-5 （前提）住所を変えられる');
select is((select (lat is null)::text || ',' || (lng is null)::text from public.buildings where id = tests.id('gB')), 'true,true', 'R-013-5 直していない建物は、住所を変えると位置が空に戻る');
update public.buildings set location_fixed = false where id = tests.id('gE');
update public.buildings set address = '東京都A区9-10' where id = tests.id('gE');
select is((select geocode_failed_at from public.buildings where id = tests.id('gE')), null, 'R-013-5 住所を変えると、失敗の印も消える（求め直しの対象になる）');
update public.buildings set lat = 35.5, lng = 139.5, location_fixed = true where id = tests.id('gC');
update public.buildings set address = '東京都A区9-11' where id = tests.id('gC');
select is((select lat::text from public.buildings where id = tests.id('gC')), '35.500000', 'R-013-5 地図で直した建物は、住所を変えても位置を残す');
update public.buildings set lat = 35.0, lng = 139.0, address = '東京都A区9-12' where id = tests.id('gB'); -- 住所と位置を一緒に変える（位置のほうが新しい）
select is((select lat::text from public.buildings where id = tests.id('gB')), '35.000000', 'R-013-5 住所と位置を一緒に変えたときは、渡した位置を使う');

-- ===== R-013-6 地図で直す =====
select is(tests.run_as(tests.u('memberA'), format($q$update public.buildings set lat = 35.7, lng = 139.7 where id = %L$q$, tests.id('buildingA2'))) ->> 'count', '1', 'R-013-6 master.edit の社員は位置を直せる');
select is((select location_fixed from public.buildings where id = tests.id('buildingA2')), true, 'R-013-6 直すと「直した」印が付く');
select is(coalesce(tests.run_as(tests.u('staffA'), format($q$update public.buildings set lat = 1, lng = 1 where id = %L$q$, tests.id('buildingA1'))) ->> 'count', '0'), '0', 'R-013-6 master.edit のないスタッフは直せない');
select is(coalesce(tests.run_as(tests.u('extA'), format($q$update public.buildings set lat = 1, lng = 1 where id = %L$q$, tests.id('buildingA1'))) ->> 'count', '0'), '0', 'R-013-6 外部の人は直せない');
select is(coalesce(tests.run_as(tests.u('adminB'), format($q$update public.buildings set lat = 1, lng = 1 where id = %L$q$, tests.id('buildingA1'))) ->> 'count', '0'), '0', 'R-013-6 ほかの会社の人は直せない');
select is((select lat::text from public.buildings where id = tests.id('buildingA1')), '35.681236', 'R-013-6 断られたときは、位置は変わらない');
select is(pg_temp.try(format($q$set local role authenticated; update public.buildings set geocode_failed_at = null where id = %L$q$, tests.id('buildingA2'))), '42501', 'R-013-6 失敗の印の列は、画面（利用者）からは書けない');
reset role;

-- ===== R-013-7 住所から求め直す =====
select is(tests.run_as(tests.u('memberA'), format($q$update public.buildings set lat = null, lng = null, location_fixed = false where id = %L$q$, tests.id('buildingA2'))) ->> 'count', '1', 'R-013-7 master.edit の社員は、位置を空に戻せる');
select is((select count(*) from public.geocode_pending(tests.t('A'), 50) where id = tests.id('buildingA2')), 1::bigint, 'R-013-7 戻した建物は、次の処理の対象になる');

-- ===== R-013-8 定時の処理の関数（service_role だけ・処理の記録）=====
select is(tests.run_as(tests.u('adminA'), 'select count(*) from public.geocode_tenants()') ->> 'error', '42501', 'R-013-8 利用者は、位置を求める会社の一覧を呼べない');
select is(tests.run_as_anon('select public.geocode_start(null)') ->> 'error', '42501', 'R-013-8 ログインしていない人は、処理を始められない');
select is(pg_temp.svcerr('geocode_start', format('%L', tests.t('A'))), null, 'R-013-8 service_role は処理を始められる');
select is((select kind || ',' || status from public.job_runs where tenant_id = tests.t('A') and kind = 'geocode_buildings'), 'geocode_buildings,running', 'R-013-8 処理の記録（種類 geocode_buildings）が会社ごとに残る');
select is(pg_temp.svc('geocode_start', format('%L', tests.t('A'))), 'null'::jsonb, 'R-013-8 同じ会社で動いている最中なら、始めない（null）');
select is(pg_temp.svc('geocode_finish', format('%L, (select id from public.job_runs where tenant_id = %L and kind = ''geocode_buildings''), ''success'', ''{"geocoded": 2}''::jsonb, null', tests.t('A'), tests.t('A'))), 'true'::jsonb, 'R-013-8 処理の記録を閉じられる');
select is((select status || ',' || counts::text from public.job_runs where tenant_id = tests.t('A') and kind = 'geocode_buildings'), 'success,{"geocoded": 2}', 'R-013-8 件数が記録に残る');
select is(pg_temp.svcerr('geocode_finish', format('%L, %L, ''running'', ''{}''::jsonb, null', tests.t('A'), gen_random_uuid())), '22023', 'R-013-8 状況は success か failure だけ');

-- ===== R-013-10 画面から 1 件求める入口の確かめ =====
select is(pg_temp.call(tests.u('memberA'), 'geocode_target', pg_temp.q('buildingA1')) ->> 'address', '東京都A区1-1-1', 'R-013-10 master.edit の社員は、自分の会社の建物の住所を受け取れる');
select is(pg_temp.callerr(tests.u('staffA'), 'geocode_target', pg_temp.q('buildingA1')), '42501', 'R-013-10 master.edit のないスタッフは断られる');
select is(pg_temp.callerr(tests.u('extA'), 'geocode_target', pg_temp.q('buildingA1')), '42501', 'R-013-10 外部の人は断られる');
select is(pg_temp.callerr(tests.u('adminB'), 'geocode_target', pg_temp.q('buildingA1')), '42501', 'R-013-10 ほかの会社の人は断られる');
select is(pg_temp.callerr(tests.u('memberA'), 'geocode_target', format('%L', gen_random_uuid())), '42501', 'R-013-10 存在しない建物も、同じ「権限がない」で断る');
select is(tests.run_as_anon(format('select public.geocode_target(%s)', pg_temp.q('buildingA1'))) ->> 'error', '42501', 'R-013-10 ログインしていない人は断られる');

-- ===== R-013-12・13・14・15 開始に位置を付ける =====
select pg_temp.mkwork('w12a', 'scheduled', array['staffA', 'staff2A']);
select is(pg_temp.st(tests.u('staffA'), 'r12a', 'w12a') ->> 'ok', 'true', 'R-013-12 位置を渡さなくても、開始を記録できる（了承しなかった場合）');
select is(pg_temp.rec('r12a', 'start_lat') is null and pg_temp.rec('r12a', 'distance_m') is null and pg_temp.rec('r12a', 'distance_warning') = 'false', true, 'R-013-12 位置なしの記録は、位置・距離が空で警告なし');
select pg_temp.mkwork('w13a', 'scheduled', array['staffA']);
select is(pg_temp.st(tests.u('staffA'), 'r13a', 'w13a', '35.68, null') ->> 'reason', 'invalid_location', 'R-013-13 緯度だけでは記録しない');
select is(pg_temp.st(tests.u('staffA'), 'r13b', 'w13a', 'null, 139.7') ->> 'reason', 'invalid_location', 'R-013-13 経度だけでは記録しない');
select is(pg_temp.st(tests.u('staffA'), 'r13c', 'w13a', '95, 139.7') ->> 'reason', 'invalid_location', 'R-013-13 緯度が範囲外では記録しない');
select is(pg_temp.st(tests.u('staffA'), 'r13d', 'w13a', '35.6, 200') ->> 'reason', 'invalid_location', 'R-013-13 経度が範囲外では記録しない');
select is((select count(*) from public.work_records where work_id = tests.id('w13a')), 0::bigint, 'R-013-13 断ったときは、実績も作らない');
select is((select status from public.works where id = tests.id('w13a')), 'scheduled', 'R-013-13 断ったときは、作業の状況も変えない');
select pg_temp.mkwork('w14a', 'scheduled', array['staffA']);
select is(pg_temp.st(tests.u('staffA'), 'r14a', 'w14a', pg_temp.near()) ->> 'ok', 'true', 'R-013-14 建物の近くで位置つきの開始を記録できる');
select is(pg_temp.rec('r14a', 'start_lat') || ',' || pg_temp.rec('r14a', 'start_lng'), '35.682236,139.767125', 'R-013-14 開始の位置は start_lat・start_lng に入る');
select is(pg_temp.rec('r14a', 'end_lat') is null and pg_temp.rec('r14a', 'end_lng') is null, true, 'R-013-14 終了の位置は、まだ空');
select ok(pg_temp.rec('r14a', 'distance_m')::int between 100 and 125, 'R-013-15 建物との距離（約 111 m）が入る');
select is(pg_temp.rec('r14a', 'distance_warning'), 'false', 'R-013-15 300 m 以内なら、警告しない');
select is(pg_temp.nfar(), 0::bigint, 'R-013-16 近いときは、知らせを作らない');
select is((select count(*) from public.work_records where work_id = tests.id('w14a')), 1::bigint, 'R-013-14 （前提）実績は 1 件');

-- ===== R-013-15・16 離れたとき =====
select pg_temp.mkwork('w16a', 'scheduled', array['staffA']);
select is(pg_temp.st(tests.u('staffA'), 'r16a', 'w16a', pg_temp.far()) ->> 'ok', 'true', 'R-013-15 建物から離れた場所でも、開始は記録できる（止めない）');
select ok(pg_temp.rec('r16a', 'distance_m')::int between 1100 and 1125, 'R-013-15 距離（約 1112 m）が入る');
select is(pg_temp.rec('r16a', 'distance_warning'), 'true', 'R-013-15 300 m を超えたので、警告が付く');
select is(pg_temp.nfar(), 3::bigint, 'R-013-16 work.assign を持つ有効な所属（管理者・社員・社員）に、お知らせの行ができる');
select is((select count(*) from public.notifications where kind = 'work_far' and membership_id = tests.id('m:A:staffA')), 0::bigint, 'R-013-16 記録した本人（スタッフ）には作らない');
select is((select count(*) from public.notifications where kind = 'work_far' and membership_id = tests.id('m:A:staff2A')), 0::bigint, 'R-013-16 work.assign のないスタッフには作らない');
select is((select count(*) from public.notifications where kind = 'work_far' and tenant_id = tests.t('B')), 0::bigint, 'R-013-16 ほかの会社の人には作らない');
select is((select link from public.notifications where kind = 'work_far' and membership_id = tests.id('m:A:memberA') and channel = 'app'), '/schedule/work/?id=' || tests.id('w16a')::text, 'R-013-16 リンクは作業の画面');
select ok((select body from public.notifications where kind = 'work_far' and membership_id = tests.id('m:A:memberA') and channel = 'app') like '%離れた場所で開始%', 'R-013-16 本文に、離れた場所での開始と分かる言葉が入る');
select is(pg_temp.st(tests.u('staffA'), 'r16a', 'w16a', pg_temp.far()) ->> 'already', 'true', 'R-013-14 同じ uuid の二度目は already');
select is(pg_temp.nfar(), 3::bigint, 'R-013-14 二度目は、知らせを増やさない');
select is((select count(*) from public.work_records where work_id = tests.id('w16a')), 1::bigint, 'R-013-14 二度目は、実績を増やさない');

-- 建物に位置がないとき：位置は保存するが、距離・警告・知らせはなし
update public.buildings set lat = null, lng = null where id = tests.id('buildingA10');
select pg_temp.mkwork('w16b', 'scheduled', array['staffA']);
select is(pg_temp.st(tests.u('staffA'), 'r16b', 'w16b', pg_temp.far()) ->> 'ok', 'true', 'R-013-15 建物に位置がなくても、開始は記録できる');
select is(pg_temp.rec('r16b', 'start_lat') is not null and pg_temp.rec('r16b', 'distance_m') is null and pg_temp.rec('r16b', 'distance_warning') = 'false', true, 'R-013-15 建物に位置がなければ、距離は空・警告なし（位置は残る）');
select is(pg_temp.nfar(), 3::bigint, 'R-013-16 建物に位置がなければ、知らせは作らない');
update public.buildings set lat = 35.681236, lng = 139.767125 where id = tests.id('buildingA10');

-- ===== R-013-14・15・16 終了に位置を付ける =====
select is(pg_temp.fin(tests.u('staffA'), 'f14a', 'w14a', pg_temp.near()) ->> 'ok', 'true', 'R-013-14 位置つきの終了を記録できる');
select is(pg_temp.rec('r14a', 'end_lat') || ',' || pg_temp.rec('r14a', 'end_lng'), '35.682236,139.767125', 'R-013-14 終了の位置は end_lat・end_lng に入る');
select is(pg_temp.rec('r14a', 'start_lat') || ',' || pg_temp.rec('r14a', 'start_lng'), '35.682236,139.767125', 'R-013-14 開始の位置は残る');
select is(pg_temp.rec('r14a', 'distance_warning'), 'false', 'R-013-15 近い開始と近い終了なら、警告なし');
-- 開始は離れていて、終了は近い：距離は大きい方、警告は残る。知らせは増えない
select is(pg_temp.fin(tests.u('staffA'), 'f16a', 'w16a', pg_temp.near()) ->> 'ok', 'true', 'R-013-15 離れて開始した作業を、近くで終了できる');
select ok(pg_temp.rec('r16a', 'distance_m')::int between 1100 and 1125, 'R-013-15 距離は、開始と終了のうち大きい方');
select is(pg_temp.rec('r16a', 'distance_warning'), 'true', 'R-013-15 開始が離れていたので、警告は残る');
select is(pg_temp.nfar(), 3::bigint, 'R-013-16 終了が近ければ、終了の知らせは作らない');
-- 近くで開始し、離れて終了：終了の知らせが作られる
select pg_temp.mkwork('w16c', 'scheduled', array['staffA']);
select pg_temp.st(tests.u('staffA'), 'r16c', 'w16c', pg_temp.near());
select is(pg_temp.fin(tests.u('staffA'), 'f16c', 'w16c', pg_temp.far()) ->> 'ok', 'true', 'R-013-15 離れた場所での終了も、記録できる');
select is(pg_temp.rec('r16c', 'distance_warning'), 'true', 'R-013-15 終了が離れていれば、警告が付く');
select is(pg_temp.nfar(), 6::bigint, 'R-013-16 終了のときも、3 人に知らせを作る');
select ok((select body from public.notifications where kind = 'work_far' and membership_id = tests.id('m:A:memberA') and channel = 'app' and link like '%' || tests.id('w16c')::text) like '%離れた場所で終了%', 'R-013-16 終了の知らせは「終了」と書く');
select is(pg_temp.fin(tests.u('staffA'), 'f16c2', 'w16c', pg_temp.far()) ->> 'already', 'true', 'R-013-14 終了済みへの二度目は already');
select is(pg_temp.nfar(), 6::bigint, 'R-013-16 二度目は知らせを増やさない');
-- 位置なしの終了
select pg_temp.mkwork('w16d', 'scheduled', array['staffA']);
select pg_temp.st(tests.u('staffA'), 'r16d', 'w16d', pg_temp.far());
select is(pg_temp.fin(tests.u('staffA'), 'f16d', 'w16d') ->> 'ok', 'true', 'R-013-12 位置なしの終了も記録できる');
select is(pg_temp.rec('r16d', 'end_lat') is null and pg_temp.rec('r16d', 'distance_warning') = 'true', true, 'R-013-15 位置なしの終了は、終了の位置が空で、開始の警告は残る');
select pg_temp.mkwork('w13b', 'scheduled', array['staffA']);
select pg_temp.st(tests.u('staffA'), 'r13e', 'w13b', pg_temp.near());
select is(pg_temp.fin(tests.u('staffA'), 'f13e', 'w13b', '35.6, null') ->> 'reason', 'invalid_location', 'R-013-13 終了の位置が片方だけなら記録しない');
select is(pg_temp.rec('r13e', 'ended_at') is null, true, 'R-013-13 断ったときは、終了を記録しない');

-- ===== R-013-17 位置を読める人 =====
select is(tests.n(tests.u('staffA'), format('select 1 from public.work_records where id = %L and start_lat is not null', tests.id('r16a'))), 1::bigint, 'R-013-17 本人は自分の位置を読める');
select is(tests.n(tests.u('memberA'), format('select 1 from public.work_records where id = %L and start_lat is not null', tests.id('r16a'))), 1::bigint, 'R-013-17 work.assign の社員は読める');
select is(tests.n(tests.u('staff2A'), format('select 1 from public.work_records where id = %L', tests.id('r16a'))), 0::bigint, 'R-013-17 担当でないスタッフ（別の人）は読めない');
select is(tests.n(tests.u('extA'), format('select 1 from public.work_records where id = %L', tests.id('r16a'))), 0::bigint, 'R-013-17 外部の人は読めない');
select is(tests.n(tests.u('adminB'), format('select 1 from public.work_records where id = %L', tests.id('r16a'))), 0::bigint, 'R-013-17 ほかの会社の人は読めない');
select is(coalesce(tests.run_as(tests.u('staffA'), format($q$update public.work_records set start_lat = 1, start_lng = 1 where id = %L$q$, tests.id('r16a'))) ->> 'count', '0'), '0', 'R-013-17 位置は、画面（利用者）から直接は書き換えられない');
select is(pg_temp.rec('r16a', 'start_lat'), '35.691236', 'R-013-17 書き換えは効いていない');
select is(tests.n(tests.u('extA'), format('select 1 from public.buildings where id = %L and lat is not null', tests.id('buildingA1'))), 1::bigint, 'R-013-17 外部の人は、許された建物の位置（住所から分かる）は読める（002 の決め）。作業の位置は読めない');

-- ===== R-013-19・20 90 日で消す =====
-- 古い実績（100 日前・位置と距離つき）と新しい実績（10 日前）を、会社 A・B に作る
select pg_temp.mkwork('w19', 'done', array['staffA']);
insert into public.work_records (id, tenant_id, work_id, membership_id, started_at, ended_at, start_lat, start_lng, end_lat, end_lng, distance_m, distance_warning) values
  (tests.id('old-A'), tests.t('A'), tests.id('w19'), tests.id('m:A:staffA'), now() - interval '100 days', now() - interval '100 days' + interval '1 hour', 35.1, 139.1, 35.2, 139.2, 1500, true),
  (tests.id('new-A'), tests.t('A'), tests.id('w19'), tests.id('m:A:staffA'), now() - interval '10 days', now() - interval '10 days' + interval '1 hour', 35.1, 139.1, 35.2, 139.2, 50, false),
  (tests.id('edge-A'), tests.t('A'), tests.id('w19'), tests.id('m:A:staffA'), now() - interval '89 days', now() - interval '89 days' + interval '1 hour', 35.1, 139.1, 35.2, 139.2, 60, false),
  (tests.id('old-B'), tests.t('B'), tests.id('wB10'), tests.id('m:B:staffB'), now() - interval '120 days', now() - interval '120 days' + interval '1 hour', 34.1, 135.1, 34.2, 135.2, 20, false);
select ok((select array_agg(x order by x) from public.purge_locations_tenants() x) @> array[tests.t('A'), tests.t('B')], 'R-013-19 90 日を過ぎた位置のある会社が、一覧に出る');
select is(pg_temp.svc('purge_locations_run', format('%L', tests.t('A'))), '1'::jsonb, 'R-013-19 会社 A で、90 日を過ぎた実績 1 件の位置を空にした');
select is((select (start_lat is null and start_lng is null and end_lat is null and end_lng is null)::text from public.work_records where id = tests.id('old-A')), 'true', 'R-013-19 古い実績の位置の列（4 つ）が空になる');
select is((select distance_m::text || ',' || distance_warning::text from public.work_records where id = tests.id('old-A')), '1500,true', 'R-013-19 距離と警告は残る');
select is((select (ended_at is not null and started_at < now() - interval '99 days')::text from public.work_records where id = tests.id('old-A')), 'true', 'R-013-19 開始・終了の時刻と行は残る');
select is((select start_lat is not null and end_lng is not null from public.work_records where id = tests.id('new-A')), true, 'R-013-19 10 日前の実績の位置は消さない');
select is((select start_lat is not null from public.work_records where id = tests.id('edge-A')), true, 'R-013-19 89 日前の実績（90 日以内）の位置は消さない');
select is((select start_lat is not null from public.work_records where id = tests.id('old-B')), true, 'R-013-20 ほかの会社の実績には触れない');
select ok(not ((select array_agg(x) from public.purge_locations_tenants() x) @> array[tests.t('A')]), 'R-013-20 消し終えた会社は、一覧から外れる');
select is(pg_temp.svc('purge_locations_run', format('%L', tests.t('A'))), '0'::jsonb, 'R-013-19 もう一度流しても、増えも壊れもしない（0 件）');
select is(tests.run_as(tests.u('adminA'), 'select count(*) from public.purge_locations_tenants()') ->> 'error', '42501', 'R-013-20 利用者は、掃除の一覧を呼べない');
select is(tests.run_as(tests.u('adminA'), format('select public.purge_locations_run(%L)', tests.t('A'))) ->> 'error', '42501', 'R-013-20 利用者は、掃除を実行できない');
select is(tests.run_as_anon(format('select public.purge_locations_run(%L)', tests.t('A'))) ->> 'error', '42501', 'R-013-20 ログインしていない人は、掃除を実行できない');
select is(pg_temp.svcerr('purge_locations_start', format('%L', tests.t('A'))), null, 'R-013-20 service_role は処理を始められる');
select is((select kind || ',' || status from public.job_runs where tenant_id = tests.t('A') and kind = 'purge_locations'), 'purge_locations,running', 'R-013-20 処理の記録（種類 purge_locations）が会社ごとに残る');
select is(pg_temp.svc('purge_locations_start', format('%L', tests.t('A'))), 'null'::jsonb, 'R-013-20 同じ会社で動いている最中なら、始めない（null）');
select is(pg_temp.svc('purge_locations_finish', format('%L, (select id from public.job_runs where tenant_id = %L and kind = ''purge_locations''), ''success'', ''{"purged": 1}''::jsonb, null', tests.t('A'), tests.t('A'))), 'true'::jsonb, 'R-013-20 処理の記録を閉じられる');
select is((select count(*) from public.job_runs where kind = 'purge_locations' and tenant_id = tests.t('B')), 0::bigint, 'R-013-20 記録は、会社ごと（B はまだ流していない）');
select is(pg_temp.svc('purge_locations_run', format('%L', tests.t('B'))), '1'::jsonb, 'R-013-20 会社 B も、自分の分だけ消せる');
select is((select start_lat is null from public.work_records where id = tests.id('old-B')), true, 'R-013-19 会社 B の古い位置も消えた');

-- ===== 距離の計算（関数）と離れたとみなす距離 =====
select is(app.distance_m(35.681236, 139.767125, 35.681236, 139.767125), 0, 'R-013-15 同じ点の距離は 0');
select ok(app.distance_m(35.681236, 139.767125, 34.702485, 135.495951) between 395000 and 405000, 'R-013-15 東京駅と大阪駅の距離は約 400 km');
select is(app.distance_m(null, 139.0, 35.0, 139.0), null, 'R-013-15 空があれば距離は空');
select is(app.map_far_threshold_m(), 300, 'R-013-15 離れているとみなす距離は 300 m');

select * from finish();
rollback;
