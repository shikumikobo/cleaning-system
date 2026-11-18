-- 機能 010：清掃の契約（表・policy）と、作業（works）・作業の金額・担当の最小の表。
-- data-model.md の 010・012 の章と、specs/010-contracts/design.md が正。
-- 守りの決まり：親は unique (tenant_id, id)、子は (tenant_id, 親の id) の組で参照する。
-- 並列で作っている相手の表（009 の report_templates）には外部キーを付けず、列だけを置く（取り込みのときに足す）。

-- 1. 契約（型 B）。書くのは RPC だけ ---------------------------------------------
create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null,
  building_id uuid not null,
  source text not null default 'quote' check (source in ('quote', 'import')),
  quote_id uuid,
  kind text not null check (kind in ('recurring', 'one_time')),
  start_date date not null,
  end_date date,
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id),
  constraint contracts_source_ck check ((source = 'quote' and quote_id is not null) or (source = 'import' and quote_id is null)),
  constraint contracts_period_ck check (end_date is null or end_date >= start_date),
  constraint contracts_ended_ck check (status = 'active' or end_date is not null)
);
create index contracts_client_idx on public.contracts (tenant_id, client_id);
create index contracts_building_idx on public.contracts (tenant_id, building_id);
create index contracts_status_idx on public.contracts (tenant_id, status, start_date);
-- 1つの見積から作る契約は1つ
create unique index contracts_quote_uq on public.contracts (tenant_id, quote_id) where quote_id is not null and deleted_at is null;

-- 2. 清掃の中身（型 B）。金額・繰り返しの変更は、今の行を閉じて新しい行（同じ service_key）。書くのは RPC だけ ---
create table public.contract_services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  contract_id uuid not null,
  service_key uuid not null default gen_random_uuid(),
  service_kind text not null check (service_kind in ('base', 'option', 'special')),
  name text not null check (length(btrim(name)) > 0),
  amount bigint not null default 0 check (amount between 0 and 100000000000),
  billing text not null check (billing in ('monthly', 'per_visit')),
  recurrence text not null check (recurrence ~ '^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$'),
  start_time time,
  end_time time,
  report_template_id uuid, -- 009 のひな形。外部キーは 009 の取り込みのあとで足す
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references public.contracts (tenant_id, id),
  constraint contract_services_period_ck check (valid_to is null or valid_to >= valid_from),
  constraint contract_services_time_ck check (start_time is null or end_time is null or end_time > start_time)
);
create index contract_services_contract_idx on public.contract_services (tenant_id, contract_id);
create index contract_services_key_idx on public.contract_services (tenant_id, service_key, valid_from);
-- 同じ service_key で、今の行（valid_to が空）は1つだけ
create unique index contract_services_current_uq on public.contract_services (tenant_id, service_key) where valid_to is null and deleted_at is null;

-- 3. 決まった担当（型 A）。予定を作るときの担当の初めの値 ---------------------------
create table public.contract_service_staff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  contract_service_id uuid not null,
  membership_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_service_id) references public.contract_services (tenant_id, id),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id)
);
create index contract_service_staff_service_idx on public.contract_service_staff (tenant_id, contract_service_id);
create index contract_service_staff_member_idx on public.contract_service_staff (tenant_id, membership_id);
create unique index contract_service_staff_uq on public.contract_service_staff (tenant_id, contract_service_id, membership_id) where deleted_at is null;

-- 4. 作業（型 A＋D）。契約の中身か案件のどちらか1つを元に持つ ----------------------------
create table public.works (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  building_id uuid not null,
  contract_service_id uuid,
  request_id uuid,
  service_key uuid,
  title text not null check (length(btrim(title)) > 0),
  report_template_id uuid, -- 009 のひな形。外部キーは 009 の取り込みのあとで足す
  scheduled_date date not null,
  start_time time,
  end_time time,
  status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'done', 'skipped', 'cancelled')),
  version int not null default 1,
  run_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id),
  foreign key (tenant_id, contract_service_id) references public.contract_services (tenant_id, id),
  foreign key (tenant_id, request_id) references public.requests (tenant_id, id),
  foreign key (tenant_id, run_id) references public.job_runs (tenant_id, id),
  constraint works_source_ck check ((contract_service_id is null) <> (request_id is null)),
  constraint works_time_ck check (start_time is null or end_time is null or end_time > start_time)
);
create index works_building_idx on public.works (tenant_id, building_id, scheduled_date);
create index works_date_idx on public.works (tenant_id, scheduled_date, status);
create index works_service_idx on public.works (tenant_id, contract_service_id) where contract_service_id is not null;
create index works_request_idx on public.works (tenant_id, request_id) where request_id is not null;
create index works_run_idx on public.works (tenant_id, run_id) where run_id is not null;
-- 定時の処理が二度動いても重ならない（手で足した作業は数えない）
create unique index works_service_date_uq on public.works (tenant_id, service_key, scheduled_date)
  where run_id is not null and deleted_at is null;

-- 5. 作業の金額（型 B）。行った回ごとに請求するとき ------------------------------------
create table public.work_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  work_id uuid not null,
  amount bigint not null default 0 check (amount between 0 and 100000000000),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, work_id) references public.works (tenant_id, id)
);
create unique index work_charges_work_uq on public.work_charges (tenant_id, work_id) where deleted_at is null;

-- 6. 担当（型 A）。割り当ての画面と実績は 012。ここは予定の作成が初めの担当を入れるための最小 ----
create table public.work_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  work_id uuid not null,
  membership_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, work_id) references public.works (tenant_id, id),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id)
);
create index work_assignments_work_idx on public.work_assignments (tenant_id, work_id);
create index work_assignments_member_idx on public.work_assignments (tenant_id, membership_id);
create unique index work_assignments_uq on public.work_assignments (tenant_id, work_id, membership_id) where deleted_at is null;

-- 7. 判定の関数 -------------------------------------------------------------------
-- 自分が、その作業の担当か（スタッフは担当の作業だけ読める）
create function app.is_assigned_to_work(p_tenant uuid, p_work uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.work_assignments a
    where a.tenant_id = p_tenant and a.work_id = p_work and a.deleted_at is null
      and app.is_owner_membership(a.tenant_id, a.membership_id)
  )
$$;

-- 請求書に載った月以降か（011 の invoice_lines が service_key・service_month で持つ。表がまだない間は、載っていない扱いで飛ばす）。
-- service_month は日付でも 'YYYY-MM' の文字でも読めるよう、先頭 7 文字で比べる。
create function app.service_invoiced(p_tenant uuid, p_service_key uuid, p_from date) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v boolean := false;
begin
  if to_regclass('public.invoice_lines') is null then return false; end if;
  execute 'select exists (select 1 from public.invoice_lines where tenant_id = $1 and service_key = $2 and deleted_at is null and left(service_month::text, 7) >= $3)'
    into v using p_tenant, p_service_key, to_char(p_from, 'YYYY-MM');
  return v;
end $$;

-- 作業の金額が請求書の明細に載っているか（載っていれば直せない）
create function app.work_charge_locked(p_tenant uuid, p_work uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v boolean := false;
begin
  if to_regclass('public.invoice_lines') is null then return false; end if;
  execute 'select exists (select 1 from public.invoice_lines where tenant_id = $1 and work_id = $2 and deleted_at is null)'
    into v using p_tenant, p_work;
  return v;
end $$;

select app.lock_functions();
grant execute on function app.is_assigned_to_work(uuid, uuid), app.service_invoiced(uuid, uuid, date), app.work_charge_locked(uuid, uuid)
  to authenticated, service_role;

-- 8. policy -----------------------------------------------------------------------
-- 契約と中身：読めるのは amount.read。書くのは RPC だけ（画面からの直接の書き込みは受け付けない）
select app.apply_policy('public.contracts', 'B', '{"write_perm": "contract.edit"}');
select app.apply_policy('public.contract_services', 'B', '{"write_perm": "contract.edit"}');
revoke insert, update on public.contracts, public.contract_services from authenticated;
drop policy tp_insert on public.contracts;
drop policy tp_update on public.contracts;
drop policy tp_insert on public.contract_services;
drop policy tp_update on public.contract_services;

-- 決まった担当：書けるのは contract.edit（社内の人だけを担当にできる）。読めるのは会社の中の人で、スタッフは自分の行だけ
select app.apply_policy('public.contract_service_staff', 'A', jsonb_build_object(
  'write_perm', 'contract.edit',
  'read_scope', 'app.is_owner_membership(tenant_id, membership_id)'));
drop policy tp_insert on public.contract_service_staff;
drop policy tp_update on public.contract_service_staff;
create policy tp_insert on public.contract_service_staff for insert to authenticated
  with check (public.has_perm(tenant_id, 'contract.edit') and deleted_at is null and app.request_assignee_ok(tenant_id, membership_id));
create policy tp_update on public.contract_service_staff for update to authenticated
  using (public.has_perm(tenant_id, 'contract.edit'))
  with check (public.has_perm(tenant_id, 'contract.edit') and app.request_assignee_ok(tenant_id, membership_id));
revoke update on public.contract_service_staff from authenticated;
grant update (tenant_id, membership_id, deleted_at, updated_at, updated_by) on public.contract_service_staff to authenticated;

-- 作業：work.assign を持つ人は全部、スタッフは担当の作業だけ、外部の人は許された建物の作業（日と状況）を読める。
-- 作る・状況を変えるのは RPC だけ（定時の処理・012）。直接直せるのは、予定の間の時刻だけ
select app.apply_policy('public.works', 'A', jsonb_build_object(
  'write_perm', 'work.assign',
  'lock_sql', 'status = ''scheduled''',
  'read_scope', 'app.is_assigned_to_work(tenant_id, id)',
  'external_read', 'deleted_at is null and app.can_external_see_building(tenant_id, building_id)'));
drop policy tp_insert on public.works;
revoke insert on public.works from authenticated;
revoke update on public.works from authenticated;
grant update (tenant_id, start_time, end_time, updated_at, updated_by) on public.works to authenticated;

-- 作業の金額：読めるのは amount.read。作る・直すには contract.edit と amount.read の両方。請求書に載ったら直せない
select app.apply_policy('public.work_charges', 'B', '{"write_perm": "contract.edit"}');
drop policy tp_insert on public.work_charges;
drop policy tp_update on public.work_charges;
create policy tp_insert on public.work_charges for insert to authenticated
  with check (public.has_perm(tenant_id, 'contract.edit') and public.has_perm(tenant_id, 'amount.read') and deleted_at is null);
create policy tp_update on public.work_charges for update to authenticated
  using (public.has_perm(tenant_id, 'contract.edit') and public.has_perm(tenant_id, 'amount.read') and not app.work_charge_locked(tenant_id, work_id))
  with check (public.has_perm(tenant_id, 'contract.edit') and public.has_perm(tenant_id, 'amount.read') and not app.work_charge_locked(tenant_id, work_id));
revoke update on public.work_charges from authenticated;
grant update (tenant_id, amount, deleted_at, updated_at, updated_by) on public.work_charges to authenticated;

-- 担当：割り当てるのは work.assign。読めるのは会社の中の人で、スタッフは自分の行だけ
select app.apply_policy('public.work_assignments', 'A', jsonb_build_object(
  'write_perm', 'work.assign',
  'read_scope', 'app.is_owner_membership(tenant_id, membership_id)'));
drop policy tp_insert on public.work_assignments;
drop policy tp_update on public.work_assignments;
create policy tp_insert on public.work_assignments for insert to authenticated
  with check (public.has_perm(tenant_id, 'work.assign') and deleted_at is null and app.request_assignee_ok(tenant_id, membership_id));
create policy tp_update on public.work_assignments for update to authenticated
  using (public.has_perm(tenant_id, 'work.assign'))
  with check (public.has_perm(tenant_id, 'work.assign') and app.request_assignee_ok(tenant_id, membership_id));
revoke update on public.work_assignments from authenticated;
grant update (tenant_id, membership_id, deleted_at, updated_at, updated_by) on public.work_assignments to authenticated;

-- 9. 使われているものは消さない -----------------------------------------------------
-- 002 の app.usage_refs の仮置き（契約 active、作業 scheduled・in_progress）は、この機能の状況の値と合っているので、行は足さない。
