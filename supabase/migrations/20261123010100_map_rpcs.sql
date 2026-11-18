-- 機能 013：位置の記録（開始・終了に位置を足す）、住所から位置を求める定時の処理、位置を 90 日で消す定時の処理。
-- 定時の処理の関数は service_role だけ（Edge Function が会社ごとに呼ぶ）。処理の記録は job_runs。

-- 1. 離れたときの知らせ ----------------------------------------------------------------
-- その会社の work.assign を持つ有効な所属の人（記録した本人を除く）に、「送る前」のお知らせを作る。作れなくても、呼んだ側を止めない
create function app.notify_work_far(p_tenant uuid, p_work uuid, p_actor uuid, p_record uuid, p_phase text, p_distance int)
returns int
language plpgsql security definer set search_path = '' as $$
declare m record; v_n int := 0; v_title text; v_body text; v_who text; v_bname text; v_wtitle text;
begin
  select b.name, w.title into v_bname, v_wtitle
  from public.works w join public.buildings b on b.tenant_id = w.tenant_id and b.id = w.building_id
  where w.id = p_work and w.tenant_id = p_tenant;
  select p.display_name into v_who from public.memberships mm join public.profiles p on p.id = mm.user_id where mm.id = p_actor and mm.tenant_id = p_tenant;
  v_title := '建物から離れた場所での' || case p_phase when 'start' then '開始' else '終了' end;
  v_body := coalesce(v_who, '担当者') || 'さんが、' || coalesce(v_bname, '建物') || '（' || coalesce(v_wtitle, '作業') || '）から約 ' || p_distance || ' m 離れた場所で'
            || case p_phase when 'start' then '開始' else '終了' end || 'を押しました。';
  for m in
    select mm.id from public.memberships mm
    join public.role_permissions rp on rp.role_id = mm.role_id
    join public.permissions pe on pe.id = rp.permission_id and pe.code = 'work.assign'
    where mm.tenant_id = p_tenant and mm.status = 'active' and mm.deleted_at is null and mm.id <> p_actor
  loop
    begin
      v_n := v_n + app.enqueue_notification(p_tenant, m.id, 'work_far', v_title, v_body, '/schedule/work/?id=' || p_work::text, p_record::text || ':' || p_phase, null);
    exception when others then
      null; -- お知らせが作れなくても、記録は止めない
    end;
  end loop;
  return v_n;
end $$;

-- 2. 開始・終了に位置を足す（012 の関数を、引数を足した形で作り直す）----------------------------
-- 位置は任意（了承しなかった人は渡さない）。緯度・経度は両方か両方空、範囲内。渡されたら、建物との距離を求める
drop function public.start_work(uuid, uuid, timestamptz, text, timestamptz);
create function public.start_work(
  p_id uuid, p_work_id uuid, p_started_at timestamptz default null, p_device_id text default null, p_client_created_at timestamptz default null,
  p_lat double precision default null, p_lng double precision default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_member uuid; ex public.work_records; v_bl numeric; v_bg numeric; v_dist int; v_warn boolean := false;
begin
  if (select auth.uid()) is null or p_id is null then raise exception '権限がない' using errcode = '42501'; end if;
  select * into w from public.works where id = p_work_id and deleted_at is null for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'field.record');
  v_member := app.my_assignment(w.tenant_id, w.id);
  if v_member is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  -- 二度目：同じ人の同じ作業の実績なら、前の結果を返す（位置も知らせも増やさない）。それ以外は同じ 42501
  select * into ex from public.work_records where id = p_id;
  if found then
    if ex.tenant_id = w.tenant_id and ex.work_id = w.id and ex.membership_id = v_member then
      return jsonb_build_object('ok', true, 'already', true, 'id', p_id, 'status', w.status, 'version', w.version);
    end if;
    raise exception '権限がない' using errcode = '42501';
  end if;
  if (p_lat is null) <> (p_lng is null) or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_location');
  end if;
  if w.status not in ('scheduled', 'in_progress') then return jsonb_build_object('ok', false, 'reason', 'not_startable'); end if;
  if exists (select 1 from public.work_records x where x.tenant_id = w.tenant_id and x.work_id = w.id and x.membership_id = v_member
             and x.ended_at is null and x.deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'already_started');
  end if;
  if p_lat is not null then
    select b.lat, b.lng into v_bl, v_bg from public.buildings b where b.tenant_id = w.tenant_id and b.id = w.building_id;
    if v_bl is not null then
      v_dist := app.distance_m(p_lat, p_lng, v_bl::double precision, v_bg::double precision);
      v_warn := v_dist > app.map_far_threshold_m();
    end if;
  end if;
  insert into public.work_records (id, tenant_id, work_id, membership_id, started_at, client_created_at, device_id, start_lat, start_lng, distance_m, distance_warning)
  values (p_id, w.tenant_id, w.id, v_member, coalesce(p_started_at, now()), coalesce(p_client_created_at, p_started_at, now()), p_device_id, p_lat, p_lng, v_dist, v_warn);
  if w.status = 'scheduled' then
    update public.works set status = 'in_progress', version = version + 1 where id = w.id returning version into w.version;
    w.status := 'in_progress';
  end if;
  if v_warn then perform app.notify_work_far(w.tenant_id, w.id, v_member, p_id, 'start', v_dist); end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'status', w.status, 'version', w.version);
end $$;

drop function public.finish_work(uuid, uuid, timestamptz);
create function public.finish_work(p_id uuid, p_work_id uuid, p_ended_at timestamptz default null, p_lat double precision default null, p_lng double precision default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_member uuid; rec public.work_records; v_end timestamptz; v_bl numeric; v_bg numeric; v_now int; v_dist int; v_warn boolean := false;
begin
  if (select auth.uid()) is null or p_id is null then raise exception '権限がない' using errcode = '42501'; end if;
  select * into w from public.works where id = p_work_id and deleted_at is null for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'field.record');
  v_member := app.my_assignment(w.tenant_id, w.id);
  if v_member is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  select * into rec from public.work_records x
  where x.tenant_id = w.tenant_id and x.work_id = w.id and x.membership_id = v_member and x.deleted_at is null
  order by x.ended_at is not null, x.started_at desc limit 1; -- 終わっていないものを先に
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_started'); end if;
  if rec.ended_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'status', w.status, 'version', w.version);
  end if;
  if (p_lat is null) <> (p_lng is null) or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_location');
  end if;
  v_end := coalesce(p_ended_at, now());
  if v_end < rec.started_at then return jsonb_build_object('ok', false, 'reason', 'end_before_start'); end if;
  v_dist := rec.distance_m;
  v_warn := rec.distance_warning;
  if p_lat is not null then
    select b.lat, b.lng into v_bl, v_bg from public.buildings b where b.tenant_id = w.tenant_id and b.id = w.building_id;
    if v_bl is not null then
      v_now := app.distance_m(p_lat, p_lng, v_bl::double precision, v_bg::double precision);
      v_dist := greatest(rec.distance_m, v_now);
      v_warn := rec.distance_warning or v_now > app.map_far_threshold_m();
    end if;
  end if;
  update public.work_records set ended_at = v_end, end_lat = p_lat, end_lng = p_lng, distance_m = v_dist, distance_warning = v_warn where id = rec.id;
  -- ほかに終わっていない実績がなければ、完了にする
  if w.status = 'in_progress' and not exists (
       select 1 from public.work_records x where x.tenant_id = w.tenant_id and x.work_id = w.id and x.ended_at is null and x.deleted_at is null) then
    update public.works set status = 'done', version = version + 1 where id = w.id returning version into w.version;
    w.status := 'done';
  end if;
  -- 終了の位置そのものが離れているときだけ知らせる（開始で知らせた分を、もう一度知らせない）
  if v_now is not null and v_now > app.map_far_threshold_m() then
    perform app.notify_work_far(w.tenant_id, w.id, v_member, rec.id, 'finish', v_now);
  end if;
  return jsonb_build_object('ok', true, 'status', w.status, 'version', w.version);
end $$;

-- 3. 住所から位置を求める定時の処理（service_role）-----------------------------------------
create unique index job_runs_geocode_running_uq on public.job_runs (tenant_id, kind)
  where kind = 'geocode_buildings' and status = 'running' and deleted_at is null;

-- 求める対象の建物は、位置が空・直していない・消していない・失敗から 7 日以上（または失敗なし）
create function public.geocode_tenants() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.tenants t
  where t.deleted_at is null and t.status <> 'suspended'
    and exists (select 1 from public.buildings b
                where b.tenant_id = t.id and b.deleted_at is null and b.lat is null and b.location_fixed = false
                  and (b.geocode_failed_at is null or b.geocode_failed_at < now() - interval '7 days'))
  order by t.id
$$;

create function public.geocode_start(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.job_runs set status = 'failure', ended_at = now(), error = 'timeout'
  where tenant_id = p_tenant and kind = 'geocode_buildings' and status = 'running' and deleted_at is null
    and started_at < now() - interval '30 minutes';
  begin
    insert into public.job_runs (tenant_id, kind) values (p_tenant, 'geocode_buildings') returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

create function public.geocode_pending(p_tenant uuid, p_limit int default 50) returns table (id uuid, address text)
language sql stable security definer set search_path = '' as $$
  select b.id, b.address from public.buildings b
  where b.tenant_id = p_tenant and b.deleted_at is null and b.lat is null and b.location_fixed = false
    and (b.geocode_failed_at is null or b.geocode_failed_at < now() - interval '7 days')
  order by b.created_at, b.id
  limit greatest(p_limit, 0)
$$;

-- 保存の時点でも「位置が空で、直していない」ときだけ書く（その間に人が直していたら、上書きしない）
create function public.geocode_apply(p_tenant uuid, p_building uuid, p_lat double precision, p_lng double precision) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception '位置が正しくない' using errcode = '22023';
  end if;
  update public.buildings set lat = round(p_lat::numeric, 6), lng = round(p_lng::numeric, 6), geocode_failed_at = null
  where id = p_building and tenant_id = p_tenant and deleted_at is null and lat is null and location_fixed = false;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create function public.geocode_fail(p_tenant uuid, p_building uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update public.buildings set geocode_failed_at = now()
  where id = p_building and tenant_id = p_tenant and deleted_at is null and lat is null and location_fixed = false;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create function public.geocode_finish(p_tenant uuid, p_run uuid, p_status text, p_counts jsonb, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_status not in ('success', 'failure') then
    raise exception '状況は success か failure：%', p_status using errcode = '22023';
  end if;
  update public.job_runs set status = p_status, ended_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 300)
  where id = p_run and tenant_id = p_tenant and kind = 'geocode_buildings' and status = 'running';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- 画面から 1 件だけ求める入口の確かめ：master.edit の人だけ。自分の会社の建物の住所を返す（行がない・権限がないは同じ 42501）
create function public.geocode_target(p_building uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.buildings;
begin
  select * into b from public.buildings where id = p_building and deleted_at is null;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(b.tenant_id, 'master.edit');
  return jsonb_build_object('address', b.address);
end $$;

-- 4. 位置を 90 日で消す定時の処理（service_role）-------------------------------------------
create unique index job_runs_purge_locations_running_uq on public.job_runs (tenant_id, kind)
  where kind = 'purge_locations' and status = 'running' and deleted_at is null;

create function public.purge_locations_tenants() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct r.tenant_id from public.work_records r
  join public.tenants t on t.id = r.tenant_id and t.deleted_at is null
  where r.started_at < now() - interval '90 days'
    and (r.start_lat is not null or r.start_lng is not null or r.end_lat is not null or r.end_lng is not null)
$$;

create function public.purge_locations_start(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.job_runs set status = 'failure', ended_at = now(), error = 'timeout'
  where tenant_id = p_tenant and kind = 'purge_locations' and status = 'running' and deleted_at is null
    and started_at < now() - interval '30 minutes';
  begin
    insert into public.job_runs (tenant_id, kind) values (p_tenant, 'purge_locations') returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

-- 位置の列だけ空にする。距離・警告・時刻・行は残す。その会社の分だけ。空にした実績の数を返す
create function public.purge_locations_run(p_tenant uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update public.work_records set start_lat = null, start_lng = null, end_lat = null, end_lng = null
  where tenant_id = p_tenant and started_at < now() - interval '90 days'
    and (start_lat is not null or start_lng is not null or end_lat is not null or end_lng is not null);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create function public.purge_locations_finish(p_tenant uuid, p_run uuid, p_status text, p_counts jsonb, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_status not in ('success', 'failure') then
    raise exception '状況は success か failure：%', p_status using errcode = '22023';
  end if;
  update public.job_runs set status = p_status, ended_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 300)
  where id = p_run and tenant_id = p_tenant and kind = 'purge_locations' and status = 'running';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- 5. 使われているものは消さない ----------------------------------------------------------
-- 建物の位置は建物の列。実績は作業に付くだけで、建物を直接は指さない（012）。足す行はない。

-- 6. 実行の権限 ------------------------------------------------------------------------
select app.lock_functions();
revoke execute on function app.buildings_location_guard() from public, anon, authenticated, service_role;
revoke execute on function app.distance_m(double precision, double precision, double precision, double precision) from public, anon, authenticated, service_role;
revoke execute on function app.map_far_threshold_m() from public, anon, authenticated, service_role;
revoke execute on function app.notify_work_far(uuid, uuid, uuid, uuid, text, int) from public, anon, authenticated, service_role;
grant execute on function
  public.start_work(uuid, uuid, timestamptz, text, timestamptz, double precision, double precision),
  public.finish_work(uuid, uuid, timestamptz, double precision, double precision),
  public.geocode_target(uuid)
to authenticated;
revoke execute on function
  public.geocode_tenants(), public.geocode_start(uuid), public.geocode_pending(uuid, int),
  public.geocode_apply(uuid, uuid, double precision, double precision), public.geocode_fail(uuid, uuid),
  public.geocode_finish(uuid, uuid, text, jsonb, text),
  public.purge_locations_tenants(), public.purge_locations_start(uuid), public.purge_locations_run(uuid),
  public.purge_locations_finish(uuid, uuid, text, jsonb, text)
from public, anon, authenticated;
grant execute on function
  public.geocode_tenants(), public.geocode_start(uuid), public.geocode_pending(uuid, int),
  public.geocode_apply(uuid, uuid, double precision, double precision), public.geocode_fail(uuid, uuid),
  public.geocode_finish(uuid, uuid, text, jsonb, text),
  public.purge_locations_tenants(), public.purge_locations_start(uuid), public.purge_locations_run(uuid),
  public.purge_locations_finish(uuid, uuid, text, jsonb, text)
to service_role;
