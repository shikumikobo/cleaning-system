-- 会社・招待・ログイン（R-001-1、5〜13）
begin;
select * from no_plan();
select tests.seed();

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;

-- R-001-1 運営が会社を作る（service_role だけ）。招待のメールの送信は Edge Function（波 1）
select is(tests.run_as(tests.u('adminA'), 'select * from public.create_tenant(''新しい会社'', ''boss@example.test'')') ->> 'error', '42501',
          'R-001-1 会社を作れるのは運営（service_role）だけ。管理者も作れない');
select is(tests.run_as_anon('select * from public.create_tenant(''x'', ''y@example.test'')') ->> 'error', '42501',
          'R-001-1 ログインしていない人は会社を作れない');
create temp table _created on commit drop as
  select * from public.create_tenant('新しい会社', 'Boss@Example.test', 14);
select is((select status from public.tenants where id = (select tenant_id from _created)), 'trial', 'R-001-1 会社は試用の状況で作られる');
select is((select name from public.tenants where id = (select tenant_id from _created)), '新しい会社', 'R-001-1 会社の名前が入る');
select ok((select trial_ends_at from public.tenants where id = (select tenant_id from _created)) between now() + interval '13 days' and now() + interval '15 days',
          'R-001-1 試用の終わりは、指定の日数あと');
select is((select i.email from public.invitations i where i.id = (select invitation_id from _created)), 'boss@example.test',
          'R-001-1 最初の管理者への招待ができる（メールは小文字にそろえる）');
select is((select r.code from public.invitations i join public.roles r on r.id = i.role_id where i.id = (select invitation_id from _created)), 'admin',
          'R-001-1 最初の管理者への招待の役割は管理者');
select is(tests.run_as_service('select tenant_id from public.create_tenant(''別の会社'', ''b2@example.test'')') ->> 'error', null,
          'R-001-1 運営（service_role）は会社を作れる');

-- R-001-5・6 会社の情報
select is(tests.run_as(tests.u('adminA'), format('select public.update_tenant_info(%L, ''会社A改'', ''東京都'', ''03-0000-0000'', ''T1234567890123'')', tests.t('A'))) ->> 'error', null,
          'R-001-5 管理者は会社の情報を直せる');
select is((select name || '/' || address || '/' || phone || '/' || invoice_reg_no from public.tenants where id = tests.t('A')),
          '会社A改/東京都/03-0000-0000/T1234567890123', 'R-001-5 会社の情報が保存される');
select is(tests.err(tests.u('adminA'), format('select public.update_tenant_info(%L, ''会社A'', null, null, ''1234'')', tests.t('A'))), '23514',
          'R-001-5 インボイスの登録番号の形が違えば保存しない');
select is(tests.err(tests.u('memberA'), format('select public.update_tenant_info(%L, ''乗っ取り'', null, null, null)', tests.t('A'))), '42501',
          'R-001-6 管理者でない人（社員）は会社の情報を直せない');
select is(tests.err(tests.u('staffA'), format('select public.update_tenant_info(%L, ''乗っ取り'', null, null, null)', tests.t('A'))), '42501',
          'R-001-6 管理者でない人（スタッフ）は会社の情報を直せない');
select is(tests.err(tests.u('adminB'), format('select public.update_tenant_info(%L, ''乗っ取り'', null, null, null)', tests.t('A'))), '42501',
          'R-001-6 別の会社の管理者も、会社の情報を直せない');
select is(tests.cnt(tests.u('memberA'), format('update public.tenants set name = ''直接'' where id = %L', tests.t('A'))), -1::bigint,
          'R-001-6 画面から直接 tenants を書き換えることもできない');
select is((select name from public.tenants where id = tests.t('A')), '会社A改', 'R-001-6 拒否のあとも会社の名前は変わらない');

-- R-001-7 招待
select is(tests.err(tests.u('adminA'), format('select * from public.create_invitation(%L, ''Taro@Example.test'', ''staff'')', tests.t('A'))), null,
          'R-001-7 管理者はメールと役割で招待できる');
select ok((select expires_at from public.invitations where tenant_id = tests.t('A') and email = 'taro@example.test')
          between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour', 'R-001-7 招待は7日間使える');
select is(tests.err(tests.u('adminA'), format('select * from public.create_invitation(%L, ''x@example.test'', ''boss'')', tests.t('A'))), '22023',
          'R-001-7 役割が違えば招待しない');

-- R-001-12 管理者でない人は招待できない
select is(tests.err(tests.u('memberA'), format('select * from public.create_invitation(%L, ''y@example.test'', ''staff'')', tests.t('A'))), '42501',
          'R-001-12 社員は招待できない');
select is(tests.err(tests.u('staffA'), format('select * from public.create_invitation(%L, ''y@example.test'', ''staff'')', tests.t('A'))), '42501',
          'R-001-12 スタッフは招待できない');
select is(tests.err(tests.u('extA'), format('select * from public.create_invitation(%L, ''y@example.test'', ''staff'')', tests.t('A'))), '42501',
          'R-001-12 外部の人は招待できない');
select is(tests.err(tests.u('adminB'), format('select * from public.create_invitation(%L, ''y@example.test'', ''staff'')', tests.t('A'))), '42501',
          'R-001-12 別の会社の管理者は、この会社に招待できない');
select is(tests.err(tests.u('adminA'), format('insert into public.invitations (tenant_id, email, role_id, token_hash, expires_at) values (%L, ''z@example.test'', (select id from public.roles where code = ''admin''), ''h'', now())', tests.t('A'))), '42501',
          'R-001-12 管理者も、招待の表へ直接は書けない（RPC だけ）');

-- R-001-10 鍵はハッシュだけ
create temp table _tok on commit drop as
  select (tests.run_as_service(format('select * from public.create_tenant(%L, %L)', '鍵の会社', 'key@example.test')) -> 'rows' -> 0) as r;
select is((select count(*)::int from public.invitations where token_hash = (select r ->> 'token' from _tok)), 0, 'R-001-10 招待の表に、もとの鍵は保存されていない');
select is((select count(*)::int from public.invitations
           where token_hash = encode(extensions.digest((select r ->> 'token' from _tok), 'sha256'), 'hex')), 1, 'R-001-10 保存されているのは鍵の sha256 のハッシュ');
select is((select count(*)::int from public.audit_logs where changed::text like '%' || (select r ->> 'token' from _tok) || '%'), 0, 'R-001-10 変更の履歴にも、もとの鍵はない');

-- R-001-8・9・11 受け入れ
create or replace function pg_temp.invite(p_tenant uuid, p_email text, p_role text) returns jsonb language sql as $$
  select tests.run_as(tests.u('adminA'), format('select * from public.create_invitation(%L, %L, %L)', p_tenant, p_email, p_role)) -> 'rows' -> 0
$$;
select tests.make_user('newbie', 'newbie@example.test', false, false);
select tests.make_user('late', 'late@example.test', false, false);
select tests.make_user('gone', 'gone@example.test');
select tests.make_user('target', 'target@example.test', false, false);
select tests.make_user('imposter', 'imposter@example.test');
create temp table _t on commit drop as
  select 'ok'::text as k, pg_temp.invite(tests.t('A'), 'newbie@example.test', 'staff') as r
  union all select 'late', pg_temp.invite(tests.t('A'), 'late@example.test', 'staff')
  union all select 'gone', pg_temp.invite(tests.t('A'), 'gone@example.test', 'staff')
  union all select 'target', pg_temp.invite(tests.t('A'), 'target@example.test', 'member');

select is(tests.run_as(tests.u('newbie'), format('select public.accept_invitation(%L, ''  新人  '')', (select r ->> 'token' from _t where k = 'ok'))) ->> 'error', null,
          'R-001-8 招待された人は、鍵と表示名で所属できる');
select is((select r.code from public.memberships m join public.roles r on r.id = m.role_id where m.tenant_id = tests.t('A') and m.user_id = tests.u('newbie')), 'staff',
          'R-001-8 招待の役割で所属する');
select is((select m.status from public.memberships m where m.tenant_id = tests.t('A') and m.user_id = tests.u('newbie')), 'active', 'R-001-8 所属は有効');
select is((select display_name from public.profiles where id = tests.u('newbie')), '新人', 'R-001-8 表示名が保存される（前後の空白は取る）');
select ok((select accepted_at is not null from public.invitations where id = ((select r ->> 'invitation_id' from _t where k = 'ok'))::uuid), 'R-001-8 招待は使用済みになる');
select is(tests.n(tests.u('newbie'), format('select 1 from public.tenants where id = %L', tests.t('A'))), 1::bigint, 'R-001-8 所属したあと、その会社を読める');

select is(tests.run_as(tests.u('newbie'), format('select public.accept_invitation(%L, ''もう一度'')', (select r ->> 'token' from _t where k = 'ok'))) ->> 'error', 'P0001',
          'R-001-9 使い終わった招待では所属させない');
update public.invitations set expires_at = now() - interval '1 second' where id = ((select r ->> 'invitation_id' from _t where k = 'late'))::uuid;
select is(tests.run_as(tests.u('late'), format('select public.accept_invitation(%L, ''遅い人'')', (select r ->> 'token' from _t where k = 'late'))) ->> 'error', 'P0001',
          'R-001-9 期限の過ぎた招待では所属させない');
select is((select count(*)::int from public.memberships where user_id = tests.u('late')), 0, 'R-001-9 期限切れのあと、所属は作られない');

-- R-001-11 取り消し
select is(tests.err(tests.u('memberA'), format('select public.revoke_invitation(%L)', (select r ->> 'invitation_id' from _t where k = 'gone'))), '42501',
          'R-001-11 管理者でない人は招待を取り消せない');
select is(tests.err(tests.u('adminB'), format('select public.revoke_invitation(%L)', (select r ->> 'invitation_id' from _t where k = 'gone'))), '42501',
          'R-001-11 別の会社の管理者は招待を取り消せない');
select is(tests.err(tests.u('adminA'), format('select public.revoke_invitation(%L)', (select r ->> 'invitation_id' from _t where k = 'gone'))), null,
          'R-001-11 管理者は招待を取り消せる');
select ok((select deleted_at is not null from public.invitations where id = ((select r ->> 'invitation_id' from _t where k = 'gone'))::uuid), 'R-001-11 取り消した招待は印が付く');
select is(tests.run_as(tests.u('gone'), format('select public.accept_invitation(%L, ''消えた人'')', (select r ->> 'token' from _t where k = 'gone'))) ->> 'error', 'P0001',
          'R-001-11 取り消した招待は使えない（R-001-9）');
select is(tests.err(tests.u('adminA'), format('select public.revoke_invitation(%L)', (select r ->> 'invitation_id' from _t where k = 'ok'))), '22023',
          'R-001-11 使い終わった招待は取り消せない');

-- 別のメールの人・知らない鍵・ログインなし
select is(tests.run_as(tests.u('imposter'), format('select public.accept_invitation(%L, ''なりすまし'')', (select r ->> 'token' from _t where k = 'target'))) ->> 'error', 'P0001',
          'R-001-9 招待されたメールと違う人は所属できない');
select is(tests.run_as(tests.u('imposter'), 'select public.accept_invitation(''でたらめ'', ''x'')') ->> 'error', 'P0001', 'R-001-9 知らない鍵では所属できない');
select is((select count(distinct m) from (
             select tests.run_as(tests.u('newbie'), format('select public.accept_invitation(%L, ''x'')', (select r ->> 'token' from _t where k = 'ok'))) ->> 'message' as m
             union all select tests.run_as(tests.u('late'), format('select public.accept_invitation(%L, ''x'')', (select r ->> 'token' from _t where k = 'late'))) ->> 'message'
             union all select tests.run_as(tests.u('gone'), format('select public.accept_invitation(%L, ''x'')', (select r ->> 'token' from _t where k = 'gone'))) ->> 'message'
             union all select tests.run_as(tests.u('imposter'), 'select public.accept_invitation(''zzz'', ''x'')') ->> 'message') s), 1::bigint,
          'R-001-9 どの理由でも同じ答え（招待の有無を探れない）');
select is(tests.run_as_anon(format('select public.accept_invitation(%L, ''x'')', (select r ->> 'token' from _t where k = 'target'))) ->> 'error', '42501',
          'R-001-9 ログインしていない人は所属できない');
select is(tests.run_as(tests.u('target'), format('select public.accept_invitation(%L, '' '')', (select r ->> 'token' from _t where k = 'target'))) ->> 'error', '22023',
          'R-001-8 表示名が空なら所属させない');
select is((select count(*)::int from public.memberships where user_id = tests.u('target')), 0, 'R-001-8 表示名が空のとき、所属は作られない');

-- R-001-13 パスワードを使わない
select is(pg_temp.try('insert into auth.users (id, email, aud, role, encrypted_password) values (gen_random_uuid(), ''pw@example.test'', ''authenticated'', ''authenticated'', ''hash'')'), '42501',
          'R-001-13 パスワードを持つ利用者は作れない（ログインはメールのリンクだけ）');
select is(pg_temp.try('insert into auth.users (id, email, aud, role, encrypted_password) values (gen_random_uuid(), ''nopw@example.test'', ''authenticated'', ''authenticated'', '''')'), 'ok',
          'R-001-13 パスワードのない利用者（メールのリンクでログイン）は作れる');
select is(pg_temp.try(format('update auth.users set encrypted_password = ''hash'' where id = %L', tests.u('adminA'))), '42501',
          'R-001-13 あとからパスワードを付けることもできない');

select * from finish();
rollback;
