-- 機能 001：会社と利用者（表）。data-model.md の 3章（001）が正。
-- 守りの決まり：親は unique (tenant_id, id)、子は (tenant_id, 親の id) の組で参照する。

create schema if not exists app;

-- 関数は、明示しない限り anon・public に実行させない（新しい関数も同じ）
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema app revoke execute on functions from public, anon;
grant usage on schema app to authenticated, service_role;

-- 新しい関数は、anon・public に実行させない。各 migration の関数を作り終えたところで呼ぶ。
-- そのあと、必要なものだけ authenticated・service_role に grant する。
create or replace function app.lock_functions() returns void language plpgsql set search_path = '' as $f$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $f$;
revoke execute on function app.lock_functions() from public, anon, authenticated, service_role;

-- 1. 共通のマスタ ------------------------------------------------------------

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code in ('admin', 'member', 'staff', 'external')),
  name text not null
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null
);

create table public.role_permissions (
  role_id uuid not null references public.roles (id),
  permission_id uuid not null references public.permissions (id),
  primary key (role_id, permission_id)
);
create index role_permissions_permission_idx on public.role_permissions (permission_id);

insert into public.roles (code, name) values
  ('admin', '管理者'), ('member', '社員'), ('staff', 'スタッフ'), ('external', '外部');

insert into public.permissions (code, name) values
  ('user.manage', '利用者の招待・役割・止め、会社の情報'),
  ('master.edit', '取引先・建物・部屋・場所・ひな形・ファイル・取り込み'),
  ('request.edit', '案件'),
  ('quote.edit', '見積・品名の候補'),
  ('contract.edit', '契約・決まった担当・作業の金額'),
  ('invoice.edit', '請求・入金・費用'),
  ('amount.read', '金額を見る（型 B を読む）'),
  ('work.assign', '作業の割り当て、全員の予定と現場の記録を見る、報告書の確認'),
  ('field.record', '現場の記録（写真・報告書・開始と終了・気づきから案件）'),
  ('cash.manage', '全員の小口（渡す・確認・締め）');

-- 役割ごとの初めの割り当て（data-model.md の表。外部は権限を持たない）
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where (r.code = 'admin')
   or (r.code = 'member' and p.code <> 'user.manage')
   or (r.code = 'staff' and p.code = 'field.record');

-- 2. 会社と人 ----------------------------------------------------------------

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  address text,
  phone text,
  invoice_reg_no text check (invoice_reg_no is null or invoice_reg_no ~ '^T[0-9]{13}$'),
  status text not null default 'trial' check (status in ('trial', 'active', 'suspended')),
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz
);

-- 人：会社をまたぐ。メールアドレスは持たない（ログインの側だけ）
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.offices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null check (length(btrim(name)) > 0),
  address text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id)
);
create unique index offices_name_uq on public.offices (tenant_id, name) where deleted_at is null;

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null references public.profiles (id),
  role_id uuid not null references public.roles (id),
  office_id uuid,
  client_id uuid, -- 外部の人のとき。取引先の表（002）ができたら (tenant_id, client_id) の外部キーを足す
  status text not null default 'active' check (status in ('invited', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, user_id),
  foreign key (tenant_id, office_id) references public.offices (tenant_id, id)
);
create index memberships_user_tenant_idx on public.memberships (user_id, tenant_id);
create index memberships_role_idx on public.memberships (role_id);
create index memberships_office_idx on public.memberships (tenant_id, office_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  email text not null check (email = lower(btrim(email)) and email <> ''),
  role_id uuid not null references public.roles (id),
  office_id uuid,
  token_hash text not null unique, -- 鍵そのものは持たない（sha256 の16進）
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz, -- 取り消し
  unique (tenant_id, id),
  foreign key (tenant_id, office_id) references public.offices (tenant_id, id)
);
create unique index invitations_pending_uq on public.invitations (tenant_id, email)
  where accepted_at is null and deleted_at is null;
create index invitations_role_idx on public.invitations (role_id);
create index invitations_office_idx on public.invitations (tenant_id, office_id);

create table public.external_building_access (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  membership_id uuid not null,
  building_id uuid not null, -- 建物の表（002）ができたら (tenant_id, building_id) の外部キーを足す
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id)
);
create unique index external_building_access_uq on public.external_building_access (tenant_id, membership_id, building_id)
  where deleted_at is null;

create table public.support_access_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  granted_by uuid not null,
  reason text not null check (length(btrim(reason)) > 0),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  check (ends_at > starts_at),
  unique (tenant_id, id)
);
create index support_access_grants_active_idx on public.support_access_grants (tenant_id, ends_at)
  where revoked_at is null;

-- 3. 履歴と処理の記録 --------------------------------------------------------

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  table_name text not null,
  row_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  changed jsonb not null,
  actor uuid,
  source text not null check (source in ('ui', 'rpc', 'job', 'import', 'operator')),
  request_id uuid not null,
  at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index audit_logs_row_idx on public.audit_logs (tenant_id, table_name, row_id, at);
create index audit_logs_request_idx on public.audit_logs (tenant_id, request_id);

create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  kind text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'failure')),
  counts jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id)
);
create index job_runs_kind_idx on public.job_runs (tenant_id, kind, started_at);

-- 端末が書き足すだけ（id は端末で作った uuid。二度送っても1件）
create table public.client_error_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  membership_id uuid not null,
  device_id text not null,
  app_version text,
  kind text not null check (kind in ('sync_failed', 'ui_error')),
  message text not null,
  context jsonb,
  at timestamptz not null default now(), -- 端末で起きた時刻
  received_at timestamptz not null default now(), -- 届いた時刻
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (tenant_id, id),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id)
);
create index client_error_logs_membership_idx on public.client_error_logs (tenant_id, membership_id, at);

create table public.document_counters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  kind text not null check (kind in ('quote', 'invoice')),
  year int not null,
  last_no int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, kind, year)
);
