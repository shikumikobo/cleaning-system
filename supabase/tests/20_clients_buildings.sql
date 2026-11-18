-- 機能 002：取引先・建物・部屋（R-002-1〜22）
begin;
select * from no_plan();
select tests.seed();

-- 便利：RPC を呼んで、戻りの jsonb を返す
create or replace function pg_temp.rpc(p_uid uuid, p_fn text, p_id uuid) returns jsonb language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%L) as r', p_fn, p_id)) -> 'rows' -> 0 -> 'r'
$$;
create or replace function pg_temp.rpc_err(p_uid uuid, p_fn text, p_id uuid) returns text language sql as $$
  select tests.run_as(p_uid, format('select public.%I(%L) as r', p_fn, p_id)) ->> 'error'
$$;
create or replace function pg_temp.deleted(p_table text, p_id uuid) returns boolean language plpgsql as $$
declare v boolean;
begin
  execute format('select deleted_at is not null from public.%I where id = %L', p_table, p_id) into v;
  return v;
end $$;
create or replace function pg_temp.reasons(p jsonb) returns text language sql as $$
  select coalesce(string_agg(b ->> 'reason', ',' order by b ->> 'reason'), '') from jsonb_array_elements(coalesce(p -> 'blockers', '[]')) b
$$;

-- 使われ方の登録の確かめは、各機能の本物の表で行う（仮の表はもう無い）

-- ===== R-002-1 取引先の登録 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.clients (tenant_id, kind, name, address, phone, email, closing_day, payment_terms)
  values (%L, 'management_company', 'テスト新規取引先', '東京都', '03-1111-2222', 'new@example.test', 25, '末締め翌月払い')$q$, tests.t('A'))), 1::bigint,
  'R-002-1 社員は取引先を登録できる');
select is(tests.cnt(tests.u('adminA'), format($q$insert into public.clients (tenant_id, kind, name) values (%L, 'owner', 'テスト新規オーナー')$q$, tests.t('A'))), 1::bigint,
  'R-002-1 管理者は取引先を登録できる（種類はオーナー。そのほかの項目は空でよい）');
select is(tests.n(tests.u('memberA'), $q$select 1 from public.clients where name = 'テスト新規取引先' and closing_day = 25 and kind = 'management_company'$q$), 1::bigint,
  'R-002-1 登録した取引先を読める');
select is(tests.cnt(tests.u('memberA'), format($q$update public.clients set phone = '03-9999-0000' where id = %L$q$, tests.id('clientA1'))), 1::bigint, 'R-002-1 社員は取引先を直せる');

-- ===== R-002-2 取引先の検査 =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.clients (tenant_id, kind, name) values (%L, 'owner', '')$q$, tests.t('A'))), '23514', 'R-002-2 名前が空なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.clients (tenant_id, kind, name) values (%L, 'owner', '   ')$q$, tests.t('A'))), '23514', 'R-002-2 名前が空白だけなら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.clients (tenant_id, kind, name) values (%L, 'tenant', 'x')$q$, tests.t('A'))), '23514', 'R-002-2 種類が決まった値以外なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.clients (tenant_id, kind, name, closing_day) values (%L, 'owner', 'x', 0)$q$, tests.t('A'))), '23514', 'R-002-2 締め日が 0 なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.clients (tenant_id, kind, name, closing_day) values (%L, 'owner', 'x', 32)$q$, tests.t('A'))), '23514', 'R-002-2 締め日が 32 なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.clients (tenant_id, kind, name, email) values (%L, 'owner', 'x', 'not-an-email')$q$, tests.t('A'))), '23514', 'R-002-2 メールが形に合わなければ保存しない');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.clients (tenant_id, kind, name, closing_day) values (%L, 'owner', '月末の取引先', 31)$q$, tests.t('A'))), 1::bigint, 'R-002-2 締め日 31（月末）は保存できる');

-- ===== R-002-3 担当者 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.client_contacts (tenant_id, client_id, name, email, phone) values (%L, %L, '新しい担当', 'c@example.test', '090')$q$, tests.t('A'), tests.id('clientA1'))), 1::bigint,
  'R-002-3 社員は担当者を登録できる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.client_contacts set phone = '080' where id = %L$q$, tests.id('contactA1'))), 1::bigint, 'R-002-3 社員は担当者を直せる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.client_contacts set deleted_at = now() where id = %L$q$, tests.id('contactA1'))), 1::bigint, 'R-002-3 社員は担当者を消せる（論理削除）');
select is(tests.err(tests.u('memberA'), format($q$insert into public.client_contacts (tenant_id, client_id, name) values (%L, %L, '')$q$, tests.t('A'), tests.id('clientA1'))), '23514', 'R-002-3 担当者の名前が空なら保存しない');

-- ===== R-002-4 建物の登録 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.buildings (id, tenant_id, client_id, owner_client_id, name, address) values (%L, %L, %L, %L, '新しい建物', '東京都A区9-9')$q$,
  tests.id('newBuilding'), tests.t('A'), tests.id('clientA1'), tests.id('ownerA'))), 1::bigint, 'R-002-4 社員は依頼元と所有者を付けて建物を登録できる');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.buildings (tenant_id, client_id, name, address) values (%L, %L, '所有者なしの建物', '東京都A区9-8')$q$,
  tests.t('A'), tests.id('clientA1'))), 1::bigint, 'R-002-4 所有者は空でもよい');
select is(tests.err(tests.u('memberA'), format($q$insert into public.buildings (tenant_id, name, address) values (%L, '依頼元なし', 'x')$q$, tests.t('A'))), '23502', 'R-002-4 依頼元がなければ保存しない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.buildings (tenant_id, client_id, name, address) values (%L, %L, '', 'x')$q$, tests.t('A'), tests.id('clientA1'))), '23514', 'R-002-4 名前が空なら保存しない');

-- ===== R-002-5 別の会社の行を親にできない =====
select is(tests.err(tests.u('memberA'), format($q$insert into public.buildings (tenant_id, client_id, name, address) values (%L, %L, 'x', 'x')$q$, tests.t('A'), tests.id('clientB1'))), '23503',
  'R-002-5 別の会社の取引先を、建物の依頼元にできない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.buildings (tenant_id, client_id, owner_client_id, name, address) values (%L, %L, %L, 'x', 'x')$q$, tests.t('A'), tests.id('clientA1'), tests.id('ownerB'))), '23503',
  'R-002-5 別の会社の取引先を、建物の所有者にできない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.client_contacts (tenant_id, client_id, name) values (%L, %L, 'x')$q$, tests.t('A'), tests.id('clientB1'))), '23503',
  'R-002-5 別の会社の取引先に、担当者を付けられない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.building_profiles (tenant_id, building_id) values (%L, %L)$q$, tests.t('A'), tests.id('buildingB1'))), '23503',
  'R-002-5 別の会社の建物に、カルテを付けられない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.rooms (tenant_id, building_id, room_no) values (%L, %L, '999')$q$, tests.t('A'), tests.id('buildingB1'))), '23503',
  'R-002-5 別の会社の建物に、部屋を付けられない');
select is(tests.err(tests.u('memberA'), format($q$insert into public.building_areas (tenant_id, building_id, name) values (%L, %L, '屋上')$q$, tests.t('A'), tests.id('buildingB1'))), '23503',
  'R-002-5 別の会社の建物に、場所を付けられない');
select is(tests.run_as_service(format($q$insert into public.memberships (tenant_id, user_id, role_id, client_id) values (%L, %L, (select id from public.roles where code = 'external'), %L)$q$,
  tests.t('A'), tests.u('nobody'), tests.id('clientB1'))) ->> 'error', '23503', 'R-002-5 別の会社の取引先を、所属（外部の人）に付けられない');
select is(tests.run_as_service(format($q$insert into public.external_building_access (tenant_id, membership_id, building_id) values (%L, %L, %L)$q$,
  tests.t('A'), tests.id('m:A:extA'), tests.id('buildingB1'))) ->> 'error', '23503', 'R-002-5 別の会社の建物を、外部の人の見られる建物に入れられない');
select is(tests.run_as_service(format($q$insert into public.memberships (tenant_id, user_id, role_id, client_id) values (%L, %L, (select id from public.roles where code = 'external'), %L)$q$,
  tests.t('A'), tests.u('nobody'), tests.id('clientA1'))) ->> 'error', null, 'R-002-5 同じ会社の取引先は、所属（外部の人）に付けられる');

-- ===== R-002-6 位置 =====
select is(tests.err(tests.u('memberA'), format($q$update public.buildings set lat = 35.0 where id = %L$q$, tests.id('buildingA2'))), '23514', 'R-002-6 緯度だけでは保存しない');
select is(tests.err(tests.u('memberA'), format($q$update public.buildings set lng = 139.0 where id = %L$q$, tests.id('buildingA2'))), '23514', 'R-002-6 経度だけでは保存しない');
select is(tests.err(tests.u('memberA'), format($q$update public.buildings set lat = 91, lng = 139 where id = %L$q$, tests.id('buildingA2'))), '23514', 'R-002-6 緯度が範囲の外なら保存しない');
select is(tests.err(tests.u('memberA'), format($q$update public.buildings set lat = 35, lng = 181 where id = %L$q$, tests.id('buildingA2'))), '23514', 'R-002-6 経度が範囲の外なら保存しない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.buildings set lat = 35.681236, lng = 139.767125 where id = %L$q$, tests.id('buildingA2'))), 1::bigint, 'R-002-6 緯度と経度が両方あれば保存できる');
-- 013：人が位置を変えると、直した印が付く（R-013-6）。ここは「誰も直していない建物の印は、初めは偽」を確かめる（A1 は種で位置が入るが、定時の処理の書き込みと同じ扱いで、印は付かない）
select is(tests.run_as(tests.u('memberA'), format($q$select location_fixed as v from public.buildings where id = %L$q$, tests.id('buildingA1'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-002-6 位置を直した印は、初めは偽');

-- ===== R-002-7 カルテ =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.building_profiles (tenant_id, building_id, entry, key_place, parking, garbage_days, manager_contact, cautions)
  values (%L, %L, '裏口から', 'ポスト', '近くのコインP', '火・金', '管理人 090', '階段が狭い')$q$, tests.t('A'), tests.id('buildingA2'))), 1::bigint, 'R-002-7 社員はカルテを保存できる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.building_profiles (tenant_id, building_id) values (%L, %L)$q$, tests.t('A'), tests.id('buildingA2'))), '23505', 'R-002-7 1つの建物に2つ目のカルテは作れない');
select is(tests.cnt(tests.u('memberA'), format($q$update public.building_profiles set key_place = '管理室' where building_id = %L$q$, tests.id('buildingA2'))), 1::bigint, 'R-002-7 社員はカルテを直せる');
select is(tests.run_as_service(format($q$update public.building_profiles set deleted_at = now() where building_id = %L$q$, tests.id('buildingA2'))) ->> 'error', null, '（準備）カルテを消した行にする');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.building_profiles (tenant_id, building_id) values (%L, %L)$q$, tests.t('A'), tests.id('buildingA2'))), 1::bigint, 'R-002-7 消したカルテのあとは、新しいカルテを作れる');

-- ===== R-002-8 カルテを読める人 =====
select is(tests.n(tests.u('staffA'), format($q$select 1 from public.building_profiles where building_id = %L$q$, tests.id('buildingA1'))), 1::bigint, 'R-002-8 スタッフはカルテを読める');
select is(tests.n(tests.u('memberA'), format($q$select 1 from public.building_profiles where building_id = %L$q$, tests.id('buildingA1'))), 1::bigint, 'R-002-8 社員はカルテを読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.building_profiles'), 0::bigint, 'R-002-8 外部の人は、許された建物のカルテも読めない');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.external_building_access where building_id = %L$q$, tests.id('buildingA1'))), 1::bigint, '（前提）外部の人 extA は buildingA1 を許されている');
select is(tests.n(tests.u('adminB'), format($q$select 1 from public.building_profiles where building_id = %L$q$, tests.id('buildingA1'))), 0::bigint, 'R-002-8 別の会社の人は、カルテを読めない');

-- ===== R-002-9 外部の人 =====
select is(tests.run_as(tests.u('extA'), 'select name from public.buildings order by name') -> 'rows' -> 0 ->> 'name', 'テストマンションA1', 'R-002-9 外部の人は、許された建物の名前を読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.buildings'), 1::bigint, 'R-002-9 外部の人は、許されていない建物（同じ会社の別の建物）を読めない');
select is(tests.run_as(tests.u('extA'), 'select address from public.buildings') -> 'rows' -> 0 ->> 'address', '東京都A区1-1-1', 'R-002-9 外部の人は、許された建物の住所を読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.clients'), 0::bigint, 'R-002-9 外部の人は取引先を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.client_contacts'), 0::bigint, 'R-002-9 外部の人は担当者を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.rooms'), 0::bigint, 'R-002-9 外部の人は部屋を読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.building_areas'), 0::bigint, 'R-002-9 外部の人は場所を読めない');
select is(tests.n(tests.u('extB'), format($q$select 1 from public.buildings where id = %L$q$, tests.id('buildingA1'))), 0::bigint, 'R-002-9 別の会社の外部の人は、建物を読めない');

-- ===== R-002-10 部屋 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.rooms (tenant_id, building_id, room_no, floor) values (%L, %L, '102', 1)$q$, tests.t('A'), tests.id('buildingA1'))), 1::bigint, 'R-002-10 社員は部屋を登録できる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.rooms (tenant_id, building_id, room_no, floor) values (%L, %L, '101', 1)$q$, tests.t('A'), tests.id('buildingA1'))), '23505', 'R-002-10 同じ建物に同じ部屋番号は2つ作れない');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.rooms (tenant_id, building_id, room_no, floor) values (%L, %L, '101', 1)$q$, tests.t('A'), tests.id('buildingA2'))), 1::bigint, 'R-002-10 別の建物なら同じ部屋番号を作れる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.rooms (tenant_id, building_id, room_no) values (%L, %L, '')$q$, tests.t('A'), tests.id('buildingA1'))), '23514', 'R-002-10 部屋番号が空なら保存しない');
select is((select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'rooms'),
  'active,building_id,created_at,created_by,deleted_at,floor,id,room_no,tenant_id,updated_at,updated_by', 'R-002-10 部屋は入居者の名前を持たない（列は部屋番号・階・使うかだけ）');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_room', tests.id('roomA1')) ->> 'deleted', 'true', '（準備）部屋 101 を消す');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.rooms (tenant_id, building_id, room_no, floor) values (%L, %L, '101', 1)$q$, tests.t('A'), tests.id('buildingA1'))), 1::bigint, 'R-002-10 消した部屋の番号は、作り直せる');

-- ===== R-002-11 場所 =====
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.building_areas (tenant_id, building_id, name, sort) values (%L, %L, '階段', 2)$q$, tests.t('A'), tests.id('buildingA1'))), 1::bigint, 'R-002-11 社員は場所を登録できる');
select is(tests.err(tests.u('memberA'), format($q$insert into public.building_areas (tenant_id, building_id, name) values (%L, %L, '階段')$q$, tests.t('A'), tests.id('buildingA1'))), '23505', 'R-002-11 同じ建物に同じ名前の場所は2つ作れない');
select is(tests.cnt(tests.u('memberA'), format($q$insert into public.building_areas (tenant_id, building_id, name) values (%L, %L, '屋上')$q$, tests.t('A'), tests.id('buildingA1'))), 1::bigint, '（準備）並び順を省いて場所を登録する');
select is((select sort from public.building_areas where building_id = tests.id('buildingA1') and name = '屋上'), 0, 'R-002-11 並び順を省くと 0 で保存される');
select is(tests.err(tests.u('memberA'), format($q$insert into public.building_areas (tenant_id, building_id, name) values (%L, %L, '')$q$, tests.t('A'), tests.id('buildingA1'))), '23514', 'R-002-11 場所の名前が空なら保存しない');

-- ===== R-002-12 使わない =====
select is(tests.cnt(tests.u('memberA'), format($q$update public.rooms set active = false where building_id = %L and room_no = '102'$q$, tests.id('buildingA1'))), 1::bigint, 'R-002-12 社員は部屋を「使わない」にできる');
select is(tests.run_as(tests.u('memberA'), format($q$select active as v from public.rooms where building_id = %L and room_no = '102'$q$, tests.id('buildingA1'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-002-12 「使わない」の部屋も、行として読める（一覧に印をつけて出す）');
select is(tests.cnt(tests.u('memberA'), format($q$update public.rooms set active = true where building_id = %L and room_no = '102'$q$, tests.id('buildingA1'))), 1::bigint, 'R-002-12 「使う」に戻せる');
select is(tests.cnt(tests.u('memberA'), format($q$update public.building_areas set active = false where id = %L$q$, tests.id('areaA1'))), 1::bigint, 'R-002-12 社員は場所を「使わない」にできる');
select is(tests.run_as(tests.u('memberA'), format($q$select active as v from public.building_areas where id = %L$q$, tests.id('areaA1'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-002-12 「使わない」の場所の状態が保存される');
select is(tests.run_as(tests.u('memberA'), format($q$select active as v from public.rooms where id = %L$q$, tests.id('roomB1'))) -> 'rows', '[]'::jsonb, '（前提）別の会社の部屋は読めない');

-- ===== R-002-13 権限のない人は作れず・直せない =====
create temp table _w (label text, ins text, upd text) on commit drop;
insert into _w values
  ('clients', format($q$insert into public.clients (tenant_id, kind, name) values (%L, 'owner', 'x')$q$, tests.t('A')), format($q$update public.clients set name = 'z' where id = %L$q$, tests.id('clientA1'))),
  ('client_contacts', format($q$insert into public.client_contacts (tenant_id, client_id, name) values (%L, %L, 'x')$q$, tests.t('A'), tests.id('clientA1')), format($q$update public.client_contacts set name = 'z' where id = %L$q$, tests.id('contactA1'))),
  ('buildings', format($q$insert into public.buildings (tenant_id, client_id, name, address) values (%L, %L, 'x', 'x')$q$, tests.t('A'), tests.id('clientA1')), format($q$update public.buildings set name = 'z' where id = %L$q$, tests.id('buildingA1'))),
  ('building_profiles', format($q$insert into public.building_profiles (tenant_id, building_id) values (%L, %L)$q$, tests.t('A'), tests.id('buildingA1')), format($q$update public.building_profiles set cautions = 'z' where id = %L$q$, tests.id('profA1'))),
  ('rooms', format($q$insert into public.rooms (tenant_id, building_id, room_no) values (%L, %L, 'zz')$q$, tests.t('A'), tests.id('buildingA1')), format($q$update public.rooms set floor = 9 where building_id = %L$q$, tests.id('buildingA1'))),
  ('building_areas', format($q$insert into public.building_areas (tenant_id, building_id, name) values (%L, %L, 'zz')$q$, tests.t('A'), tests.id('buildingA1')), format($q$update public.building_areas set sort = 9 where id = %L$q$, tests.id('areaA1')));
-- 作れない（エラー）・直せない（エラーか、0 行）
create or replace function pg_temp.blocked(p_uid uuid) returns text language plpgsql as $$
declare r record; v text := ''; e text; c bigint;
begin
  for r in select * from _w loop
    e := case when p_uid is null then tests.run_as_anon(r.ins) ->> 'error' else tests.err(p_uid, r.ins) end;
    if e is null then v := v || r.label || ':insert,'; end if;
    if p_uid is null then
      e := tests.run_as_anon(r.upd) ->> 'error'; c := 0;
    else
      e := tests.err(p_uid, r.upd); c := tests.cnt(p_uid, r.upd);
    end if;
    if e is null and c > 0 then v := v || r.label || ':update,'; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.blocked(tests.u('staffA')), '', 'R-002-13 スタッフは、6つの表のどれも作れず・直せない');
select is(pg_temp.blocked(tests.u('extA')), '', 'R-002-13 外部の人は、6つの表のどれも作れず・直せない');
select is(pg_temp.blocked(tests.u('operator')), '', 'R-002-13 運営は（許可がなくても）6つの表のどれも作れず・直せない');
select is(pg_temp.blocked(tests.u('nobody')), '', 'R-002-13 どの会社にも属さない人は、6つの表のどれも作れず・直せない');
select is(pg_temp.blocked(null), '', 'R-002-13 ログインしていない人は、6つの表のどれも作れず・直せない');
select is(pg_temp.blocked(tests.u('adminB')), '', 'R-002-13 別の会社の管理者は、A の6つの表のどれも作れず・直せない');
select ok(tests.n(tests.u('staffA'), 'select 1 from public.clients') >= 2, 'R-002-13 スタッフは取引先を読める');
select ok(tests.n(tests.u('staffA'), 'select 1 from public.buildings') >= 2, 'R-002-13 スタッフは建物を読める');
select ok(tests.n(tests.u('staffA'), 'select 1 from public.rooms') >= 1, 'R-002-13 スタッフは部屋を読める');
select ok(tests.n(tests.u('staffA'), 'select 1 from public.building_areas') >= 1, 'R-002-13 スタッフは場所を読める');
select ok(tests.n(tests.u('staffA'), 'select 1 from public.client_contacts') >= 1, 'R-002-13 スタッフは担当者を読める');

-- 後の検査のための準備（運営の許可は、読むだけ）
insert into public.support_access_grants (id, tenant_id, granted_by, reason, starts_at, ends_at)
values (tests.id('grantA-002'), tests.t('A'), tests.u('adminA'), '問い合わせ', now() - interval '1 hour', now() + interval '1 hour');
select ok(tests.n(tests.u('operator'), 'select 1 from public.buildings') >= 2, 'R-002-13 運営は、許可の間だけ建物を読める');
select is(pg_temp.blocked(tests.u('operator')), '', 'R-002-13 運営は、許可の間も、書けない');

-- ===== R-002-14 取引先を消す =====
insert into public.clients (id, tenant_id, kind, name) values (tests.id('clientX'), tests.t('A'), 'owner', 'テスト消す取引先');
insert into public.client_contacts (id, tenant_id, client_id, name) values (tests.id('contactX'), tests.t('A'), tests.id('clientX'), '消す担当');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('clientX')) ->> 'ok', 'true', 'R-002-14 社員は、使われていない取引先を消せる');
select is(pg_temp.deleted('clients', tests.id('clientX')), true, 'R-002-14 取引先は論理削除される');
select is(pg_temp.deleted('client_contacts', tests.id('contactX')), true, 'R-002-14 担当者も一緒に論理削除される');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('clientX')) ->> 'already', 'true', 'R-002-14 二度呼んでも、同じ結果で終わる');

-- ===== R-002-15 取引先は、使われていれば消さない =====
select is(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('clientA1')) ->> 'ok', 'false', 'R-002-15 建物があれば、取引先を消さない');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('clientA1'))), 'has_buildings', 'R-002-15 理由は has_buildings');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('clientA1')) -> 'blockers' -> 0 ->> 'count', (select count(*)::text from public.buildings where client_id = tests.id('clientA1') and deleted_at is null), 'R-002-15 理由に件数（その取引先の建物の数）が付く');
select is(pg_temp.deleted('clients', tests.id('clientA1')), false, 'R-002-15 消されていない');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('ownerA'))), 'has_buildings', 'R-002-15 所有者として建物から使われていても、消さない');
-- 契約・請求書
insert into public.clients (id, tenant_id, kind, name) values (tests.id('clientC'), tests.t('A'), 'management_company', 'テスト契約のある取引先');
insert into public.contracts (tenant_id, client_id, building_id, source, kind, start_date, end_date, status)
  values (tests.t('A'), tests.id('clientC'), tests.id('buildingA2'), 'import', 'one_time', date '2026-01-01', date '2026-01-02', 'ended');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('clientC'))), 'has_contracts', 'R-002-15 契約があれば（終了したものも）、取引先を消さない');
insert into public.clients (id, tenant_id, kind, name) values (tests.id('clientI'), tests.t('A'), 'management_company', 'テスト請求のある取引先');
insert into public.invoices (tenant_id, client_id, period) values (tests.t('A'), tests.id('clientI'), date '2026-01-01');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('clientI'))), 'has_invoices', 'R-002-15 請求書があれば、取引先を消さない');
update public.invoices set deleted_at = now() where client_id = tests.id('clientI');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_client', tests.id('clientI')) ->> 'ok', 'true', 'R-002-15 請求書が消されていれば、取引先を消せる');

-- ===== R-002-17 建物は、先の予定・有効な契約があれば消さない =====
insert into public.buildings (id, tenant_id, client_id, name, address) values
  (tests.id('bW'), tests.t('A'), tests.id('clientA1'), 'テスト予定のある建物', 'x'),
  (tests.id('bC'), tests.t('A'), tests.id('clientA1'), 'テスト契約のある建物', 'x'),
  (tests.id('bP'), tests.t('A'), tests.id('clientA1'), 'テスト過去だけの建物', 'x');
insert into public.works (tenant_id, building_id, request_id, title, scheduled_date, status) values
  (tests.t('A'), tests.id('bW'), tests.id('reqA-1'), '予定のある作業', (now() at time zone 'Asia/Tokyo')::date + 3, 'scheduled'),
  (tests.t('A'), tests.id('bP'), tests.id('reqA-1'), '過去の作業', (now() at time zone 'Asia/Tokyo')::date - 3, 'scheduled'),
  (tests.t('A'), tests.id('bP'), tests.id('reqA-1'), '取り消した作業', (now() at time zone 'Asia/Tokyo')::date + 3, 'cancelled');
insert into public.contracts (tenant_id, client_id, building_id, source, kind, start_date, end_date, status) values
  (tests.t('A'), tests.id('clientA1'), tests.id('bC'), 'import', 'recurring', date '2026-01-01', null, 'active'),
  (tests.t('A'), tests.id('clientA1'), tests.id('bP'), 'import', 'one_time', date '2026-01-01', date '2026-01-02', 'ended');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_building', tests.id('bW'))), 'has_future_works', 'R-002-17 先の予定の作業があれば、建物を消さない');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_building', tests.id('bW')) -> 'blockers' -> 0 ->> 'count', '1', 'R-002-17 理由に件数が付く');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_building', tests.id('bC'))), 'has_active_contracts', 'R-002-17 有効な契約があれば、建物を消さない');
select is(pg_temp.deleted('buildings', tests.id('bW')) or pg_temp.deleted('buildings', tests.id('bC')), false, 'R-002-17 止めたとき、建物は消えない');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_building', tests.id('bP')) ->> 'ok', 'true', 'R-002-17 過去の作業・取り消した作業・終了した契約だけなら、建物を消せる');

-- ===== R-002-16 建物を消すと、子も一緒に消える =====
-- （この検査は1つの transaction。本物は操作ごとに別の transaction なので、操作の印をここで外す）
select set_config('app.request_id', '', true), set_config('app.source', '', true);
insert into public.buildings (id, tenant_id, client_id, name, address) values (tests.id('bD'), tests.t('A'), tests.id('clientA1'), 'テスト消す建物', 'x');
insert into public.building_profiles (id, tenant_id, building_id) values (tests.id('bD-prof'), tests.t('A'), tests.id('bD'));
insert into public.rooms (id, tenant_id, building_id, room_no) values (tests.id('bD-room'), tests.t('A'), tests.id('bD'), '1');
insert into public.building_areas (id, tenant_id, building_id, name) values (tests.id('bD-area'), tests.t('A'), tests.id('bD'), 'ロビー');
insert into public.external_building_access (id, tenant_id, membership_id, building_id) values (tests.id('bD-eba'), tests.t('A'), tests.id('m:A:extA'), tests.id('bD'));
insert into public.report_templates (id, tenant_id, building_id, name) values (tests.id('bD-tpl'), tests.t('A'), tests.id('bD'), 'テストひな形');
insert into public.template_items (id, tenant_id, template_id, name) values (tests.id('bD-item'), tests.t('A'), tests.id('bD-tpl'), 'テスト項目');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.buildings where id = %L and deleted_at is null$q$, tests.id('bD'))), 1::bigint, '（前提）消す前、外部の人は建物 bD を読める');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_building', tests.id('bD')) ->> 'ok', 'true', 'R-002-16 社員は建物を消せる');
select is(pg_temp.deleted('buildings', tests.id('bD')), true, 'R-002-16 建物は論理削除される');
select is(pg_temp.deleted('building_profiles', tests.id('bD-prof')), true, 'R-002-16 カルテも一緒に消える');
select is(pg_temp.deleted('rooms', tests.id('bD-room')), true, 'R-002-16 部屋も一緒に消える');
select is(pg_temp.deleted('building_areas', tests.id('bD-area')), true, 'R-002-16 場所も一緒に消える');
select is(pg_temp.deleted('external_building_access', tests.id('bD-eba')), true, 'R-002-16 外部の人の見られる建物の行も一緒に消える');
select is(pg_temp.deleted('report_templates', tests.id('bD-tpl')), true, 'R-002-16 ひな形も一緒に消える');
select is(pg_temp.deleted('template_items', tests.id('bD-item')), true, 'R-002-16 ひな形の項目（ひな形を通して建物につく行）も一緒に消える');
select is(tests.n(tests.u('extA'), format($q$select 1 from public.external_building_access where building_id = %L and deleted_at is null$q$, tests.id('bD'))), 0::bigint, 'R-002-16 消した建物は、外部の人の見られる建物に残らない');
select is(pg_temp.deleted('buildings', tests.id('buildingA1')), false, 'R-002-16 ほかの建物と、その子は消えない');
select is(pg_temp.deleted('rooms', tests.id('bD-room')) and not pg_temp.deleted('building_areas', tests.id('areaA1')), true, 'R-002-16 別の建物の場所は消えない');

-- ===== R-002-18 部屋・場所を消す =====
insert into public.rooms (id, tenant_id, building_id, room_no) values (tests.id('r-free'), tests.t('A'), tests.id('buildingA2'), 'free'), (tests.id('r-req'), tests.t('A'), tests.id('buildingA2'), 'req'), (tests.id('r-pho'), tests.t('A'), tests.id('buildingA2'), 'pho');
insert into public.requests (tenant_id, client_id, building_id, room_id, title) values (tests.t('A'), tests.id('clientA1'), tests.id('buildingA2'), tests.id('r-req'), '部屋を使う案件');
select tests.make_photo('A', 'ph-room', 'buildingA2', 'staffA', 'before', format('room_id|%L', tests.id('r-pho')));
select is(pg_temp.rpc(tests.u('memberA'), 'delete_room', tests.id('r-free')) ->> 'deleted', 'true', 'R-002-18 使われていない部屋は、論理削除される');
select is(pg_temp.deleted('rooms', tests.id('r-free')), true, 'R-002-18 使われていない部屋の deleted_at が入る');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_room', tests.id('r-req')) ->> 'deleted', 'false', 'R-002-18 案件から使われている部屋は、消さない');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_room', tests.id('r-req')) ->> 'deactivated', 'true', 'R-002-18 そのかわり「使わない」にしたと返す');
select is((select active from public.rooms where id = tests.id('r-req')), false, 'R-002-18 案件から使われている部屋は「使わない」になっている');
select is(pg_temp.deleted('rooms', tests.id('r-req')), false, 'R-002-18 使われている部屋の行は残る');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_room', tests.id('r-pho'))), 'used_by_photos', 'R-002-18 写真から使われている部屋も、消さず理由を返す');
insert into public.building_areas (id, tenant_id, building_id, name) values (tests.id('a-free'), tests.t('A'), tests.id('buildingA2'), '使われてない'), (tests.id('a-pho'), tests.t('A'), tests.id('buildingA2'), '写真の場所'), (tests.id('a-tpl'), tests.t('A'), tests.id('buildingA2'), 'ひな形の場所');
select tests.make_photo('A', 'ph-area', 'buildingA2', 'staffA', 'before', format('area_id|%L', tests.id('a-pho')));
insert into public.report_templates (id, tenant_id, building_id, name) values (tests.id('a-tpl-t'), tests.t('A'), tests.id('buildingA2'), '場所のひな形');
insert into public.template_items (tenant_id, template_id, area_id, name) values (tests.t('A'), tests.id('a-tpl-t'), tests.id('a-tpl'), '場所の項目');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_building_area', tests.id('a-free')) ->> 'deleted', 'true', 'R-002-18 使われていない場所は、論理削除される');
select is(pg_temp.rpc(tests.u('memberA'), 'delete_building_area', tests.id('a-pho')) ->> 'deactivated', 'true', 'R-002-18 写真から使われている場所は、消さず「使わない」にする');
select is(pg_temp.reasons(pg_temp.rpc(tests.u('memberA'), 'delete_building_area', tests.id('a-tpl'))), 'used_by_template_items', 'R-002-18 ひな形の項目から使われている場所も、消さず理由を返す');
select is((select active from public.building_areas where id = tests.id('a-tpl')) or pg_temp.deleted('building_areas', tests.id('a-tpl')), false, 'R-002-18 ひな形から使われている場所は、「使わない」になり、行は残る');

-- ===== R-002-19 消す RPC を呼べる人 =====
insert into public.clients (id, tenant_id, kind, name) values (tests.id('clientZ'), tests.t('A'), 'owner', 'テスト消されない取引先');
insert into public.buildings (id, tenant_id, client_id, name, address) values (tests.id('bZ'), tests.t('A'), tests.id('clientA1'), 'テスト消されない建物', 'x');
insert into public.rooms (id, tenant_id, building_id, room_no) values (tests.id('rZ'), tests.t('A'), tests.id('bZ'), 'z');
insert into public.building_areas (id, tenant_id, building_id, name) values (tests.id('aZ'), tests.t('A'), tests.id('bZ'), 'z');
create temp table _rpc (fn text, id uuid) on commit drop;
insert into _rpc values ('delete_client', tests.id('clientZ')), ('delete_building', tests.id('bZ')), ('delete_room', tests.id('rZ')), ('delete_building_area', tests.id('aZ'));
create or replace function pg_temp.rpc_refused(p_uid uuid) returns text language plpgsql as $$
declare r record; v text := ''; e text;
begin
  for r in select * from _rpc loop
    e := case when p_uid is null then tests.run_as_anon(format('select public.%I(%L)', r.fn, r.id)) ->> 'error' else pg_temp.rpc_err(p_uid, r.fn, r.id) end;
    if e is distinct from '42501' then v := v || r.fn || ':' || coalesce(e, 'ok') || ','; end if;
  end loop;
  return v;
end $$;
select is(pg_temp.rpc_refused(tests.u('staffA')), '', 'R-002-19 スタッフは、4つの消す RPC を実行できない');
select is(pg_temp.rpc_refused(tests.u('extA')), '', 'R-002-19 外部の人は、4つの消す RPC を実行できない');
select is(pg_temp.rpc_refused(tests.u('adminB')), '', 'R-002-19 別の会社の管理者は、4つの消す RPC を実行できない');
select is(pg_temp.rpc_refused(tests.u('operator')), '', 'R-002-19 運営は、4つの消す RPC を実行できない');
select is(pg_temp.rpc_refused(tests.u('nobody')), '', 'R-002-19 どの会社にも属さない人は、4つの消す RPC を実行できない');
select is(pg_temp.rpc_refused(null), '', 'R-002-19 ログインしていない人は、4つの消す RPC を実行できない');
select is(pg_temp.rpc_err(tests.u('memberA'), 'delete_client', tests.id('clientB1')), '42501', 'R-002-19 別の会社の取引先の ID を渡しても、存在を教えない（権限がないのと同じ答え）');
select is(pg_temp.rpc_err(tests.u('memberA'), 'delete_client', tests.id('no-such')), '42501', 'R-002-19 ない ID も、同じ答え');
select is((select count(*)::int from public.clients where id = tests.id('clientZ') and deleted_at is null)
        + (select count(*)::int from public.buildings where id = tests.id('bZ') and deleted_at is null)
        + (select count(*)::int from public.rooms where id = tests.id('rZ') and deleted_at is null)
        + (select count(*)::int from public.building_areas where id = tests.id('aZ') and deleted_at is null), 4, 'R-002-19 断られたとき、何も消えていない');
select is((select count(*)::int from public.clients where id = tests.id('clientB1') and deleted_at is null), 1, 'R-002-19 別の会社の取引先も消えていない');

-- ===== R-002-20 deleted_at を直接書けない =====
select is(tests.err(tests.u('memberA'), format($q$update public.clients set deleted_at = now() where id = %L$q$, tests.id('clientZ'))), '42501', 'R-002-20 取引先の deleted_at を直接は書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.buildings set deleted_at = now() where id = %L$q$, tests.id('bZ'))), '42501', 'R-002-20 建物の deleted_at を直接は書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.building_profiles set deleted_at = now() where id = %L$q$, tests.id('profA1'))), '42501', 'R-002-20 カルテの deleted_at を直接は書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.rooms set deleted_at = now() where id = %L$q$, tests.id('rZ'))), '42501', 'R-002-20 部屋の deleted_at を直接は書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.building_areas set deleted_at = now() where id = %L$q$, tests.id('aZ'))), '42501', 'R-002-20 場所の deleted_at を直接は書けない');
select is(tests.err(tests.u('adminA'), format($q$update public.clients set deleted_at = now() where id = %L$q$, tests.id('clientZ'))), '42501', 'R-002-20 管理者も、直接は書けない');
select is(tests.err(tests.u('memberA'), format($q$update public.clients set deleted_at = null, name = 'ほかの列は直せる' where id = %L$q$, tests.id('clientZ'))), '42501', 'R-002-20 deleted_at を含む更新は、ほかの列と一緒でも断る');
select is(tests.cnt(tests.u('memberA'), format($q$update public.clients set name = 'ほかの列は直せる' where id = %L$q$, tests.id('clientZ'))), 1::bigint, 'R-002-20 deleted_at を含まなければ、直せる');

-- ===== R-002-21 検索 =====
insert into public.clients (tenant_id, kind, name) values (tests.t('A'), 'owner', '検索用ほしぞら不動産'), (tests.t('A'), 'owner', '検索用つきみ管理');
insert into public.buildings (tenant_id, client_id, name, address) values (tests.t('A'), tests.id('clientA1'), '検索用ほしぞらハイツ', 'x'), (tests.t('A'), tests.id('clientA1'), '検索用つきみ荘', 'x');
select is(tests.n(tests.u('memberA'), $q$select 1 from public.clients where name ilike '%ほしぞら%' and deleted_at is null$q$), 1::bigint, 'R-002-21 取引先を名前の一部で見つけられる');
select is(tests.n(tests.u('memberA'), $q$select 1 from public.buildings where name ilike '%ほしぞら%' and deleted_at is null$q$), 1::bigint, 'R-002-21 建物を名前の一部で見つけられる');
select is(tests.n(tests.u('memberA'), $q$select 1 from public.buildings where name ilike '%検索用%' and deleted_at is null$q$), 2::bigint, 'R-002-21 共通の語で、複数を見つけられる');
select is(tests.n(tests.u('memberA'), $q$select 1 from public.clients where name ilike '%テスト消す取引先%' and deleted_at is null$q$), 0::bigint, 'R-002-21 消した取引先は、（消した行を除く条件で）出ない');
select is(tests.n(tests.u('memberA'), $q$select 1 from public.buildings where name ilike '%ほしぞら%'$q$), 1::bigint, 'R-002-21 別の会社の建物は、検索でも出ない（会社 A の1件だけ）');
select is((select count(*)::int from pg_indexes where schemaname = 'public' and tablename = 'clients' and indexdef ~ 'gin' and indexdef ~ 'gin_trgm_ops'), 1, 'R-002-21 取引先の名前に、部分一致の索引（pg_trgm）がある');
select is((select count(*)::int from pg_indexes where schemaname = 'public' and tablename = 'buildings' and indexdef ~ 'gin' and indexdef ~ 'gin_trgm_ops'), 1, 'R-002-21 建物の名前に、部分一致の索引（pg_trgm）がある');

-- ===== R-002-22 履歴 =====
select set_config('app.request_id', '', true), set_config('app.source', '', true);
select is(tests.cnt(tests.u('memberA'), format($q$update public.clients set name = '履歴を見る取引先' where id = %L$q$, tests.id('clientA1'))), 1::bigint, '（準備）取引先の名前を直す');
select is((select count(*)::int from public.audit_logs where table_name = 'clients' and row_id = tests.id('clientA1') and action = 'update'
           and changed -> 'name' ->> 'new' = '履歴を見る取引先' and actor = tests.u('memberA') and source = 'ui'), 1, 'R-002-22 取引先を直すと、だれが・何を（前と後）・どこから、が履歴に残る');
select is((select count(*)::int from public.audit_logs where table_name = 'clients' and row_id = tests.id('clientX') and action = 'insert'), 1, 'R-002-22 作ったことも履歴に残る');
select is((select count(*)::int from public.audit_logs where table_name = 'clients' and row_id = tests.id('clientX') and action = 'update' and source = 'rpc' and changed ? 'deleted_at'), 1, 'R-002-22 RPC で消したことは、source が rpc の履歴に残る');
select is((select count(*)::int from public.audit_logs where table_name = 'client_contacts' and row_id = tests.id('contactX') and source = 'rpc' and action = 'update' and changed ? 'deleted_at'), 1, 'R-002-22 一緒に消した担当者も、履歴に残る');
select is((select count(distinct request_id)::int from public.audit_logs where row_id in (tests.id('bD'), tests.id('bD-room'), tests.id('bD-area'), tests.id('bD-prof')) and changed ? 'deleted_at'), 1, 'R-002-22 1つの操作で消えた建物と子は、同じ request_id でまとまる');
select isnt((select request_id from public.audit_logs where row_id = tests.id('bD') and changed ? 'deleted_at' and action = 'update'), (select request_id from public.audit_logs where row_id = tests.id('clientX') and action = 'update' and changed ? 'deleted_at'), 'R-002-22 別の操作の request_id は別');
select is((select count(*)::int from pg_trigger where tgname = 'tp_audit' and tgrelid in ('public.clients'::regclass, 'public.client_contacts'::regclass, 'public.buildings'::regclass, 'public.building_profiles'::regclass, 'public.rooms'::regclass, 'public.building_areas'::regclass)), 6, 'R-002-22 6つの表すべてに履歴のトリガーがある');

select * from finish();
rollback;
