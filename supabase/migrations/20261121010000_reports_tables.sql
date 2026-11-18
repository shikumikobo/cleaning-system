-- 機能 009：清掃報告書。data-model.md の 008・009・012 の章と、specs/009-reports/design.md が正。
-- ひな形（report_templates・template_items。型 A）、報告書（reports。型 C2＋D）、報告書の項目（report_items。型 C2＋D）。
-- あわせて、008・010 が待っていたつなぎを置く：photos.report_item_id の外部キー、写真の固定と外部の見せ方の本物、
-- works.report_template_id・contract_services.report_template_id の外部キー。
-- 守りの決まり：親は unique (tenant_id, id)、子は (tenant_id, 親の id) の組で参照する。

-- 1. ひな形（型 A）。建物ごと。使わないものは active = false ---------------------------
create table public.report_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  building_id uuid not null,
  name text not null check (length(btrim(name)) > 0 and length(name) <= 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id)
);
create index report_templates_building_idx on public.report_templates (tenant_id, building_id);
-- 同じ建物で同じ名前（消していないもの）は1つだけ
create unique index report_templates_name_uq on public.report_templates (tenant_id, building_id, name) where deleted_at is null;

create table public.template_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  template_id uuid not null,
  area_id uuid,
  name text not null check (length(btrim(name)) > 0 and length(name) <= 100),
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, template_id) references public.report_templates (tenant_id, id),
  foreign key (tenant_id, area_id) references public.building_areas (tenant_id, id)
);
create index template_items_template_idx on public.template_items (tenant_id, template_id, sort);
create index template_items_area_idx on public.template_items (tenant_id, area_id) where area_id is not null;

-- 2. 報告書（型 C2＋D）。作業ごとに1つ。端末で作った uuid をそのまま使う ------------------------
create table public.reports (
  id uuid primary key default gen_random_uuid(), -- 端末で作った uuid（二度送っても1件）
  tenant_id uuid not null references public.tenants (id),
  work_id uuid not null,
  template_id uuid, -- 写した元のひな形（作業が写した ID。ひな形がない作業は空）
  status text not null default 'draft' check (status in ('draft', 'checked', 'submitted')),
  remarks text not null default '' check (length(remarks) <= 4000),
  checked_by uuid, -- 確認した人（所属）
  checked_at timestamptz,
  submitted_by uuid, -- 提出した人（所属）
  submitted_at timestamptz,
  version int not null default 1,
  client_created_at timestamptz not null default now(), -- 端末で作った時刻
  device_id text,
  created_at timestamptz not null default now(), -- 届いた時刻
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, work_id) references public.works (tenant_id, id),
  foreign key (tenant_id, template_id) references public.report_templates (tenant_id, id),
  foreign key (tenant_id, checked_by) references public.memberships (tenant_id, id),
  foreign key (tenant_id, submitted_by) references public.memberships (tenant_id, id),
  constraint reports_state_ck check (
    (status = 'draft' and checked_at is null and submitted_at is null)
    or (status = 'checked' and checked_by is not null and checked_at is not null and submitted_at is null)
    or (status = 'submitted' and checked_by is not null and checked_at is not null and submitted_by is not null and submitted_at is not null))
);
create index reports_work_idx on public.reports (tenant_id, work_id);
create index reports_template_idx on public.reports (tenant_id, template_id) where template_id is not null;
create index reports_status_idx on public.reports (tenant_id, status, created_at desc);
create index reports_checked_by_idx on public.reports (tenant_id, checked_by) where checked_by is not null;
create index reports_submitted_by_idx on public.reports (tenant_id, submitted_by) where submitted_by is not null;
-- 1つの作業に報告書は1つ（消していないもの。別の uuid の2つめは断る）
create unique index reports_work_uq on public.reports (tenant_id, work_id) where deleted_at is null;

-- 3. 報告書の項目のチェック（型 C2＋D）。名前・場所・並び順は、ひな形から写した値を持つ（あとでひな形を直しても変わらない）----
create table public.report_items (
  id uuid primary key default gen_random_uuid(), -- 端末で作った uuid
  tenant_id uuid not null references public.tenants (id),
  report_id uuid not null,
  template_item_id uuid,
  area_id uuid,
  name text not null check (length(btrim(name)) > 0 and length(name) <= 100),
  sort int not null default 0,
  done boolean not null default false,
  note text not null default '' check (length(note) <= 2000),
  client_created_at timestamptz not null default now(),
  device_id text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, report_id) references public.reports (tenant_id, id),
  foreign key (tenant_id, template_item_id) references public.template_items (tenant_id, id),
  foreign key (tenant_id, area_id) references public.building_areas (tenant_id, id)
);
create index report_items_report_idx on public.report_items (tenant_id, report_id, sort);
create index report_items_template_item_idx on public.report_items (tenant_id, template_item_id) where template_item_id is not null;
create index report_items_area_idx on public.report_items (tenant_id, area_id) where area_id is not null;

-- 4. 判定の関数 -----------------------------------------------------------------------

-- 自分が、その作業の担当か（型 C2 の持ち主。報告書の判定に使う。名前が is_my_ で始まるのは、構造のテストが「権限の関数で判定している」と見分けるため）
create function app.is_my_work(p_tenant uuid, p_work uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_assigned_to_work(p_tenant, p_work)
$$;

-- 自分が、その報告書の作業の担当か（型 C2 の持ち主。報告書の項目の判定に使う）
create function app.is_my_report(p_tenant uuid, p_report uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reports r
    where r.tenant_id = p_tenant and r.id = p_report and r.deleted_at is null
      and app.is_assigned_to_work(p_tenant, r.work_id))
$$;

-- 報告書が下書きか（下書きの間だけ、項目と写真を直せる）
create function app.report_is_draft(p_tenant uuid, p_report uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reports r where r.tenant_id = p_tenant and r.id = p_report and r.status = 'draft')
$$;

-- 外部の人が、その作業の建物を見てよいか（報告書の型 D の判定）
create function app.work_external_visible(p_tenant uuid, p_work uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.works w
    where w.tenant_id = p_tenant and w.id = p_work and w.deleted_at is null
      and app.can_external_see_building(w.tenant_id, w.building_id))
$$;

-- 外部の人に見せてよい報告書の項目か（提出済みの報告書の項目。許された建物の作業）
create function app.report_item_external_visible(p_tenant uuid, p_report uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reports r
    where r.tenant_id = p_tenant and r.id = p_report and r.deleted_at is null and r.status = 'submitted'
      and app.work_external_visible(r.tenant_id, r.work_id))
$$;

-- 項目の場所が、そのひな形の建物の場所か（空でもよい）
create function app.template_area_ok(p_tenant uuid, p_template uuid, p_area uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_area is null or exists (
    select 1 from public.report_templates t
    join public.building_areas a on a.tenant_id = t.tenant_id and a.building_id = t.building_id
    where t.tenant_id = p_tenant and t.id = p_template and a.id = p_area)
$$;

-- 写真につけた報告書の項目が、写真の作業の報告書の項目か（項目つきの写真は、作業が要る）
create function app.report_item_of_work(p_tenant uuid, p_item uuid, p_work uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_item is null or (p_work is not null and exists (
    select 1 from public.report_items i
    join public.reports r on r.tenant_id = i.tenant_id and r.id = i.report_id
    where i.tenant_id = p_tenant and i.id = p_item and r.work_id = p_work))
$$;

-- 008 の写真の判定の本物（create or replace。署名と実行の権限は 008 のまま）
-- 報告書が提出・確認のあとで、写真を直せないか（項目の報告書の状況が下書きでない）
create or replace function app.photo_report_locked(p_tenant uuid, p_report_item uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select r.status <> 'draft'
    from public.report_items i
    join public.reports r on r.tenant_id = i.tenant_id and r.id = i.report_id
    where i.tenant_id = p_tenant and i.id = p_report_item), false)
$$;

-- 外部の人に見せてよい写真か：許された建物で、提出した報告書の項目につながる写真だけ
create or replace function app.photo_external_visible(p_tenant uuid, p_building uuid, p_report_item uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.can_external_see_building(p_tenant, p_building) and exists (
    select 1 from public.report_items i
    join public.reports r on r.tenant_id = i.tenant_id and r.id = i.report_id
    join public.works w on w.tenant_id = r.tenant_id and w.id = r.work_id
    where i.tenant_id = p_tenant and i.id = p_report_item and i.deleted_at is null
      and r.deleted_at is null and r.status = 'submitted' and w.building_id = p_building)
$$;

grant execute on function
  app.is_my_work(uuid, uuid), app.is_my_report(uuid, uuid), app.report_is_draft(uuid, uuid), app.work_external_visible(uuid, uuid),
  app.report_item_external_visible(uuid, uuid), app.template_area_ok(uuid, uuid, uuid), app.report_item_of_work(uuid, uuid, uuid)
to authenticated, service_role;

-- 5. policy ---------------------------------------------------------------------------

-- ひな形・項目（型 A）：読めるのは会社の中の人。書くのは master.edit。直せるのは名前・使う使わない・消す（と項目の場所・並び）
select app.apply_policy('public.report_templates', 'A', '{"write_perm": "master.edit"}');
revoke update on public.report_templates from authenticated;
grant update (name, active, deleted_at, updated_at, updated_by) on public.report_templates to authenticated;

select app.apply_policy('public.template_items', 'A', '{"write_perm": "master.edit"}');
drop policy tp_insert on public.template_items;
drop policy tp_update on public.template_items;
create policy tp_insert on public.template_items for insert to authenticated
  with check (public.has_perm(tenant_id, 'master.edit') and app.template_area_ok(tenant_id, template_id, area_id));
create policy tp_update on public.template_items for update to authenticated
  using (public.has_perm(tenant_id, 'master.edit'))
  with check (public.has_perm(tenant_id, 'master.edit') and app.template_area_ok(tenant_id, template_id, area_id));
revoke update on public.template_items from authenticated;
grant update (area_id, name, sort, active, deleted_at, updated_at, updated_by) on public.template_items to authenticated;

-- 報告書（型 C2＋D）：読む＝作業の担当と work.assign。外部の人は提出済みで許された建物のものだけ。
-- 直せるのは下書きの間だけ。状況・確認・提出は RPC だけが変える（列の権限で、メモと版だけに絞る）
select app.apply_policy('public.reports', 'C2', jsonb_build_object(
  'scope_fn', 'app.is_my_work',
  'scope_col', 'work_id',
  'lock_sql', 'status = ''draft''',
  'external_read', 'deleted_at is null and status = ''submitted'' and app.work_external_visible(tenant_id, work_id)'));
drop policy tp_insert on public.reports;
create policy tp_insert on public.reports for insert to authenticated
  with check (
    public.has_perm(tenant_id, 'field.record')
    and app.is_my_work(tenant_id, work_id)
    and status = 'draft' and checked_by is null and checked_at is null and submitted_by is null and submitted_at is null
    and version = 1 and deleted_at is null);
revoke update on public.reports from authenticated;
grant update (remarks, version, updated_at, updated_by) on public.reports to authenticated;

-- 報告書の項目（型 C2＋D）：持ち主は、その報告書の作業の担当。直せるのは下書きの間のチェックとメモだけ
select app.apply_policy('public.report_items', 'C2', jsonb_build_object(
  'scope_fn', 'app.is_my_report',
  'scope_col', 'report_id',
  'lock_sql', 'app.report_is_draft(tenant_id, report_id)',
  'external_read', 'deleted_at is null and app.report_item_external_visible(tenant_id, report_id)'));
drop policy tp_insert on public.report_items;
create policy tp_insert on public.report_items for insert to authenticated
  with check (
    public.has_perm(tenant_id, 'field.record')
    and app.is_my_report(tenant_id, report_id)
    and app.report_is_draft(tenant_id, report_id)
    and deleted_at is null);
revoke update on public.report_items from authenticated;
grant update (done, note, updated_at, updated_by) on public.report_items to authenticated;

-- 写真の作る policy に、報告書の固定と、項目が写真の作業のものであることを足す（008 の policy の作り直し）
drop policy tp_insert on public.photos;
create policy tp_insert on public.photos for insert to authenticated
  with check (
    public.has_perm(tenant_id, 'field.record')
    and app.is_owner_membership(tenant_id, taken_by)
    and app.is_my_photo(tenant_id, photos)
    and (request_id is null or exists (select 1 from public.requests r where r.id = photos.request_id and r.tenant_id = photos.tenant_id))
    and not app.photo_report_locked(tenant_id, report_item_id)
    and app.report_item_of_work(tenant_id, report_item_id, work_id));

-- 6. つなぎ（008・010 が待っていた外部キー）-------------------------------------------------
alter table public.photos
  add constraint photos_report_item_fk foreign key (tenant_id, report_item_id) references public.report_items (tenant_id, id);

alter table public.works
  add constraint works_report_template_fk foreign key (tenant_id, report_template_id) references public.report_templates (tenant_id, id);
create index works_report_template_idx on public.works (tenant_id, report_template_id) where report_template_id is not null;

alter table public.contract_services
  add constraint contract_services_report_template_fk foreign key (tenant_id, report_template_id) references public.report_templates (tenant_id, id);
create index contract_services_report_template_idx on public.contract_services (tenant_id, report_template_id) where report_template_id is not null;

-- 使われているものは消さない：ひな形・項目は、002 の app.usage_refs（親が client・building・room・area だけ）ではなく、
-- 消す RPC（20261121010100_reports_rpcs.sql）が直接確かめる。建物と場所の登録は、002 に既にある
-- （建物 → ひな形・項目を一緒に論理削除、場所 → 項目が使っていれば「使わない」）。

select app.lock_functions();
