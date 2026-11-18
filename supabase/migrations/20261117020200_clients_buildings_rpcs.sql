-- 機能 002：使われているものは消さない（app.usage_refs）と、消す RPC。
-- RPC は security definer で RLS を通らない。中で必ず権限（master.edit）と、行の会社・状況を確かめる。

-- 1. 使われ方の登録 -----------------------------------------------------------
-- parent   : client | building | room | area
-- action   : block（あれば消さない）| cascade（親と一緒に論理削除）| in_use（あれば消さずに「使わない」）
-- where_sql: 子の行の条件。子の列は修飾せずに書き、$2 が親の id。tenant_id と deleted_at is null は自動で足す
-- 子の表がまだない間は飛ばす。後の機能は、自分の表を作ったあとで、ここに行を足す。
create table app.usage_refs (
  id bigint generated always as identity primary key,
  parent text not null check (parent in ('client', 'building', 'room', 'area')),
  action text not null check (action in ('block', 'cascade', 'in_use')),
  child_table text not null,
  where_sql text not null,
  reason text not null default '',
  unique (parent, action, child_table, reason)
);
revoke all on app.usage_refs from public, anon, authenticated;

insert into app.usage_refs (parent, action, child_table, where_sql, reason) values
  ('client', 'cascade', 'client_contacts', 'client_id = $2', ''),
  ('client', 'block', 'buildings', 'client_id = $2 or owner_client_id = $2', 'has_buildings'),
  ('client', 'block', 'contracts', 'client_id = $2', 'has_contracts'),
  ('client', 'block', 'invoices', 'client_id = $2', 'has_invoices'),
  ('building', 'block', 'contracts', 'building_id = $2 and status = ''active''', 'has_active_contracts'),
  ('building', 'block', 'works',
     'building_id = $2 and scheduled_date >= (now() at time zone ''Asia/Tokyo'')::date and status in (''scheduled'', ''in_progress'')', 'has_future_works'),
  ('building', 'cascade', 'building_profiles', 'building_id = $2', ''),
  ('building', 'cascade', 'rooms', 'building_id = $2', ''),
  ('building', 'cascade', 'building_areas', 'building_id = $2', ''),
  ('building', 'cascade', 'external_building_access', 'building_id = $2', ''),
  ('building', 'cascade', 'report_templates', 'building_id = $2', ''),
  ('building', 'cascade', 'template_items', 'template_id in (select id from public.report_templates where building_id = $2)', ''),
  ('room', 'in_use', 'requests', 'room_id = $2', 'used_by_requests'),
  ('room', 'in_use', 'photos', 'room_id = $2', 'used_by_photos'),
  ('area', 'in_use', 'photos', 'area_id = $2', 'used_by_photos'),
  ('area', 'in_use', 'template_items', 'area_id = $2', 'used_by_template_items');

-- 止めている理由の一覧：[{reason, table, count}]。なければ空の配列
create function app.usage_blockers(p_parent text, p_action text, p_tenant uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; n bigint; v jsonb := '[]'::jsonb;
begin
  for r in select * from app.usage_refs where parent = p_parent and action = p_action order by id loop
    continue when to_regclass('public.' || quote_ident(r.child_table)) is null;
    execute format('select count(*) from public.%I where tenant_id = $1 and deleted_at is null and (%s)', r.child_table, r.where_sql)
      into n using p_tenant, p_id;
    if n > 0 then
      v := v || jsonb_build_array(jsonb_build_object('reason', r.reason, 'table', r.child_table, 'count', n));
    end if;
  end loop;
  return v;
end $$;

-- 親と一緒に、子を論理削除する
create function app.usage_cascade(p_parent text, p_tenant uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select * from app.usage_refs where parent = p_parent and action = 'cascade' order by id loop
    continue when to_regclass('public.' || quote_ident(r.child_table)) is null;
    execute format('update public.%I set deleted_at = now() where tenant_id = $1 and deleted_at is null and (%s)', r.child_table, r.where_sql)
      using p_tenant, p_id;
  end loop;
end $$;

-- 2. 消す RPC -----------------------------------------------------------------
-- 行が見つからない・権限がないは、同じ 42501 で返す（ほかの会社の行の存在を探らせない）

create function public.delete_client(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_deleted timestamptz; v_block jsonb;
begin
  select tenant_id, deleted_at into v_tenant, v_deleted from public.clients where id = p_id;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'master.edit');
  if v_deleted is not null then return jsonb_build_object('ok', true, 'deleted', true, 'already', true); end if;
  perform app.mark_rpc();
  v_block := app.usage_blockers('client', 'block', v_tenant, p_id);
  if jsonb_array_length(v_block) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'in_use', 'blockers', v_block);
  end if;
  perform app.usage_cascade('client', v_tenant, p_id);
  update public.clients set deleted_at = now() where id = p_id and tenant_id = v_tenant;
  return jsonb_build_object('ok', true, 'deleted', true);
end $$;

create function public.delete_building(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_deleted timestamptz; v_block jsonb;
begin
  select tenant_id, deleted_at into v_tenant, v_deleted from public.buildings where id = p_id;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'master.edit');
  if v_deleted is not null then return jsonb_build_object('ok', true, 'deleted', true, 'already', true); end if;
  perform app.mark_rpc();
  v_block := app.usage_blockers('building', 'block', v_tenant, p_id);
  if jsonb_array_length(v_block) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'in_use', 'blockers', v_block);
  end if;
  perform app.usage_cascade('building', v_tenant, p_id);
  update public.buildings set deleted_at = now() where id = p_id and tenant_id = v_tenant;
  return jsonb_build_object('ok', true, 'deleted', true);
end $$;

-- 部屋・場所：使われていれば、消さずに「使わない」にする
create function public.delete_room(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_deleted timestamptz; v_block jsonb;
begin
  select tenant_id, deleted_at into v_tenant, v_deleted from public.rooms where id = p_id;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'master.edit');
  if v_deleted is not null then return jsonb_build_object('ok', true, 'deleted', true, 'already', true); end if;
  perform app.mark_rpc();
  v_block := app.usage_blockers('room', 'in_use', v_tenant, p_id);
  if jsonb_array_length(v_block) > 0 then
    update public.rooms set active = false where id = p_id and tenant_id = v_tenant;
    return jsonb_build_object('ok', true, 'deleted', false, 'deactivated', true, 'blockers', v_block);
  end if;
  update public.rooms set deleted_at = now() where id = p_id and tenant_id = v_tenant;
  return jsonb_build_object('ok', true, 'deleted', true);
end $$;

create function public.delete_building_area(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_deleted timestamptz; v_block jsonb;
begin
  select tenant_id, deleted_at into v_tenant, v_deleted from public.building_areas where id = p_id;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'master.edit');
  if v_deleted is not null then return jsonb_build_object('ok', true, 'deleted', true, 'already', true); end if;
  perform app.mark_rpc();
  v_block := app.usage_blockers('area', 'in_use', v_tenant, p_id);
  if jsonb_array_length(v_block) > 0 then
    update public.building_areas set active = false where id = p_id and tenant_id = v_tenant;
    return jsonb_build_object('ok', true, 'deleted', false, 'deactivated', true, 'blockers', v_block);
  end if;
  update public.building_areas set deleted_at = now() where id = p_id and tenant_id = v_tenant;
  return jsonb_build_object('ok', true, 'deleted', true);
end $$;

select app.lock_functions();
revoke execute on function app.usage_blockers(text, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function app.usage_cascade(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function
  public.delete_client(uuid), public.delete_building(uuid), public.delete_room(uuid), public.delete_building_area(uuid)
to authenticated;
