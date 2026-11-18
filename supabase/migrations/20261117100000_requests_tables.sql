-- 機能 003：案件（表・policy）。specs/003-requests/design.md が正。
-- 親は unique (tenant_id, id)、子は (tenant_id, 親の id) の組で参照する。

-- 1. 表 ------------------------------------------------------------------------

create table public.requests (
  id uuid primary key default gen_random_uuid(), -- 気づきから作るときは端末で作った uuid（二度送っても1件）
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null, -- 依頼元（建物の依頼元と同じとは限らない。オーナーからの依頼もある）
  building_id uuid not null,
  room_id uuid,
  source text not null default 'manual' check (source in ('manual', 'phone', 'email', 'field', 'import')),
  category text not null default 'other' check (category in ('cleaning', 'repair', 'complaint', 'inquiry', 'other')),
  title text not null check (length(btrim(title)) > 0 and length(title) <= 100),
  detail text check (detail is null or length(detail) <= 2000),
  due_date date, -- 日本時間の日付
  assignee_id uuid, -- 担当の所属（社内の人）
  status text not null default 'new' check (status in ('new', 'in_progress', 'done', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id),
  foreign key (tenant_id, room_id) references public.rooms (tenant_id, id),
  foreign key (tenant_id, assignee_id) references public.memberships (tenant_id, id)
);
create index requests_status_due_idx on public.requests (tenant_id, status, due_date);
create index requests_building_idx on public.requests (tenant_id, building_id);
create index requests_client_idx on public.requests (tenant_id, client_id);
create index requests_room_idx on public.requests (tenant_id, room_id) where room_id is not null;
create index requests_assignee_idx on public.requests (tenant_id, assignee_id, status) where assignee_id is not null;

-- 金額は別の表（型 B）。RLS は列を隠せないため
create table public.request_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  request_id uuid not null,
  amount int not null check (amount >= 0), -- 円
  billable boolean not null default true, -- 請求するか
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, request_id) references public.requests (tenant_id, id)
);
create unique index request_charges_request_uq on public.request_charges (tenant_id, request_id) where deleted_at is null;

-- 2. 判定の関数（RLS から使う。security definer・search_path 固定） ---------------------

-- 担当に付けられる所属：同じ会社の社内の人（外部の人でない）。空はよい
create function app.request_assignee_ok(p_tenant uuid, p_assignee uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_assignee is null or exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.id = p_assignee and m.tenant_id = p_tenant and m.deleted_at is null and r.code <> 'external'
  )
$$;

-- 金額が請求書の明細に載っているか（載っていれば直せない・消せない）。
-- invoice_lines（011）の表がまだない間は、載っていない扱いで飛ばす。
-- 011 の列名（tenant_id・request_id・deleted_at）と合うか、011 の design で確かめる。
create function app.request_charge_locked(p_tenant uuid, p_request uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v boolean := false;
begin
  if to_regclass('public.invoice_lines') is null then return false; end if;
  execute 'select exists (select 1 from public.invoice_lines where tenant_id = $1 and request_id = $2 and deleted_at is null)'
    into v using p_tenant, p_request;
  return v;
end $$;
grant execute on function app.request_assignee_ok(uuid, uuid), app.request_charge_locked(uuid, uuid) to authenticated, service_role;

-- 3. policy（型 A・B を付けてから、003 の決まりに狭める） ---------------------------------

-- 案件：request.edit を持つ人は全部、スタッフは担当の案件だけ読める
select app.apply_policy('public.requests', 'A', jsonb_build_object(
  'write_perm', 'request.edit',
  'read_bypass', 'request.edit',
  'read_scope', 'app.is_owner_membership(tenant_id, assignee_id)'));
drop policy tp_insert on public.requests;
drop policy tp_update on public.requests;
-- 作るのは「受付」だけ。担当は社内の人だけ
create policy tp_insert on public.requests for insert to authenticated
  with check (public.has_perm(tenant_id, 'request.edit') and status = 'new' and deleted_at is null
              and app.request_assignee_ok(tenant_id, assignee_id));
create policy tp_update on public.requests for update to authenticated
  using (public.has_perm(tenant_id, 'request.edit'))
  with check (public.has_perm(tenant_id, 'request.edit') and app.request_assignee_ok(tenant_id, assignee_id));
-- 状況（status）と deleted_at は画面から書けない（状況は RPC。案件は消さず、取消にする）。delete の権限も付けない
revoke update on public.requests from authenticated;
grant update (tenant_id, client_id, building_id, room_id, source, category, title, detail, due_date, assignee_id, updated_at, updated_by)
  on public.requests to authenticated;

-- 金額：読めるのは amount.read。作る・直す・消すには request.edit と amount.read の両方。請求書に載ったら直せない
select app.apply_policy('public.request_charges', 'B', '{"write_perm": "request.edit"}');
drop policy tp_insert on public.request_charges;
drop policy tp_update on public.request_charges;
create policy tp_insert on public.request_charges for insert to authenticated
  with check (public.has_perm(tenant_id, 'request.edit') and public.has_perm(tenant_id, 'amount.read') and deleted_at is null);
create policy tp_update on public.request_charges for update to authenticated
  using (public.has_perm(tenant_id, 'request.edit') and public.has_perm(tenant_id, 'amount.read')
         and not app.request_charge_locked(tenant_id, request_id))
  with check (public.has_perm(tenant_id, 'request.edit') and public.has_perm(tenant_id, 'amount.read')
              and not app.request_charge_locked(tenant_id, request_id));
-- 付け替え（request_id）と会社の変更はさせない。消すのは論理削除（deleted_at）
revoke update on public.request_charges from authenticated;
grant update (amount, billable, deleted_at, updated_at, updated_by) on public.request_charges to authenticated;

-- 4. 使われているものは消さない（002 の app.usage_refs に足す） -----------------------------
-- 部屋が案件から使われていれば「使わない」にする行は、002 がすでに持っている（room_id = $2、used_by_requests）。
-- 終わっていない案件のある建物は消さない
insert into app.usage_refs (parent, action, child_table, where_sql, reason) values
  ('building', 'block', 'requests', 'building_id = $2 and status in (''new'', ''in_progress'')', 'has_open_requests');
