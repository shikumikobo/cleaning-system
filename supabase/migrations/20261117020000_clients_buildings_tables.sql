-- 機能 002：取引先・建物・部屋（表）。data-model.md の 3章（002）が正。
-- 守りの決まり：親は unique (tenant_id, id)、子は (tenant_id, 親の id) の組で参照する。

-- 名前の部分一致の索引（pg_trgm）。Supabase の標準の置き場所 extensions に入れる
create extension if not exists pg_trgm with schema extensions;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  kind text not null check (kind in ('management_company', 'owner')),
  name text not null check (length(btrim(name)) > 0),
  address text,
  phone text,
  email text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  closing_day int check (closing_day is null or closing_day between 1 and 31), -- 31 は月末
  payment_terms text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id)
);
create index clients_tenant_idx on public.clients (tenant_id, kind);
create index clients_name_trgm_idx on public.clients using gin (name extensions.gin_trgm_ops);

create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null,
  name text not null check (length(btrim(name)) > 0),
  email text,
  phone text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id)
);
create index client_contacts_client_idx on public.client_contacts (tenant_id, client_id);

create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null, -- 依頼元（管理会社など）
  owner_client_id uuid, -- 所有者（オーナー）
  name text not null check (length(btrim(name)) > 0),
  address text not null,
  lat numeric(9, 6) check (lat is null or lat between -90 and 90),
  lng numeric(9, 6) check (lng is null or lng between -180 and 180),
  location_fixed boolean not null default false, -- 地図で直した印（013）
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id),
  foreign key (tenant_id, owner_client_id) references public.clients (tenant_id, id),
  check ((lat is null) = (lng is null))
);
create index buildings_client_idx on public.buildings (tenant_id, client_id);
create index buildings_owner_idx on public.buildings (tenant_id, owner_client_id);
create index buildings_name_trgm_idx on public.buildings using gin (name extensions.gin_trgm_ops);

-- 建物カルテ。鍵の場所や入り方は外部の人に見せないので、建物とは別の表にする
create table public.building_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  building_id uuid not null,
  entry text,
  key_place text,
  parking text,
  garbage_days text,
  manager_contact text,
  cautions text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id)
);
create unique index building_profiles_building_uq on public.building_profiles (tenant_id, building_id) where deleted_at is null;

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  building_id uuid not null,
  room_no text not null check (length(btrim(room_no)) > 0),
  floor int,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id)
);
create unique index rooms_building_no_uq on public.rooms (tenant_id, building_id, room_no) where deleted_at is null;

create table public.building_areas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  building_id uuid not null,
  name text not null check (length(btrim(name)) > 0),
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id)
);
create unique index building_areas_building_name_uq on public.building_areas (tenant_id, building_id, name) where deleted_at is null;

-- 001 で保留していた外部キー
alter table public.memberships
  add constraint memberships_client_fk foreign key (tenant_id, client_id) references public.clients (tenant_id, id);
create index memberships_client_idx on public.memberships (tenant_id, client_id);
alter table public.external_building_access
  add constraint external_building_access_building_fk foreign key (tenant_id, building_id) references public.buildings (tenant_id, id);
create index external_building_access_building_idx on public.external_building_access (tenant_id, building_id);
