-- 機能 001 の RPC。security definer なので RLS を通らない。中で必ず権限・会社・状況を確かめる。
-- 変更の履歴の source を 'rpc' にするため、各 RPC は app.source を設定する。

create function app.require_perm(p_tenant uuid, p_perm text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.has_perm(p_tenant, p_perm) then
    raise exception '権限がない' using errcode = '42501';
  end if;
end $$;

create function app.mark_rpc() returns void language sql set search_path = '' as $$
  select set_config('app.source', 'rpc', true)
$$;

-- 招待を1つ作る（鍵は一度だけ返し、DB にはハッシュだけを持つ）
create function app.make_invitation(p_tenant uuid, p_email text, p_role_id uuid, p_office uuid)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_token text := encode(extensions.gen_random_bytes(32), 'hex'); v_id uuid; v_exp timestamptz;
begin
  insert into public.invitations (tenant_id, email, role_id, office_id, token_hash, expires_at)
  values (p_tenant, lower(btrim(p_email)), p_role_id, p_office,
          encode(extensions.digest(v_token, 'sha256'), 'hex'), now() + interval '7 days')
  returning id, public.invitations.expires_at into v_id, v_exp;
  return query select v_id, v_token, v_exp;
end $$;

-- 運営：会社を試用で作り、最初の管理者を招待する（service_role だけ）
create function public.create_tenant(p_name text, p_admin_email text, p_trial_days int default 30)
returns table (tenant_id uuid, invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  perform app.mark_rpc();
  insert into public.tenants (name, status, trial_ends_at)
  values (btrim(p_name), 'trial', now() + make_interval(days => p_trial_days))
  returning id into v_tenant;
  return query select v_tenant, i.invitation_id, i.token, i.expires_at
    from app.make_invitation(v_tenant, p_admin_email, (select id from public.roles where code = 'admin'), null) i;
end $$;

-- 管理者：招待する
create function public.create_invitation(p_tenant uuid, p_email text, p_role_code text, p_office_id uuid default null)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_role uuid;
begin
  perform app.require_perm(p_tenant, 'user.manage');
  perform app.mark_rpc();
  select id into v_role from public.roles where code = p_role_code;
  if v_role is null then raise exception '役割がない：%', p_role_code using errcode = '22023'; end if;
  return query select * from app.make_invitation(p_tenant, p_email, v_role, p_office_id);
end $$;

-- 管理者：招待を取り消す（使い終わったものは取り消せない）
create function public.revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.invitations where id = p_id;
  if v_tenant is null then raise exception '招待がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'user.manage');
  perform app.mark_rpc();
  update public.invitations set deleted_at = now()
  where id = p_id and accepted_at is null and deleted_at is null;
  if not found then raise exception '取り消せない招待' using errcode = '22023'; end if;
end $$;

-- 招待された人：鍵と表示名で、所属する。期限切れ・使用済み・取り消し・別のメールは、同じ答えにする
create function public.accept_invitation(p_token text, p_display_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_inv public.invitations; v_id uuid; v_email text;
begin
  if v_uid is null then raise exception 'ログインが要る' using errcode = '28000'; end if;
  perform app.mark_rpc();
  select * into v_inv from public.invitations
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and accepted_at is null and deleted_at is null and expires_at > now()
  for update;
  v_email := lower(coalesce((select auth.jwt()) ->> 'email', ''));
  if v_inv.id is null or v_inv.email <> v_email then
    raise exception '招待が使えない' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_display_name, ''))) = 0 then
    raise exception '表示名が要る' using errcode = '22023';
  end if;

  insert into public.profiles (id, display_name) values (v_uid, btrim(p_display_name))
  on conflict (id) do nothing;

  insert into public.memberships (tenant_id, user_id, role_id, office_id, status)
  values (v_inv.tenant_id, v_uid, v_inv.role_id, v_inv.office_id, 'active')
  on conflict (tenant_id, user_id) do update
    set role_id = excluded.role_id, office_id = excluded.office_id, status = 'active'
    where public.memberships.status <> 'active'
  returning id into v_id;
  if v_id is null then raise exception 'すでに所属している' using errcode = '23505'; end if;

  update public.invitations set accepted_at = now() where id = v_inv.id;
  return v_id;
end $$;

-- 管理者が1人だけのとき、その人を止めたり管理者以外にしたりさせない
create function app.guard_last_admin(p_tenant uuid, p_membership uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_others int;
begin
  perform 1 from public.memberships m join public.roles r on r.id = m.role_id
  where m.tenant_id = p_tenant and m.status = 'active' and r.code = 'admin' for update of m;
  select count(*) into v_others from public.memberships m join public.roles r on r.id = m.role_id
  where m.tenant_id = p_tenant and m.status = 'active' and m.deleted_at is null and r.code = 'admin' and m.id <> p_membership;
  if v_others = 0 then
    raise exception '有効な管理者が1人だけなので変えられない' using errcode = 'P0002';
  end if;
end $$;

create function public.change_member_role(p_membership uuid, p_role_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.memberships; v_role uuid; v_cur text;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null then raise exception '所属がない' using errcode = '42501'; end if;
  perform app.require_perm(m.tenant_id, 'user.manage');
  perform app.mark_rpc();
  select id into v_role from public.roles where code = p_role_code;
  if v_role is null then raise exception '役割がない：%', p_role_code using errcode = '22023'; end if;
  select r.code into v_cur from public.roles r where r.id = m.role_id;
  if m.status = 'active' and v_cur = 'admin' and p_role_code <> 'admin' then
    perform app.guard_last_admin(m.tenant_id, m.id);
  end if;
  update public.memberships set role_id = v_role where id = m.id;
end $$;

create function public.set_member_status(p_membership uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.memberships; v_cur text;
begin
  if p_status not in ('active', 'suspended') then raise exception '状況は active か suspended' using errcode = '22023'; end if;
  select * into m from public.memberships where id = p_membership;
  if m.id is null then raise exception '所属がない' using errcode = '42501'; end if;
  perform app.require_perm(m.tenant_id, 'user.manage');
  perform app.mark_rpc();
  select r.code into v_cur from public.roles r where r.id = m.role_id;
  if p_status = 'suspended' and m.status = 'active' and v_cur = 'admin' then
    perform app.guard_last_admin(m.tenant_id, m.id);
  end if;
  update public.memberships set status = p_status where id = m.id;
end $$;

-- 管理者：会社の情報を直す
create function public.update_tenant_info(p_tenant uuid, p_name text, p_address text, p_phone text, p_invoice_reg_no text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_perm(p_tenant, 'user.manage');
  perform app.mark_rpc();
  update public.tenants
  set name = btrim(p_name), address = nullif(btrim(p_address), ''), phone = nullif(btrim(p_phone), ''),
      invoice_reg_no = nullif(btrim(p_invoice_reg_no), '')
  where id = p_tenant;
end $$;

-- 管理者：運営の閲覧を、期間つきで許す／取り消す
create function public.grant_support_access(p_tenant uuid, p_reason text, p_ends_at timestamptz, p_starts_at timestamptz default now())
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.require_perm(p_tenant, 'user.manage');
  perform app.mark_rpc();
  insert into public.support_access_grants (tenant_id, granted_by, reason, starts_at, ends_at)
  values (p_tenant, (select auth.uid()), p_reason, p_starts_at, p_ends_at) returning id into v_id;
  return v_id;
end $$;

create function public.revoke_support_access(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.support_access_grants where id = p_id;
  if v_tenant is null then raise exception '許可がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'user.manage');
  perform app.mark_rpc();
  update public.support_access_grants set revoked_at = now() where id = p_id and revoked_at is null;
end $$;

-- 管理者：外部の人が見られる建物を、まとめて決める
create function public.set_external_building_access(p_membership uuid, p_building_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.memberships; v_code text;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null then raise exception '所属がない' using errcode = '42501'; end if;
  perform app.require_perm(m.tenant_id, 'user.manage');
  perform app.mark_rpc();
  select r.code into v_code from public.roles r where r.id = m.role_id;
  if v_code <> 'external' then raise exception '外部の人だけに決められる' using errcode = '22023'; end if;
  update public.external_building_access set deleted_at = now()
  where tenant_id = m.tenant_id and membership_id = m.id and deleted_at is null
    and building_id <> all (coalesce(p_building_ids, '{}'));
  insert into public.external_building_access (tenant_id, membership_id, building_id)
  select m.tenant_id, m.id, b from unnest(coalesce(p_building_ids, '{}')) b
  on conflict (tenant_id, membership_id, building_id) where deleted_at is null do nothing;
end $$;

-- 番号を振る（見積・請求の RPC の中から呼ぶ。画面からは呼べない）
create function app.next_doc_no(p_tenant uuid, p_kind text, p_year int) returns int
language plpgsql security definer set search_path = '' as $$
declare v_no int;
begin
  insert into public.document_counters (tenant_id, kind, year, last_no) values (p_tenant, p_kind, p_year, 1)
  on conflict (tenant_id, kind, year) do update set last_no = public.document_counters.last_no + 1
  returning last_no into v_no;
  return v_no;
end $$;

select app.lock_functions();
-- 実行の権限
revoke execute on function public.create_tenant(text, text, int) from public, anon, authenticated;
grant execute on function public.create_tenant(text, text, int) to service_role;
revoke execute on function app.make_invitation(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function app.next_doc_no(uuid, text, int) from public, anon, authenticated, service_role;
revoke execute on function app.guard_last_admin(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function app.require_perm(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function app.mark_rpc() from public, anon, authenticated, service_role;
grant execute on function
  public.create_invitation(uuid, text, text, uuid), public.revoke_invitation(uuid),
  public.accept_invitation(text, text), public.change_member_role(uuid, text),
  public.set_member_status(uuid, text), public.update_tenant_info(uuid, text, text, text, text),
  public.grant_support_access(uuid, text, timestamptz, timestamptz), public.revoke_support_access(uuid),
  public.set_external_building_access(uuid, uuid[])
to authenticated;

-- ログインは、メールのリンク（パスワードなし）だけ。パスワードを持つ利用者を作らせない（R-001-13）
create function app.forbid_password() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(new.encrypted_password, '') <> ''
     and (tg_op = 'INSERT' or new.encrypted_password is distinct from old.encrypted_password) then
    raise exception 'パスワードは使わない（ログインはメールのリンク）' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger forbid_password before insert or update on auth.users
  for each row execute function app.forbid_password();
