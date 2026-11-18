-- 機能 011：請求（表・policy）。data-model.md の 011 の章と specs/011-invoices/design.md が正。
-- 守りの決まり：親は unique (tenant_id, id)、子は (tenant_id, 親の id) の組で参照する。
-- 請求書・明細・入金は、RPC だけが作る・決める（画面からの直接の書き込みは、下書きの期日・税率・備考と、下書きの明細の品名・数量・単位だけ）。

-- 請求書（型 B）。取引先ごとに月1枚
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null,
  period date not null check (period = date_trunc('month', period)::date), -- 請求する月（その月の1日）
  number text,
  issue_date date,
  due_date date,
  tax_rate numeric(5, 4) not null default 0.1 check (tax_rate between 0 and 1),
  subtotal bigint not null default 0,
  tax bigint not null default 0,
  total bigint not null default 0,
  status text not null default 'draft' check (status in ('draft', 'issued', 'sent', 'partial', 'paid', 'cancelled')),
  previous_id uuid, -- 取り消した請求書（出し直したとき）
  note text,
  issued_at timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id),
  foreign key (tenant_id, previous_id) references public.invoices (tenant_id, id),
  constraint invoices_total_ck check (total = subtotal + tax),
  constraint invoices_numbered_ck check (status = 'draft' or (number is not null and issue_date is not null and due_date is not null and issued_at is not null)),
  constraint invoices_due_ck check (due_date is null or issue_date is null or due_date >= issue_date),
  constraint invoices_cancel_ck check (status <> 'cancelled' or cancelled_at is not null)
);
create index invoices_client_idx on public.invoices (tenant_id, client_id);
create index invoices_status_idx on public.invoices (tenant_id, status, period desc);
-- 取引先ごとに月1枚（取り消したものは数えない）
create unique index invoices_client_period_uq on public.invoices (tenant_id, client_id, period) where deleted_at is null and status <> 'cancelled';
create unique index invoices_number_uq on public.invoices (tenant_id, number) where number is not null;
-- 1つの取り消した請求書から、消していない出し直しは1つだけ
create unique index invoices_one_revision_uq on public.invoices (tenant_id, previous_id) where previous_id is not null and deleted_at is null;

-- 明細（型 B）。品名と単価は写して持つ。元は「契約の中身と月」「作業」「案件」のどれか1つ
create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  invoice_id uuid not null,
  service_key uuid, -- 契約の中身（010 の contract_services.service_key）。月ごとの請求
  service_month date check (service_month is null or service_month = date_trunc('month', service_month)::date),
  work_id uuid, -- 作業の金額（010 の works）
  request_id uuid, -- 案件の金額（003 の requests）
  name text not null check (length(btrim(name)) > 0),
  qty numeric(10, 2) not null default 1 check (qty > 0 and qty <= 100000),
  unit text not null default '式' check (length(btrim(unit)) > 0),
  unit_price bigint not null default 0 check (unit_price between 0 and 100000000000),
  amount bigint generated always as (round(qty * unit_price)::bigint) stored,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, invoice_id) references public.invoices (tenant_id, id),
  foreign key (tenant_id, work_id) references public.works (tenant_id, id),
  foreign key (tenant_id, request_id) references public.requests (tenant_id, id),
  -- 元はどれか1つ
  constraint invoice_lines_source_ck check (
    (service_key is not null and service_month is not null and work_id is null and request_id is null)
    or (service_key is null and service_month is null and work_id is not null and request_id is null)
    or (service_key is null and service_month is null and work_id is null and request_id is not null))
);
create index invoice_lines_invoice_idx on public.invoice_lines (tenant_id, invoice_id, sort);
-- 同じ元を二度請求しない（消していない明細の間）
create unique index invoice_lines_service_uq on public.invoice_lines (tenant_id, service_key, service_month) where service_key is not null and deleted_at is null;
create unique index invoice_lines_work_uq on public.invoice_lines (tenant_id, work_id) where work_id is not null and deleted_at is null;
create unique index invoice_lines_request_uq on public.invoice_lines (tenant_id, request_id) where request_id is not null and deleted_at is null;

-- 入金（型 B）。人が記録する。一部入金もある
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  invoice_id uuid not null,
  paid_on date not null,
  amount bigint not null check (amount > 0 and amount <= 100000000000),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, invoice_id) references public.invoices (tenant_id, id)
);
create index payments_invoice_idx on public.payments (tenant_id, invoice_id) where deleted_at is null;

-- 請求書が下書きか（明細の policy が使う）
create function app.invoice_is_draft(p_tenant uuid, p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invoices i where i.tenant_id = p_tenant and i.id = p_invoice and i.status = 'draft')
$$;
select app.lock_functions();
grant execute on function app.invoice_is_draft(uuid, uuid) to authenticated, service_role;

-- 請求書：読めるのは amount.read。直せるのは下書きだけ（期日・税率・備考）。作る・状況・番号・合計・消すのは RPC だけ
select app.apply_policy('public.invoices', 'B', jsonb_build_object('write_perm', 'invoice.edit', 'lock_sql', 'status = ''draft'''));
drop policy tp_insert on public.invoices;
revoke insert on public.invoices from authenticated;
revoke update on public.invoices from authenticated;
grant update (tenant_id, due_date, tax_rate, note) on public.invoices to authenticated;

-- 明細：請求書が下書きの間だけ、品名・数量・単位を直せ、外せる（deleted_at）。作るのは RPC だけ。元・単価・金額は書けない
select app.apply_policy('public.invoice_lines', 'B', jsonb_build_object('write_perm', 'invoice.edit', 'lock_sql', 'app.invoice_is_draft(tenant_id, invoice_id)'));
drop policy tp_insert on public.invoice_lines;
revoke insert on public.invoice_lines from authenticated;
revoke update on public.invoice_lines from authenticated;
grant update (tenant_id, name, qty, unit, sort, deleted_at) on public.invoice_lines to authenticated;

-- 入金：読めるのは amount.read。書くのは RPC だけ（請求書の状況も同じ処理で変えるため）
select app.apply_policy('public.payments', 'B', '{"write_perm": "invoice.edit"}');
drop policy tp_insert on public.payments;
drop policy tp_update on public.payments;
revoke insert, update on public.payments from authenticated;

-- 請求書ごとの入金額と残高（見る人の権限で絞る）
create view public.invoice_balances with (security_invoker = true) as
select i.id as invoice_id, i.tenant_id, i.total,
       coalesce((select sum(p.amount) from public.payments p where p.tenant_id = i.tenant_id and p.invoice_id = i.id and p.deleted_at is null), 0)::bigint as paid,
       (i.total - coalesce((select sum(p.amount) from public.payments p where p.tenant_id = i.tenant_id and p.invoice_id = i.id and p.deleted_at is null), 0))::bigint as balance
from public.invoices i;
revoke all on public.invoice_balances from anon, authenticated;
grant select on public.invoice_balances to authenticated;
