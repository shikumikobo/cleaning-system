-- 機能 006：小口現金・レシート（表・policy・残高の view・確認と月の締めの RPC）。
-- design.md（specs/006-petty-cash）が正。型 C1（持ち主は holder_id）。
-- building_id・work_id は、002・012 の表がまだないので、列だけを置き、外部キーは付けない。

-- 1. 表 ------------------------------------------------------------------------

-- 小口：持ち手（所属）ごとの現金の入れ物
create table public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  holder_id uuid not null,
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, id, holder_id), -- 出入りが、小口の持ち手と揃えるため
  foreign key (tenant_id, holder_id) references public.memberships (tenant_id, id)
);
create index cash_accounts_holder_idx on public.cash_accounts (tenant_id, holder_id);
create unique index cash_accounts_name_uniq on public.cash_accounts (tenant_id, holder_id, name) where deleted_at is null;

-- レシート：画像は <tenant_id>/receipts/<id>.<拡張子>。読み取りの金額・日付は候補
create table public.receipts (
  id uuid primary key default gen_random_uuid(), -- 端末で作った uuid
  tenant_id uuid not null references public.tenants (id),
  holder_id uuid not null,
  storage_path text not null,
  read_amount int check (read_amount is null or read_amount > 0),
  read_date date,
  status text not null default 'pending' check (status in ('pending', 'read', 'failed', 'manual')),
  client_created_at timestamptz,
  received_at timestamptz not null default now(),
  device_id text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, id, holder_id), -- 出入りが、同じ持ち手のレシートだけを付けるため
  foreign key (tenant_id, holder_id) references public.memberships (tenant_id, id),
  -- 自分の会社の receipts のフォルダの、自分の ID の画像だけ
  constraint receipts_path_ok check (
    app.storage_path_ok(tenant_id, storage_path)
    and storage_path ~ ('^' || tenant_id::text || '/receipts/' || id::text || '\.(jpg|png|webp)$')
  )
);
create index receipts_holder_idx on public.receipts (tenant_id, holder_id, created_at);

-- 出入り（出納帳）
create table public.cash_entries (
  id uuid primary key default gen_random_uuid(), -- 端末で作った uuid（二度送っても1件）
  tenant_id uuid not null references public.tenants (id),
  account_id uuid not null,
  holder_id uuid not null,
  entry_date date not null,
  direction text not null check (direction in ('in', 'out')),
  amount int not null check (amount > 0),
  purpose text not null check (btrim(purpose) <> ''),
  building_id uuid, -- 002 の建物への外部キーは、20261117030000 で足した
  work_id uuid,     -- 012 のあとで外部キーを足す
  receipt_id uuid,
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'closed')),
  confirmed_at timestamptz,
  confirmed_by uuid,
  closed_at timestamptz,
  closed_by uuid,
  client_created_at timestamptz,
  received_at timestamptz not null default now(),
  device_id text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  constraint cash_entries_confirmed_ck check (status = 'draft' or confirmed_at is not null),
  constraint cash_entries_closed_ck check (status <> 'closed' or closed_at is not null),
  foreign key (tenant_id, account_id, holder_id) references public.cash_accounts (tenant_id, id, holder_id),
  foreign key (tenant_id, receipt_id, holder_id) references public.receipts (tenant_id, id, holder_id)
);
create index cash_entries_account_idx on public.cash_entries (tenant_id, account_id, holder_id, entry_date);
create index cash_entries_holder_idx on public.cash_entries (tenant_id, holder_id, entry_date);
create index cash_entries_receipt_idx on public.cash_entries (tenant_id, receipt_id, holder_id) where receipt_id is not null;
create index cash_entries_status_idx on public.cash_entries (tenant_id, status, entry_date);

-- 2. 判定の関数（RLS から使う。security definer・search_path 固定） ----------------

-- 小口の残高（入金 − 出金。消した行を除く）
create function app.cash_balance(p_tenant uuid, p_account uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case e.direction when 'in' then e.amount else -e.amount end), 0)::bigint
  from public.cash_entries e
  where e.tenant_id = p_tenant and e.account_id = p_account and e.deleted_at is null
$$;

-- その月に、その小口の締め済みの出入りがない（締めた月には、新しく入れられない）
create function app.cash_month_open(p_tenant uuid, p_account uuid, p_date date) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.cash_entries e
    where e.tenant_id = p_tenant and e.account_id = p_account and e.status = 'closed' and e.deleted_at is null
      and e.entry_date >= date_trunc('month', p_date)::date
      and e.entry_date < (date_trunc('month', p_date) + interval '1 month')::date
  )
$$;

-- レシートを直せる：確認済み・締め済みの出入りから使われていない
create function app.receipt_editable(p_tenant uuid, p_receipt uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.cash_entries e
    where e.tenant_id = p_tenant and e.receipt_id = p_receipt and e.status <> 'draft' and e.deleted_at is null
  )
$$;

-- 3. policy（型 C1 を付けてから、006 の決まりに狭める） ---------------------------------

-- 小口：読めるのは持ち手の本人と cash.manage。作る・直す・消すのは cash.manage だけ
select app.apply_policy('public.cash_accounts', 'C1', jsonb_build_object(
  'owner_col', 'holder_id', 'supervise_perm', 'cash.manage', 'write_perm', 'cash.manage', 'audit', true));
drop policy tp_insert on public.cash_accounts;
drop policy tp_update on public.cash_accounts;
create policy tp_insert on public.cash_accounts for insert to authenticated
  with check (public.has_perm(tenant_id, 'cash.manage'));
-- 消す（deleted_at を入れる）のは、残高が0のときだけ
create policy tp_update on public.cash_accounts for update to authenticated
  using (public.has_perm(tenant_id, 'cash.manage'))
  with check (public.has_perm(tenant_id, 'cash.manage')
              and (deleted_at is null or app.cash_balance(tenant_id, id) = 0));

-- 出入り：作るのは下書きだけ。持ち手の本人は出金だけ。確認・締めは RPC。直せるのは下書きの間だけ
select app.apply_policy('public.cash_entries', 'C1', jsonb_build_object(
  'owner_col', 'holder_id', 'supervise_perm', 'cash.manage', 'write_perm', 'cash.manage',
  'lock_sql', 'status = ''draft''', 'audit', true));
drop policy tp_insert on public.cash_entries;
drop policy tp_update on public.cash_entries;
create policy tp_insert on public.cash_entries for insert to authenticated
  with check (
    status = 'draft' and confirmed_at is null and confirmed_by is null and closed_at is null and closed_by is null
    and app.cash_month_open(tenant_id, account_id, entry_date)
    and (public.has_perm(tenant_id, 'cash.manage')
         or (app.is_owner_membership(tenant_id, holder_id) and direction = 'out'))
  );
create policy tp_update on public.cash_entries for update to authenticated
  using (
    status = 'draft'
    and (public.has_perm(tenant_id, 'cash.manage') or app.is_owner_membership(tenant_id, holder_id))
  )
  with check (
    status = 'draft' and confirmed_at is null and confirmed_by is null and closed_at is null and closed_by is null
    and app.cash_month_open(tenant_id, account_id, entry_date)
    and (public.has_perm(tenant_id, 'cash.manage')
         or (app.is_owner_membership(tenant_id, holder_id) and direction = 'out'))
  );

-- レシート：持ち手の本人と cash.manage が作る。確認済み・締め済みの出入りから使われていれば、直せず消せない
select app.apply_policy('public.receipts', 'C1', jsonb_build_object(
  'owner_col', 'holder_id', 'supervise_perm', 'cash.manage', 'write_perm', 'cash.manage',
  'lock_sql', 'app.receipt_editable(tenant_id, id)', 'audit', false));

-- 4. 残高の view（見る人の権限で絞る） ---------------------------------------------

create view public.cash_account_balances with (security_invoker = true) as
select a.tenant_id, a.id as account_id, a.holder_id, a.name,
       coalesce(sum(case e.direction when 'in' then e.amount else -e.amount end), 0)::bigint as balance,
       coalesce(sum(case when e.status <> 'draft' then case e.direction when 'in' then e.amount else -e.amount end end), 0)::bigint as confirmed_balance,
       count(e.id) filter (where e.status = 'draft')::int as draft_count
from public.cash_accounts a
left join public.cash_entries e
  on e.tenant_id = a.tenant_id and e.account_id = a.id and e.deleted_at is null
where a.deleted_at is null
group by a.tenant_id, a.id, a.holder_id, a.name;
revoke all on public.cash_account_balances from anon, authenticated;
grant select on public.cash_account_balances to authenticated;

-- 5. RPC：確認と月の締め ------------------------------------------------------------

-- 下書きを確認済みにする（cash.manage）。確認済みは何もしない。返すのは、新しく確認した件数
create function public.confirm_cash_entries(p_ids uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_found int; v_n int := 0;
begin
  if (select auth.uid()) is null then raise exception '権限がない' using errcode = '42501'; end if;
  p_ids := coalesce(p_ids, '{}');
  -- 呼ぶ人が cash.manage を持たない会社の行が1つでもあれば、何も変えずに断る
  if exists (select 1 from public.cash_entries e
             where e.id = any(p_ids) and not public.has_perm(e.tenant_id, 'cash.manage')) then
    raise exception '権限がない' using errcode = '42501';
  end if;
  if not exists (select 1 from public.memberships m join public.role_permissions rp on rp.role_id = m.role_id
                 join public.permissions p on p.id = rp.permission_id
                 where m.user_id = (select auth.uid()) and m.status = 'active' and m.deleted_at is null and p.code = 'cash.manage') then
    raise exception '権限がない' using errcode = '42501';
  end if;
  select count(*) into v_found from public.cash_entries e where e.id = any(p_ids) and e.deleted_at is null;
  if v_found <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception '対象の出入りがない' using errcode = '22023';
  end if;
  perform app.mark_rpc();
  for r in select e.id from public.cash_entries e
           where e.id = any(p_ids) and e.deleted_at is null and e.status = 'draft' order by e.id for update loop
    update public.cash_entries
    set status = 'confirmed', confirmed_at = now(), confirmed_by = (select auth.uid())
    where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- 月を締める（cash.manage）。その月の確認済みを締め済みにする。下書きが残る月・まだ来ていない月は断る
create function public.close_cash_month(p_tenant uuid, p_month date, p_account uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v_from date := date_trunc('month', p_month)::date; v_to date; v_n int;
begin
  perform app.require_perm(p_tenant, 'cash.manage');
  v_to := (v_from + interval '1 month')::date;
  if v_from > (now() at time zone 'Asia/Tokyo')::date then
    raise exception 'まだ来ていない月は締められない' using errcode = '22023';
  end if;
  if p_account is not null and not exists (select 1 from public.cash_accounts a where a.id = p_account and a.tenant_id = p_tenant) then
    raise exception '小口がない' using errcode = '22023';
  end if;
  perform app.mark_rpc();
  if exists (select 1 from public.cash_entries e
             where e.tenant_id = p_tenant and e.status = 'draft' and e.deleted_at is null
               and e.entry_date >= v_from and e.entry_date < v_to
               and (p_account is null or e.account_id = p_account)) then
    raise exception '下書きが残っている月は締められない' using errcode = '22023';
  end if;
  update public.cash_entries
  set status = 'closed', closed_at = now(), closed_by = (select auth.uid())
  where tenant_id = p_tenant and status = 'confirmed' and deleted_at is null
    and entry_date >= v_from and entry_date < v_to
    and (p_account is null or account_id = p_account);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 持ち手の表示名（cash.manage を持つ人だけ。所属の表は user.manage だけが読むので、小口の画面のために別に出す）
create function public.cash_holder_names(p_tenant uuid) returns table (membership_id uuid, display_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_perm(p_tenant, 'cash.manage');
  return query
    select m.id, p.display_name
    from public.memberships m
    join public.roles r on r.id = m.role_id and r.code <> 'external'
    join public.profiles p on p.id = m.user_id
    where m.tenant_id = p_tenant and m.status = 'active' and m.deleted_at is null;
end $$;

select app.lock_functions();
grant execute on function
  app.cash_balance(uuid, uuid), app.cash_month_open(uuid, uuid, date), app.receipt_editable(uuid, uuid)
to authenticated, service_role;
grant execute on function public.confirm_cash_entries(uuid[]), public.close_cash_month(uuid, date, uuid), public.cash_holder_names(uuid) to authenticated;
