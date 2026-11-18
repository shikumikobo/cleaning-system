-- pgTAP の補助。テスト用の schema（tests）を作る。この1本だけは rollback せず、残す。
create extension if not exists pgtap with schema extensions;
create schema if not exists tests;

-- 名前から決まった uuid（読みやすいテスト用）
create or replace function tests.u(p_name text) returns uuid language sql immutable as
$$ select md5('user:' || p_name)::uuid $$;
create or replace function tests.t(p_name text) returns uuid language sql immutable as
$$ select md5('tenant:' || p_name)::uuid $$;
create or replace function tests.id(p_name text) returns uuid language sql immutable as
$$ select md5('id:' || p_name)::uuid $$;

create or replace function tests.claims(p_uid uuid) returns text language sql stable as $$
  select json_build_object(
    'sub', p_uid, 'role', 'authenticated',
    'email', (select email from auth.users where id = p_uid),
    'app_metadata', json_build_object('operator', coalesce((select (raw_app_meta_data ->> 'operator') from auth.users where id = p_uid), 'false'))
  )::text
$$;

-- その利用者として SQL を1つ流し、結果を返す（流したあとは必ず元の権限に戻す）
-- 戻り：{"rows":[...]}（select）、{"count":n}（それ以外）、{"error":"<sqlstate>","message":...}
create or replace function tests.run_as_role(p_role text, p_claims text, p_sql text) returns jsonb
language plpgsql as $$
declare v_res jsonb; v_n bigint;
begin
  begin
    perform set_config('request.jwt.claims', p_claims, true);
    execute format('set local role %I', p_role);
    if p_sql ~* '^\s*(select|with|values)' then
      execute 'select coalesce(jsonb_agg(to_jsonb(s)), ''[]''::jsonb) from (' || p_sql || ') s' into v_res;
      v_res := jsonb_build_object('rows', v_res);
    else
      execute p_sql;
      get diagnostics v_n = row_count;
      v_res := jsonb_build_object('count', v_n);
    end if;
    execute 'reset role';
  exception when others then
    execute 'reset role';
    v_res := jsonb_build_object('error', sqlstate, 'message', sqlerrm);
  end;
  perform set_config('request.jwt.claims', '', true);
  return v_res;
end $$;

create or replace function tests.run_as(p_uid uuid, p_sql text) returns jsonb language sql as
$$ select tests.run_as_role('authenticated', tests.claims(p_uid), p_sql) $$;
create or replace function tests.run_as_service(p_sql text) returns jsonb language sql as
$$ select tests.run_as_role('service_role', '{"role":"service_role"}', p_sql) $$;
create or replace function tests.run_as_anon(p_sql text) returns jsonb language sql as
$$ select tests.run_as_role('anon', '{"role":"anon"}', p_sql) $$;

-- 便利：行数・エラー・変更した行数
create or replace function tests.n(p_uid uuid, p_sql text) returns bigint language sql as
$$ select jsonb_array_length(tests.run_as(p_uid, p_sql) -> 'rows')::bigint $$;
create or replace function tests.err(p_uid uuid, p_sql text) returns text language sql as
$$ select tests.run_as(p_uid, p_sql) ->> 'error' $$;
create or replace function tests.cnt(p_uid uuid, p_sql text) returns bigint language sql as
$$ select coalesce((tests.run_as(p_uid, p_sql) ->> 'count')::bigint, -1) $$;

create or replace function tests.make_user(p_name text, p_email text default null, p_operator boolean default false, p_profile boolean default true) returns uuid
language plpgsql as $$
declare v_id uuid := tests.u(p_name);
begin
  insert into auth.users (id, email, aud, role, raw_app_meta_data, created_at, updated_at)
  values (v_id, coalesce(p_email, p_name || '@example.test'), 'authenticated', 'authenticated',
          jsonb_build_object('operator', p_operator::text), now(), now());
  if p_profile then insert into public.profiles (id, display_name) values (v_id, p_name); end if;
  return v_id;
end $$;

create or replace function tests.make_member(p_tenant text, p_user text, p_role text, p_status text default 'active') returns uuid
language plpgsql as $$
declare v_id uuid := tests.id('m:' || p_tenant || ':' || p_user);
begin
  insert into public.memberships (id, tenant_id, user_id, role_id, status)
  values (v_id, tests.t(p_tenant), tests.u(p_user), (select id from public.roles where code = p_role), p_status);
  return v_id;
end $$;

-- 種：会社 A・B、利用者、所属、001 の全部の表に会社ごとの行を1つ以上
-- 使う側（各テストのファイル）は begin のあとに `select tests.seed();` を呼ぶ
create or replace function tests.seed() returns void language plpgsql as $$
begin
  insert into public.tenants (id, name, status) values
    (tests.t('A'), '会社A', 'active'), (tests.t('B'), '会社B', 'active');
  perform tests.seed_002(); -- 建物・取引先（外部の建物の外部キーが使うので、ここで先に作る）
  perform tests.make_user('adminA'); perform tests.make_user('memberA'); perform tests.make_user('staffA');
  perform tests.make_user('extA'); perform tests.make_user('extB'); perform tests.make_user('adminB'); perform tests.make_user('staffB');
  perform tests.make_user('multi'); perform tests.make_user('nobody');
  perform tests.make_user('operator', null, true);
  perform tests.make_member('A', 'adminA', 'admin');
  perform tests.make_member('A', 'memberA', 'member');
  perform tests.make_member('A', 'staffA', 'staff');
  perform tests.make_member('A', 'extA', 'external');
  perform tests.make_member('A', 'multi', 'member');
  perform tests.make_member('B', 'adminB', 'admin');
  perform tests.make_member('B', 'staffB', 'staff');
  perform tests.make_member('B', 'extB', 'external');
  perform tests.make_member('B', 'multi', 'admin');
  insert into public.offices (id, tenant_id, name) values
    (tests.id('officeA'), tests.t('A'), '本社A'), (tests.id('officeB'), tests.t('B'), '本社B');
  insert into public.invitations (id, tenant_id, email, role_id, token_hash, expires_at) values
    (tests.id('invA'), tests.t('A'), 'newa@example.test', (select id from public.roles where code='staff'), 'hashA', now() + interval '7 days'),
    (tests.id('invB'), tests.t('B'), 'newb@example.test', (select id from public.roles where code='staff'), 'hashB', now() + interval '7 days');
  insert into public.external_building_access (id, tenant_id, membership_id, building_id) values
    (tests.id('ebaA'), tests.t('A'), tests.id('m:A:extA'), tests.id('buildingA1')),
    (tests.id('ebaB'), tests.t('B'), tests.id('m:B:extB'), tests.id('buildingB1'));
  insert into public.support_access_grants (id, tenant_id, granted_by, reason, starts_at, ends_at) values
    (tests.id('grantA'), tests.t('A'), tests.u('adminA'), '過去の許可', now() - interval '10 days', now() - interval '9 days'),
    (tests.id('grantB'), tests.t('B'), tests.u('adminB'), '過去の許可', now() - interval '10 days', now() - interval '9 days');
  insert into public.job_runs (id, tenant_id, kind, status) values
    (tests.id('jobA'), tests.t('A'), 'seed', 'success'), (tests.id('jobB'), tests.t('B'), 'seed', 'success');
  insert into public.client_error_logs (id, tenant_id, membership_id, device_id, kind, message) values
    (tests.id('errA'), tests.t('A'), tests.id('m:A:staffA'), 'dev-a', 'sync_failed', 'x'),
    (tests.id('errB'), tests.t('B'), tests.id('m:B:staffB'), 'dev-b', 'sync_failed', 'x');
  insert into public.document_counters (id, tenant_id, kind, year, last_no) values
    (tests.id('ctrA'), tests.t('A'), 'quote', 2026, 3), (tests.id('ctrB'), tests.t('B'), 'quote', 2026, 7);
  perform tests.seed_006(); -- 機能 006（00001_seed_006.sql）
  perform tests.seed_notifications();
  perform tests.seed_003(); -- 機能 003（00002_seed_003.sql）
  perform tests.seed_004(); -- 機能 004（00002_seed_004.sql）
  perform tests.seed_005(); -- 機能 005（00002_seed_005.sql）
  perform tests.seed_008(); -- 機能 008（00002_seed_008.sql）
  perform tests.seed_010(); -- 機能 010（00002_seed_010.sql）
  perform tests.seed_009(); -- 機能 009（00002_seed_009.sql）
  perform tests.seed_011(); -- 機能 011（00002_seed_011.sql）
  perform tests.seed_014(); -- 機能 014（00002_seed_014.sql）
  perform tests.seed_016(); -- 機能 016（00002_seed_016.sql）
  perform tests.seed_012(); -- 機能 012（00002_seed_012.sql）
  perform tests.seed_013(); -- 機能 013（00002_seed_013.sql）
end $$;
-- 機能 015：お知らせ。staffA と staffB に端末の登録・設定・お知らせ、memberA に設定
create or replace function tests.seed_notifications() returns void language plpgsql as $$
begin
  insert into public.notification_settings (id, tenant_id, membership_id, kind, channel, enabled) values
    (tests.id('nsA-staff'), tests.t('A'), tests.id('m:A:staffA'), 'work_changed', 'push', false),
    (tests.id('nsA-member'), tests.t('A'), tests.id('m:A:memberA'), 'request_due', 'email', true),
    (tests.id('nsB-staff'), tests.t('B'), tests.id('m:B:staffB'), 'work_changed', 'push', false);
  insert into public.push_subscriptions (id, tenant_id, membership_id, endpoint, p256dh, auth, device_label) values
    (tests.id('psA-staff'), tests.t('A'), tests.id('m:A:staffA'), 'https://push.example.test/staffA', 'key-a', 'auth-a', '端末A'),
    (tests.id('psB-staff'), tests.t('B'), tests.id('m:B:staffB'), 'https://push.example.test/staffB', 'key-b', 'auth-b', '端末B');
  insert into public.notifications (id, tenant_id, membership_id, kind, title, link, channel, status, sent_at, created_at) values
    (tests.id('ntA-1'), tests.t('A'), tests.id('m:A:staffA'), 'work_changed', '予定が変わりました', '/works/1', 'app', 'sent', now() - interval '2 hours', now() - interval '2 hours'),
    (tests.id('ntA-2'), tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '明日の作業', '/works/2', 'app', 'sent', now() - interval '1 hour', now() - interval '1 hour'),
    (tests.id('ntA-m'), tests.t('A'), tests.id('m:A:memberA'), 'request_due', '案件の期限', '/requests/1', 'app', 'sent', now(), now()),
    (tests.id('ntB-1'), tests.t('B'), tests.id('m:B:staffB'), 'work_changed', 'B の予定', '/works/9', 'app', 'sent', now(), now());
end $$;
-- 後の機能は、自分の表の種を足す（tests.seed_<機能>() を作り、tests.seed() の最後から呼ぶ）

select plan(1);
select pass('テストの補助を入れた');
select * from finish();

-- 機能 002 の種：取引先・担当者・建物・カルテ・部屋・場所（会社 A と B に1つずつ以上）
create or replace function tests.seed_002() returns void language plpgsql as $$
begin
  insert into public.clients (id, tenant_id, kind, name, address, closing_day, payment_terms) values
    (tests.id('clientA1'), tests.t('A'), 'management_company', 'テスト管理会社A', '東京都A区1-1', 31, '月末締め翌月末払い'),
    (tests.id('ownerA'), tests.t('A'), 'owner', 'テストオーナーA', '東京都A区2-2', 20, null),
    (tests.id('clientB1'), tests.t('B'), 'management_company', 'テスト管理会社B', '大阪府B市1-1', 31, null),
    (tests.id('ownerB'), tests.t('B'), 'owner', 'テストオーナーB', '大阪府B市2-2', null, null);
  insert into public.client_contacts (id, tenant_id, client_id, name, email, phone) values
    (tests.id('contactA1'), tests.t('A'), tests.id('clientA1'), '担当A', 'contact-a@example.test', '03-0000-0001'),
    (tests.id('contactB1'), tests.t('B'), tests.id('clientB1'), '担当B', 'contact-b@example.test', '06-0000-0001');
  insert into public.buildings (id, tenant_id, client_id, owner_client_id, name, address) values
    (tests.id('buildingA1'), tests.t('A'), tests.id('clientA1'), tests.id('ownerA'), 'テストマンションA1', '東京都A区1-1-1'),
    (tests.id('buildingA2'), tests.t('A'), tests.id('clientA1'), null, 'テストビルA2', '東京都A区1-1-2'),
    (tests.id('buildingB1'), tests.t('B'), tests.id('clientB1'), tests.id('ownerB'), 'テストマンションB1', '大阪府B市1-1-1');
  insert into public.building_profiles (id, tenant_id, building_id, entry, key_place, parking, garbage_days, manager_contact, cautions) values
    (tests.id('profA1'), tests.t('A'), tests.id('buildingA1'), '正面の自動ドア', '管理室のキーボックス', '敷地内に2台', '月・木', '管理人 090-0000-0000', '犬がいる'),
    (tests.id('profB1'), tests.t('B'), tests.id('buildingB1'), '裏口', 'ポスト', 'なし', '火・金', '', '');
  insert into public.rooms (id, tenant_id, building_id, room_no, floor) values
    (tests.id('roomA1'), tests.t('A'), tests.id('buildingA1'), '101', 1),
    (tests.id('roomB1'), tests.t('B'), tests.id('buildingB1'), '201', 2);
  insert into public.building_areas (id, tenant_id, building_id, name, sort) values
    (tests.id('areaA1'), tests.t('A'), tests.id('buildingA1'), 'エントランス', 1),
    (tests.id('areaB1'), tests.t('B'), tests.id('buildingB1'), '階段', 1);
end $$;
