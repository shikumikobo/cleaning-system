-- 機能 015：お知らせの仕組み（波 1）。設計は specs/015-notifications/design.md
-- 表3つ（設定・端末の登録・お知らせ）と種類の一覧、お知らせを作る共通の関数、端末の登録の RPC、
-- 送る処理（Edge Function）が呼ぶ関数、掃除。出来事ごとの通知は波 6 で、共通の関数を呼んで足す。

-- 1. 種類の一覧（共通のマスタ M）。足せるのはマイグレーションだけ ------------------------------

create table public.notification_kinds (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  default_push boolean not null,
  default_email boolean not null,
  required_perm text references public.permissions (code), -- 受け取るのに要る権限。なければ空
  sort int not null default 0
);

create index notification_kinds_perm_idx on public.notification_kinds (required_perm);

insert into public.notification_kinds (code, name, default_push, default_email, required_perm, sort) values
  ('work_changed', '予定の変更', true, false, null, 10),
  ('work_tomorrow', '明日の作業', true, false, null, 20),
  ('request_due', '期限の近い案件', true, false, null, 30),
  ('report_missing', '出ていない報告書', true, false, null, 40),
  ('quote_approved', '見積の承認', true, true, 'amount.read', 50),
  ('invoice_overdue', '請求の入金の遅れ', true, true, 'amount.read', 60);

-- 2. 表 ----------------------------------------------------------------------

create table public.notification_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  membership_id uuid not null,
  kind text not null references public.notification_kinds (code),
  channel text not null check (channel in ('push', 'email')),
  enabled boolean not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, membership_id, kind, channel),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id)
);
create index notification_settings_kind_idx on public.notification_settings (kind);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  membership_id uuid not null,
  endpoint text not null check (endpoint ~ '^https://' and length(endpoint) <= 2000),
  p256dh text not null,
  auth text not null,
  device_label text check (device_label is null or length(device_label) <= 100),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, membership_id, endpoint),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id)
);
create index push_subscriptions_endpoint_idx on public.push_subscriptions (endpoint);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  membership_id uuid not null,
  kind text not null references public.notification_kinds (code),
  title text not null check (length(title) between 1 and 100),
  body text check (body is null or length(body) <= 500),
  link text check (link is null or link ~ '^/[^/\\]'),
  channel text not null check (channel in ('app', 'push', 'email')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error text,
  sent_at timestamptz,
  read_at timestamptz,
  run_id uuid,
  dedupe_key text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  check (channel <> 'app' or status = 'sent'),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id),
  foreign key (tenant_id, run_id) references public.job_runs (tenant_id, id)
);
create index notifications_list_idx on public.notifications (tenant_id, membership_id, created_at desc);
create index notifications_pending_idx on public.notifications (tenant_id, created_at) where status = 'pending';
create index notifications_created_idx on public.notifications (tenant_id, created_at);
create index notifications_kind_idx on public.notifications (kind);
create index notifications_run_idx on public.notifications (tenant_id, run_id) where run_id is not null;
create unique index notifications_dedupe_uq on public.notifications (tenant_id, membership_id, kind, channel, dedupe_key)
  where dedupe_key is not null;

-- 同じ会社の同じ種類の処理は、同時に1つだけ動かす（送りの二重の実行を防ぐ）
create unique index job_runs_notification_running_uq on public.job_runs (tenant_id, kind)
  where kind in ('send_notifications', 'purge_notifications') and status = 'running' and deleted_at is null;

-- 3. policy ------------------------------------------------------------------

select app.apply_master_policy('public.notification_kinds');

-- 本人のものだけ（work.assign を持つ人にも、他人の分は読ませない）
select app.apply_policy('public.notification_settings', 'C1', '{"supervise_perm": "none"}');
select app.apply_policy('public.push_subscriptions', 'C1', '{"supervise_perm": "none"}');
select app.apply_policy('public.notifications', 'C1', '{"supervise_perm": "none"}');

-- 列の権限で、本人が書けるところを絞る
-- 端末の登録：作るのは RPC だけ。本人が書き換えられるのは外す印（deleted_at）だけ
revoke insert, update on public.push_subscriptions from authenticated;
grant update (deleted_at) on public.push_subscriptions to authenticated;
-- お知らせ：作るのは共通の関数だけ。本人が書き換えられるのは既読の時刻（read_at）だけ
revoke insert, update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- 4. お知らせを作る共通の関数 ----------------------------------------------------
-- 後の機能の RPC（security definer）が、自分の変更と同じトランザクションの中で呼ぶ。
-- 作った行の数を返す。受け取れない人（止められた・権限がない・別の会社）には、何も作らず 0 を返す
-- （通知を作れなくても、呼んだ側の本体の処理を止めない）。
create function app.enqueue_notification(
  p_tenant uuid, p_membership uuid, p_kind text, p_title text, p_body text, p_link text,
  p_dedupe_key text default null, p_run uuid default null
) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_kind public.notification_kinds;
  v_role uuid;
  v_n int := 0;
  v_inserted int;
  v_push boolean; v_email boolean;
begin
  select * into v_kind from public.notification_kinds where code = p_kind;
  if not found then
    raise exception '知らない種類：%', p_kind using errcode = '22023';
  end if;
  if p_title is null or length(btrim(p_title)) = 0 then
    raise exception '題名が空' using errcode = '22023';
  end if;
  if p_link is not null and p_link !~ '^/[^/\\]' then
    raise exception 'リンクはアプリの中の道（/ で始まる）だけ' using errcode = '22023';
  end if;

  select m.role_id into v_role from public.memberships m
  where m.id = p_membership and m.tenant_id = p_tenant and m.status = 'active' and m.deleted_at is null;
  if not found then return 0; end if;

  if v_kind.required_perm is not null and not exists (
    select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
    where rp.role_id = v_role and p.code = v_kind.required_perm
  ) then
    return 0;
  end if;

  -- 一覧の行（常に作る。重複の印が同じなら、前に作ったことになる）
  insert into public.notifications (tenant_id, membership_id, kind, title, body, link, channel, status, sent_at, run_id, dedupe_key)
  values (p_tenant, p_membership, p_kind, btrim(p_title), p_body, p_link, 'app', 'sent', now(), p_run, p_dedupe_key)
  on conflict (tenant_id, membership_id, kind, channel, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then return 0; end if;
  v_n := 1;

  -- 通知：本人の設定が先、なければ種類の初めの値。有効な端末があるときだけ
  v_push := coalesce((select s.enabled from public.notification_settings s
                      where s.tenant_id = p_tenant and s.membership_id = p_membership and s.kind = p_kind and s.channel = 'push' and s.deleted_at is null),
                     v_kind.default_push);
  if v_push and exists (select 1 from public.push_subscriptions ps
                        where ps.tenant_id = p_tenant and ps.membership_id = p_membership and ps.deleted_at is null) then
    insert into public.notifications (tenant_id, membership_id, kind, title, body, link, channel, status, run_id, dedupe_key)
    values (p_tenant, p_membership, p_kind, btrim(p_title), p_body, p_link, 'push', 'pending', p_run, p_dedupe_key);
    v_n := v_n + 1;
  end if;

  v_email := coalesce((select s.enabled from public.notification_settings s
                       where s.tenant_id = p_tenant and s.membership_id = p_membership and s.kind = p_kind and s.channel = 'email' and s.deleted_at is null),
                      v_kind.default_email);
  if v_email then
    insert into public.notifications (tenant_id, membership_id, kind, title, body, link, channel, status, run_id, dedupe_key)
    values (p_tenant, p_membership, p_kind, btrim(p_title), p_body, p_link, 'email', 'pending', p_run, p_dedupe_key);
    v_n := v_n + 1;
  end if;
  return v_n;
end $$;

-- 会社をまたぐ定時の処理（service_role）が呼ぶための入口
create function public.enqueue_notification(
  p_tenant uuid, p_membership uuid, p_kind text, p_title text, p_body text, p_link text,
  p_dedupe_key text default null, p_run uuid default null
) returns int
language sql security definer set search_path = '' as $$
  select app.enqueue_notification(p_tenant, p_membership, p_kind, p_title, p_body, p_link, p_dedupe_key, p_run)
$$;

-- 5. 端末の登録 ----------------------------------------------------------------
-- 本人の有効な所属として登録する。同じ端末（endpoint）を別の人が登録していたら、その人の登録を消す
create function public.register_push_subscription(
  p_tenant uuid, p_endpoint text, p_p256dh text, p_auth text, p_label text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_membership uuid; v_id uuid;
begin
  select m.id into v_membership from public.memberships m
  where m.tenant_id = p_tenant and m.user_id = (select auth.uid()) and m.status = 'active' and m.deleted_at is null;
  if v_membership is null then
    raise exception '権限がない' using errcode = '42501';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' then
    raise exception '送り先は https で始まる必要がある' using errcode = '23514';
  end if;

  -- 同じ端末の、ほかの人の登録（どの会社でも）を消す。自分の別の会社の分は残す
  delete from public.push_subscriptions ps
  using public.memberships m
  where ps.endpoint = p_endpoint and m.tenant_id = ps.tenant_id and m.id = ps.membership_id
    and m.user_id <> (select auth.uid());

  insert into public.push_subscriptions (tenant_id, membership_id, endpoint, p256dh, auth, device_label)
  values (p_tenant, v_membership, p_endpoint, p_p256dh, p_auth, p_label)
  on conflict (tenant_id, membership_id, endpoint)
  do update set p256dh = excluded.p256dh, auth = excluded.auth, device_label = excluded.device_label,
                deleted_at = null, updated_at = now(), updated_by = (select auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- 6. 送る処理（Edge Function。service_role）が呼ぶ関数 -----------------------------------

-- 「送る前」の通知・メールがある会社
create function public.notification_tenants_pending() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct n.tenant_id from public.notifications n
  where n.status = 'pending' and n.channel in ('push', 'email') and n.deleted_at is null
$$;

-- 処理の記録を始める。同じ会社・同じ種類がすでに動いていれば null（30 分を過ぎた古い記録は失敗で閉じる）
create function public.notification_start_run(p_tenant uuid, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_kind not in ('send_notifications', 'purge_notifications') then
    raise exception '知らない種類の処理：%', p_kind using errcode = '22023';
  end if;
  update public.job_runs set status = 'failure', ended_at = now(), error = 'timeout'
  where tenant_id = p_tenant and kind = p_kind and status = 'running' and deleted_at is null
    and started_at < now() - interval '30 minutes';
  begin
    insert into public.job_runs (tenant_id, kind) values (p_tenant, p_kind) returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

create function public.notification_finish_run(p_tenant uuid, p_run uuid, p_status text, p_counts jsonb, p_error text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_status not in ('success', 'failure') then
    raise exception '状況は success か failure：%', p_status using errcode = '22023';
  end if;
  update public.job_runs set status = p_status, ended_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 300)
  where id = p_run and tenant_id = p_tenant and kind in ('send_notifications', 'purge_notifications') and status = 'running';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- 送る前の行（通知・メール）と、受け取る人のログインの ID。止められた人の user_id は空（送り側が失敗にする）
create function public.notification_outbox(p_tenant uuid, p_limit int default 100)
returns table (id uuid, tenant_id uuid, membership_id uuid, user_id uuid, kind text, channel text, title text, body text, link text)
language sql stable security definer set search_path = '' as $$
  select n.id, n.tenant_id, n.membership_id,
         (select m.user_id from public.memberships m
          where m.id = n.membership_id and m.tenant_id = n.tenant_id and m.status = 'active' and m.deleted_at is null),
         n.kind, n.channel, n.title, n.body, n.link
  from public.notifications n
  where n.tenant_id = p_tenant and n.status = 'pending' and n.channel in ('push', 'email') and n.deleted_at is null
  order by n.created_at, n.id
  limit greatest(p_limit, 0)
$$;

create function public.notification_mark(p_tenant uuid, p_id uuid, p_status text, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_status not in ('sent', 'failed') then
    raise exception '状況は sent か failed：%', p_status using errcode = '22023';
  end if;
  update public.notifications
  set status = p_status,
      sent_at = case when p_status = 'sent' then now() end,
      error = case when p_status = 'failed' then left(p_error, 300) end,
      updated_at = now()
  where id = p_id and tenant_id = p_tenant and status = 'pending' and channel in ('push', 'email');
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- 届かない端末の登録を、行ごと消す
create function public.notification_drop_subscription(p_tenant uuid, p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  delete from public.push_subscriptions where id = p_id and tenant_id = p_tenant;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- 掃除：180 日を過ぎたお知らせと、外して 30 日を過ぎた端末の登録。その会社の分だけ。消したお知らせの数を返す
create function public.notification_purge(p_tenant uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  delete from public.notifications where tenant_id = p_tenant and created_at < now() - interval '180 days';
  get diagnostics v_n = row_count;
  delete from public.push_subscriptions where tenant_id = p_tenant and deleted_at is not null and deleted_at < now() - interval '30 days';
  return v_n;
end $$;

-- 7. 実行の権限 ---------------------------------------------------------------
select app.lock_functions();
revoke execute on function app.enqueue_notification(uuid, uuid, text, text, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.enqueue_notification(uuid, uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_notification(uuid, uuid, text, text, text, text, text, uuid) to service_role;
grant execute on function public.register_push_subscription(uuid, text, text, text, text) to authenticated;
revoke execute on function public.notification_tenants_pending() from public, anon, authenticated;
revoke execute on function public.notification_start_run(uuid, text) from public, anon, authenticated;
revoke execute on function public.notification_finish_run(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.notification_outbox(uuid, int) from public, anon, authenticated;
revoke execute on function public.notification_mark(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.notification_drop_subscription(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.notification_purge(uuid) from public, anon, authenticated;
grant execute on function public.notification_tenants_pending() to service_role;
grant execute on function public.notification_start_run(uuid, text) to service_role;
grant execute on function public.notification_finish_run(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.notification_outbox(uuid, int) to service_role;
grant execute on function public.notification_mark(uuid, uuid, text, text) to service_role;
grant execute on function public.notification_drop_subscription(uuid, uuid) to service_role;
grant execute on function public.notification_purge(uuid) to service_role;
