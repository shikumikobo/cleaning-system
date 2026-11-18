-- 機能 016：売上と粗利（費用の表・policy・集計の索引・建物の使われ方）。
-- data-model.md の 016 の行と specs/016-profit/design.md が正。
-- 012（作業の予定と実績）の表への外部キーは付けない（並列で作っている。012 の取り込みのあとで、必要なら足す）。

-- 1. 費用（型 B）。手で入れる外注・材料・その他。月・建物・契約に付ける ---------------------------
create table public.costs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  month date not null check (month = date_trunc('month', month)::date), -- その月の1日
  building_id uuid,
  contract_id uuid,
  kind text not null check (kind in ('outsourcing', 'material', 'other')),
  amount bigint not null check (amount > 0 and amount <= 100000000000),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id),
  foreign key (tenant_id, contract_id) references public.contracts (tenant_id, id)
);
-- 集計は会社と月で絞る。消した行は索引に入れない
create index costs_month_idx on public.costs (tenant_id, month) where deleted_at is null;
create index costs_building_idx on public.costs (tenant_id, building_id) where building_id is not null;
create index costs_contract_idx on public.costs (tenant_id, contract_id) where contract_id is not null;

-- 2. 集計のための索引（会社×月で効く形）。表は 006・011 のもの ---------------------------------
create index invoices_period_idx on public.invoices (tenant_id, period) where deleted_at is null;
-- 月は、日付を月の1日に直した値（view の month と同じ式。timestamp にしてから直すので、索引に使える）
create index cash_entries_out_month_idx on public.cash_entries (tenant_id, (date_trunc('month', entry_date::timestamp)::date)) where deleted_at is null and direction = 'out';

-- 3. 建物と契約が合っているか（建物も契約も指すとき、契約の建物と同じ） --------------------------
create function app.cost_refs_ok(p_tenant uuid, p_building uuid, p_contract uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_building is null or p_contract is null
    or exists (select 1 from public.contracts c where c.tenant_id = p_tenant and c.id = p_contract and c.building_id = p_building)
$$;
select app.lock_functions();
grant execute on function app.cost_refs_ok(uuid, uuid, uuid) to authenticated, service_role;

-- 4. policy：読めるのは amount.read、書けるのは invoice.edit（型 B）。建物と契約が合わない行は書けない ----
select app.apply_policy('public.costs', 'B', '{"write_perm": "invoice.edit"}');
drop policy tp_insert on public.costs;
drop policy tp_update on public.costs;
create policy tp_insert on public.costs for insert to authenticated
  with check (public.has_perm(tenant_id, 'invoice.edit') and deleted_at is null and app.cost_refs_ok(tenant_id, building_id, contract_id));
create policy tp_update on public.costs for update to authenticated
  using (public.has_perm(tenant_id, 'invoice.edit'))
  with check (public.has_perm(tenant_id, 'invoice.edit') and app.cost_refs_ok(tenant_id, building_id, contract_id));

-- 5. 使われているものは消さない（002 の app.usage_refs）：費用がある建物は消さない -----------------
insert into app.usage_refs (parent, action, child_table, where_sql, reason) values
  ('building', 'block', 'costs', 'building_id = $2', 'has_costs');
