-- 機能 004：見積（表）。data-model.md の 3章（004）と specs/004-quotes/design.md が正。
-- 守りの決まり：親は unique (tenant_id, id)、子は (tenant_id, 親の id) の組で参照する。
-- request_id は 003（案件）の表がまだないので、列だけを置き、外部キーは付けない（取り込みのときに足す）。

-- 品名の候補（型 B）
create table public.items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null check (length(btrim(name)) > 0),
  unit text not null default '式' check (length(btrim(unit)) > 0),
  unit_price int not null default 0 check (unit_price between 0 and 100000000),
  kind text not null default 'one_time' check (kind in ('base', 'option', 'one_time')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id)
);
create unique index items_name_uq on public.items (tenant_id, name) where deleted_at is null;

-- 見積（型 B＋D）。合計と番号は提出の RPC が入れる
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null,
  building_id uuid not null,
  request_id uuid, -- 003 の案件。外部キーは 003 の取り込みのあとで足す
  kind text not null default 'request' check (kind in ('request', 'recurring', 'special')),
  number text,
  issue_date date,
  valid_until date,
  tax_rate numeric(5, 4) not null default 0.1 check (tax_rate between 0 and 1),
  subtotal bigint not null default 0,
  tax bigint not null default 0,
  total bigint not null default 0,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  previous_id uuid, -- 直した版の元
  note text,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  decision_note text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id),
  foreign key (tenant_id, previous_id) references public.quotes (tenant_id, id),
  constraint quotes_total_ck check (total = subtotal + tax),
  constraint quotes_numbered_ck check (status = 'draft' or (number is not null and issue_date is not null and submitted_at is not null)),
  constraint quotes_decided_ck check (status not in ('approved', 'rejected') or (decided_at is not null and decided_by is not null)),
  constraint quotes_valid_ck check (valid_until is null or issue_date is null or valid_until >= issue_date)
);
create index quotes_client_idx on public.quotes (tenant_id, client_id);
create index quotes_building_idx on public.quotes (tenant_id, building_id);
create index quotes_status_idx on public.quotes (tenant_id, status, created_at desc);
create index quotes_request_idx on public.quotes (tenant_id, request_id) where request_id is not null;
create unique index quotes_number_uq on public.quotes (tenant_id, number) where number is not null;
-- 1つの元から、消していない直した版は1つだけ
create unique index quotes_one_revision_uq on public.quotes (tenant_id, previous_id) where previous_id is not null and deleted_at is null;

-- 明細（型 B＋D）。品名と単価は写して持つ。金額は 数量 × 単価（円未満は四捨五入）
create table public.quote_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  quote_id uuid not null,
  item_id uuid,
  line_kind text not null default 'one_time' check (line_kind in ('base', 'option', 'one_time')),
  name text not null check (length(btrim(name)) > 0),
  qty numeric(10, 2) not null default 1 check (qty > 0 and qty <= 100000),
  unit text not null default '式' check (length(btrim(unit)) > 0),
  unit_price int not null default 0 check (unit_price between 0 and 100000000),
  amount bigint generated always as (round(qty * unit_price)::bigint) stored,
  recurrence text check (recurrence is null or recurrence ~ '^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$'),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id),
  foreign key (tenant_id, item_id) references public.items (tenant_id, id)
);
create index quote_lines_quote_idx on public.quote_lines (tenant_id, quote_id, sort);
create index quote_lines_item_idx on public.quote_lines (tenant_id, item_id) where item_id is not null;
