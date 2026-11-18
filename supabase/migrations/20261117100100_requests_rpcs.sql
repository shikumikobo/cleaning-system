-- 機能 003：案件の RPC（状況の切り替え・気づきから案件）と、期限のお知らせの定時の処理。
-- RPC は security definer で RLS を通らない。中で必ず権限と、行の会社・状況を確かめる。
-- 見つからない・権限がないは、同じ 42501 で返す（案件の存在を探らせない）。

-- 1. 状況の切り替え ---------------------------------------------------------------
-- 戻り：{ok:true, changed, status} | {ok:false, reason: invalid_transition | forbidden_transition | billed, from, to}
--   request.edit を持つ人：受付 → 対応中・完了・取消、対応中 → 受付・完了・取消、完了 → 対応中、取消 → 受付
--   担当のスタッフ（field.record）：受付 → 対応中・完了、対応中 → 完了 だけ
create function public.set_request_status(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid; v_from text; v_assignee uuid; v_deleted timestamptz;
  v_editor boolean; v_ok boolean;
begin
  if (select auth.uid()) is null then raise exception '権限がない' using errcode = '42501'; end if;
  select tenant_id, status, assignee_id, deleted_at into v_tenant, v_from, v_assignee, v_deleted from public.requests where id = p_id;
  if v_tenant is null or v_deleted is not null then raise exception '権限がない' using errcode = '42501'; end if;
  v_editor := public.has_perm(v_tenant, 'request.edit');
  if not v_editor and not (public.has_perm(v_tenant, 'field.record') and app.is_owner_membership(v_tenant, v_assignee)) then
    raise exception '権限がない' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('new', 'in_progress', 'done', 'cancelled') then
    raise exception '知らない状況：%', p_status using errcode = '22023';
  end if;
  if v_from = p_status then
    return jsonb_build_object('ok', true, 'changed', false, 'status', v_from);
  end if;

  v_ok := (v_from, p_status) in (('new', 'in_progress'), ('new', 'done'), ('in_progress', 'done'));
  if not v_ok then
    if not v_editor and (v_from, p_status) in (('new', 'cancelled'), ('in_progress', 'cancelled'), ('in_progress', 'new'), ('done', 'in_progress'), ('cancelled', 'new')) then
      return jsonb_build_object('ok', false, 'reason', 'forbidden_transition', 'from', v_from, 'to', p_status);
    end if;
    v_ok := v_editor and (v_from, p_status) in (('new', 'cancelled'), ('in_progress', 'cancelled'), ('in_progress', 'new'), ('done', 'in_progress'), ('cancelled', 'new'));
  end if;
  if not v_ok then
    return jsonb_build_object('ok', false, 'reason', 'invalid_transition', 'from', v_from, 'to', p_status);
  end if;
  if p_status = 'cancelled' and app.request_charge_locked(v_tenant, p_id) then
    return jsonb_build_object('ok', false, 'reason', 'billed', 'from', v_from, 'to', p_status);
  end if;

  perform app.mark_rpc();
  update public.requests set status = p_status where id = p_id and tenant_id = v_tenant;
  return jsonb_build_object('ok', true, 'changed', true, 'status', p_status);
end $$;

-- 2. 気づきから案件を作る ------------------------------------------------------------
-- 端末で作った uuid（p_id）で、二度呼んでも1件。入口は field、状況は受付、担当は本人（本人が読めるように）。
-- 写真との つなぎ（photos.request_id）は 008 が足す。
create function public.create_request_from_observation(
  p_id uuid, p_building_id uuid, p_title text, p_detail text default null, p_room_id uuid default null, p_category text default 'other'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid; v_client uuid; v_member uuid; v_ex_tenant uuid; v_ex_by uuid;
begin
  if (select auth.uid()) is null or p_id is null then raise exception '権限がない' using errcode = '42501'; end if;
  select tenant_id, client_id into v_tenant, v_client from public.buildings where id = p_building_id and deleted_at is null;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'field.record');

  -- 二度目：同じ人が同じ会社で作ったものなら、前の結果を返す。それ以外は同じ 42501
  select tenant_id, created_by into v_ex_tenant, v_ex_by from public.requests where id = p_id;
  if v_ex_tenant is not null then
    if v_ex_tenant = v_tenant and v_ex_by = (select auth.uid()) then
      return jsonb_build_object('ok', true, 'id', p_id, 'already', true);
    end if;
    raise exception '権限がない' using errcode = '42501';
  end if;

  if p_room_id is not null and not exists (
       select 1 from public.rooms r where r.id = p_room_id and r.tenant_id = v_tenant and r.building_id = p_building_id and r.deleted_at is null) then
    raise exception '部屋がその建物にない' using errcode = '22023';
  end if;
  select id into v_member from public.memberships
  where tenant_id = v_tenant and user_id = (select auth.uid()) and status = 'active' and deleted_at is null;

  perform app.mark_rpc();
  insert into public.requests (id, tenant_id, client_id, building_id, room_id, source, category, title, detail, assignee_id, status)
  values (p_id, v_tenant, v_client, p_building_id, p_room_id, 'field', coalesce(p_category, 'other'), coalesce(p_title, ''), nullif(btrim(coalesce(p_detail, '')), ''), v_member, 'new');
  return jsonb_build_object('ok', true, 'id', p_id, 'already', false);
end $$;

-- 3. 担当に選べる人の一覧 -------------------------------------------------------------
-- 所属の表は user.manage だけが読むので、案件の画面のために別に出す（request.edit を持つ人だけ）。
-- 同じ会社の、有効な、社内の所属（外部の人を除く）。役割の code は、画面の出し分け用
create function public.request_assignees(p_tenant uuid) returns table (membership_id uuid, display_name text, role_code text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_perm(p_tenant, 'request.edit');
  return query
    select m.id, p.display_name, r.code
    from public.memberships m
    join public.roles r on r.id = m.role_id and r.code <> 'external'
    join public.profiles p on p.id = m.user_id
    where m.tenant_id = p_tenant and m.status = 'active' and m.deleted_at is null
    order by p.display_name, m.id;
end $$;

-- 4. 期限のお知らせ（会社をまたぐ定時の処理。service_role だけ） ------------------------------
-- 判定の決まり（R-003-23）：期限（日本時間の日付）が今日より前 → 期限切れ、今日から p_days 日後まで → 期限が近い。
-- 受付・対応中の案件だけ。画面の部品（apps/web/src/lib/requests/due.ts）も同じ決まり。

-- 対象の会社：期限のある、終わっていない案件を持つ会社（止めた会社を除く）
create function public.request_due_tenants() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct r.tenant_id from public.requests r
  join public.tenants t on t.id = r.tenant_id and t.status <> 'suspended'
  where r.deleted_at is null and r.status in ('new', 'in_progress') and r.due_date is not null
$$;

-- 処理の記録を始める。すでに同じ会社で動いていて 30 分以内なら null（二重の実行を避ける）
create function public.request_due_start(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.job_runs set status = 'failure', ended_at = now(), error = 'timeout'
  where tenant_id = p_tenant and kind = 'request_due' and status = 'running' and deleted_at is null
    and started_at < now() - interval '30 minutes';
  if exists (select 1 from public.job_runs where tenant_id = p_tenant and kind = 'request_due' and status = 'running' and deleted_at is null) then
    return null;
  end if;
  insert into public.job_runs (tenant_id, kind) values (p_tenant, 'request_due') returning id into v_id;
  return v_id;
end $$;

create function public.request_due_finish(p_tenant uuid, p_run uuid, p_status text, p_counts jsonb, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_status not in ('success', 'failure') then
    raise exception '状況は success か failure：%', p_status using errcode = '22023';
  end if;
  update public.job_runs set status = p_status, ended_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 300)
  where id = p_run and tenant_id = p_tenant and kind = 'request_due' and status = 'running';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- お知らせを作る。担当者（止められていなければ）に。いなければ request.edit を持つ有効な所属の全員に。
-- 重複の印：案件・期限・段階（soon・overdue）。戻り：{requests, notified}
create function public.request_due_notify(p_tenant uuid, p_run uuid default null, p_days int default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  r record; m record; v_stage text; v_title text; v_body text; v_to int;
  v_requests int := 0; v_notified int := 0;
begin
  for r in
    select q.id, q.title, q.due_date, q.assignee_id
    from public.requests q
    where q.tenant_id = p_tenant and q.deleted_at is null and q.status in ('new', 'in_progress')
      and q.due_date is not null and q.due_date <= v_today + greatest(p_days, 0)
    order by q.due_date, q.id
  loop
    v_requests := v_requests + 1;
    v_stage := case when r.due_date < v_today then 'overdue' else 'soon' end;
    v_title := case when v_stage = 'overdue' then '期限切れ：' else '期限が近い：' end || r.title;
    v_to := r.due_date - v_today;
    v_body := case
      when v_stage = 'overdue' then '期限は ' || to_char(r.due_date, 'YYYY/MM/DD') || ' でした（' || (-v_to) || ' 日過ぎています）'
      when v_to = 0 then '期限は今日（' || to_char(r.due_date, 'YYYY/MM/DD') || '）です'
      else '期限は ' || to_char(r.due_date, 'YYYY/MM/DD') || '（あと ' || v_to || ' 日）です'
    end;
    for m in
      select x.id from public.memberships x
      where x.tenant_id = p_tenant and x.status = 'active' and x.deleted_at is null
        and (
          (r.assignee_id is not null and x.id = r.assignee_id)
          or ((r.assignee_id is null
               or not exists (select 1 from public.memberships a where a.id = r.assignee_id and a.tenant_id = p_tenant and a.status = 'active' and a.deleted_at is null))
              and exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
                          where rp.role_id = x.role_id and p.code = 'request.edit'))
        )
      order by x.id
    loop
      v_notified := v_notified + app.enqueue_notification(
        p_tenant, m.id, 'request_due', v_title, v_body, '/requests/detail/?id=' || r.id::text,
        'request_due:' || r.id::text || ':' || r.due_date::text || ':' || v_stage, p_run);
    end loop;
  end loop;
  return jsonb_build_object('requests', v_requests, 'notified', v_notified);
end $$;

-- 5. 実行の権限 ---------------------------------------------------------------
select app.lock_functions();
revoke execute on function public.set_request_status(uuid, text) from public, anon;
revoke execute on function public.create_request_from_observation(uuid, uuid, text, text, uuid, text) from public, anon;
revoke execute on function public.request_assignees(uuid) from public, anon;
grant execute on function public.set_request_status(uuid, text), public.create_request_from_observation(uuid, uuid, text, text, uuid, text), public.request_assignees(uuid) to authenticated;
revoke execute on function public.request_due_tenants() from public, anon, authenticated;
revoke execute on function public.request_due_start(uuid) from public, anon, authenticated;
revoke execute on function public.request_due_finish(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.request_due_notify(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.request_due_tenants() to service_role;
grant execute on function public.request_due_start(uuid) to service_role;
grant execute on function public.request_due_finish(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.request_due_notify(uuid, uuid, int) to service_role;
