-- 機能 012：作業の RPC（開始・終了・行わず・取消・日時の変更・手で足す・担当の入れ替え）と、担当にできる人の一覧・重なりの確かめ。
-- RPC は security definer で RLS を通らない。中で必ず権限と、行の会社・状況を確かめる。
-- 行が見つからない・権限がないは、同じ 42501 で返す（ほかの会社の行の存在を探らせない）。
-- 業務の決まりで断るときは、例外ではなく {ok:false, reason} を返す（画面が日本語で理由を出せる）。
-- 状況の流れ：予定（scheduled）→ 実施中（in_progress）→ 完了（done）。予定からは 行わず（skipped）・取消（cancelled）へ行ける。

-- 自分が（その会社で）、その作業の担当の所属か。なければ null
create function app.my_assignment(p_tenant uuid, p_work uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.membership_id from public.work_assignments a
  join public.memberships m on m.tenant_id = a.tenant_id and m.id = a.membership_id and m.status = 'active' and m.deleted_at is null
  where a.tenant_id = p_tenant and a.work_id = p_work and a.deleted_at is null and m.user_id = (select auth.uid())
  limit 1
$$;

-- 1. 開始（作業の担当。端末の uuid で二度目は何もしない）--------------------------------
create function public.start_work(
  p_id uuid, p_work_id uuid, p_started_at timestamptz default null, p_device_id text default null, p_client_created_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_member uuid; ex public.work_records;
begin
  if (select auth.uid()) is null or p_id is null then raise exception '権限がない' using errcode = '42501'; end if;
  select * into w from public.works where id = p_work_id and deleted_at is null for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'field.record');
  v_member := app.my_assignment(w.tenant_id, w.id);
  if v_member is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  -- 二度目：同じ人の同じ作業の実績なら、前の結果を返す。それ以外は同じ 42501
  select * into ex from public.work_records where id = p_id;
  if found then
    if ex.tenant_id = w.tenant_id and ex.work_id = w.id and ex.membership_id = v_member then
      return jsonb_build_object('ok', true, 'already', true, 'id', p_id, 'status', w.status, 'version', w.version);
    end if;
    raise exception '権限がない' using errcode = '42501';
  end if;
  if w.status not in ('scheduled', 'in_progress') then return jsonb_build_object('ok', false, 'reason', 'not_startable'); end if;
  if exists (select 1 from public.work_records x where x.tenant_id = w.tenant_id and x.work_id = w.id and x.membership_id = v_member
             and x.ended_at is null and x.deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'already_started');
  end if;
  insert into public.work_records (id, tenant_id, work_id, membership_id, started_at, client_created_at, device_id)
  values (p_id, w.tenant_id, w.id, v_member, coalesce(p_started_at, now()), coalesce(p_client_created_at, p_started_at, now()), p_device_id);
  if w.status = 'scheduled' then
    update public.works set status = 'in_progress', version = version + 1 where id = w.id returning version into w.version;
    w.status := 'in_progress';
  end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'status', w.status, 'version', w.version);
end $$;

-- 2. 終了（作業の担当）。p_id は送り箱の印（開始の uuid とは別）。自分の終わっていない実績を終える ----
create function public.finish_work(p_id uuid, p_work_id uuid, p_ended_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_member uuid; rec public.work_records; v_end timestamptz;
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
  v_end := coalesce(p_ended_at, now());
  if v_end < rec.started_at then return jsonb_build_object('ok', false, 'reason', 'end_before_start'); end if;
  update public.work_records set ended_at = v_end where id = rec.id;
  -- ほかに終わっていない実績がなければ、完了にする
  if w.status = 'in_progress' and not exists (
       select 1 from public.work_records x where x.tenant_id = w.tenant_id and x.work_id = w.id and x.ended_at is null and x.deleted_at is null) then
    update public.works set status = 'done', version = version + 1 where id = w.id returning version into w.version;
    w.status := 'done';
  end if;
  return jsonb_build_object('ok', true, 'status', w.status, 'version', w.version);
end $$;

-- 3. 行わず・取消・日時の変更（work.assign）。予定の作業だけ。p_version を渡したときは、版が古ければ conflict ----
create function public.skip_work(p_work_id uuid, p_version int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works;
begin
  select * into w from public.works where id = p_work_id and deleted_at is null for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'work.assign');
  perform app.mark_rpc();
  if w.status = 'skipped' then return jsonb_build_object('ok', true, 'already', true, 'status', 'skipped', 'version', w.version); end if;
  if w.status <> 'scheduled' then return jsonb_build_object('ok', false, 'reason', 'not_scheduled'); end if;
  if p_version is not null and p_version <> w.version then return jsonb_build_object('ok', false, 'reason', 'conflict'); end if;
  update public.works set status = 'skipped', version = version + 1 where id = w.id returning version into w.version;
  return jsonb_build_object('ok', true, 'status', 'skipped', 'version', w.version);
end $$;

-- 取消：行は残す（deleted_at は入れない）。そのため、定時の処理は同じ日に作り直さない（010 の一意の索引が日を押さえる）
create function public.cancel_work(p_work_id uuid, p_version int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works;
begin
  select * into w from public.works where id = p_work_id and deleted_at is null for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'work.assign');
  perform app.mark_rpc();
  if w.status = 'cancelled' then return jsonb_build_object('ok', true, 'already', true, 'status', 'cancelled', 'version', w.version); end if;
  if w.status <> 'scheduled' then return jsonb_build_object('ok', false, 'reason', 'not_scheduled'); end if;
  if p_version is not null and p_version <> w.version then return jsonb_build_object('ok', false, 'reason', 'conflict'); end if;
  if app.work_charge_locked(w.tenant_id, w.id) then return jsonb_build_object('ok', false, 'reason', 'invoiced'); end if;
  update public.works set status = 'cancelled', version = version + 1 where id = w.id returning version into w.version;
  return jsonb_build_object('ok', true, 'status', 'cancelled', 'version', w.version);
end $$;

-- 日付と時刻を動かす。定時の処理が作った作業は、元の日を moved_from に持つ（定時の処理がその日を作り直さない）
create function public.reschedule_work(p_work_id uuid, p_version int, p_date date, p_start time, p_end time) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_moved date[];
begin
  select * into w from public.works where id = p_work_id and deleted_at is null for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'work.assign');
  perform app.mark_rpc();
  if w.status <> 'scheduled' then return jsonb_build_object('ok', false, 'reason', 'not_scheduled'); end if;
  if p_date is null then return jsonb_build_object('ok', false, 'reason', 'date_required'); end if;
  if p_start is not null and p_end is not null and p_end <= p_start then return jsonb_build_object('ok', false, 'reason', 'invalid_time'); end if;
  if p_version is not null and p_version <> w.version then return jsonb_build_object('ok', false, 'reason', 'conflict'); end if;
  -- 定時の処理が作った作業は、元の日（作った日）を覚える。元の日に戻したら、覚えを消す。途中の日は覚えない
  v_moved := w.moved_from;
  if w.run_id is not null and p_date <> w.scheduled_date then
    if p_date = any (v_moved) then v_moved := array_remove(v_moved, p_date);
    elsif cardinality(v_moved) = 0 then v_moved := array[w.scheduled_date];
    end if;
  end if;
  begin
    update public.works set scheduled_date = p_date, start_time = p_start, end_time = p_end, moved_from = v_moved, version = version + 1
     where id = w.id returning version into w.version;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_date');
  end;
  return jsonb_build_object('ok', true, 'status', w.status, 'version', w.version);
end $$;

-- 4. 手で作業を足す（work.assign）。案件か契約の中身のどちらか1つを選ぶ。端末で作った uuid で二度目は何もしない ----
create function public.create_work(
  p_id uuid, p_date date, p_start time default null, p_end time default null,
  p_contract_service_id uuid default null, p_request_id uuid default null, p_title text default null, p_members uuid[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.contract_services; c public.contracts; r public.requests; v_tenant uuid; v_building uuid; v_title text; v_tpl uuid; v_key uuid;
  v_start time := p_start; v_end time := p_end; m uuid; ex_tenant uuid;
begin
  if (select auth.uid()) is null or p_id is null then raise exception '権限がない' using errcode = '42501'; end if;
  if (p_contract_service_id is null) = (p_request_id is null) then return jsonb_build_object('ok', false, 'reason', 'source_required'); end if;
  if p_contract_service_id is not null then
    select * into s from public.contract_services where id = p_contract_service_id and deleted_at is null;
    if not found then raise exception '権限がない' using errcode = '42501'; end if;
    v_tenant := s.tenant_id;
  else
    select * into r from public.requests where id = p_request_id and deleted_at is null;
    if not found then raise exception '権限がない' using errcode = '42501'; end if;
    v_tenant := r.tenant_id;
  end if;
  perform app.require_perm(v_tenant, 'work.assign');
  perform app.mark_rpc();
  select tenant_id into ex_tenant from public.works where id = p_id;
  if found then
    if ex_tenant = v_tenant then return jsonb_build_object('ok', true, 'already', true, 'id', p_id); end if;
    raise exception '権限がない' using errcode = '42501';
  end if;
  if p_date is null then return jsonb_build_object('ok', false, 'reason', 'date_required'); end if;
  if v_start is not null and v_end is not null and v_end <= v_start then return jsonb_build_object('ok', false, 'reason', 'invalid_time'); end if;
  foreach m in array coalesce(p_members, '{}') loop
    if m is null or not app.request_assignee_ok(v_tenant, m)
       or not exists (select 1 from public.memberships x where x.id = m and x.tenant_id = v_tenant and x.status = 'active' and x.deleted_at is null) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_member');
    end if;
  end loop;

  if p_contract_service_id is not null then
    select * into c from public.contracts where tenant_id = s.tenant_id and id = s.contract_id and deleted_at is null;
    if not found then raise exception '権限がない' using errcode = '42501'; end if;
    if c.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'contract_ended'); end if;
    if p_date < c.start_date or (c.end_date is not null and p_date > c.end_date)
       or p_date < s.valid_from or (s.valid_to is not null and p_date > s.valid_to) then
      return jsonb_build_object('ok', false, 'reason', 'out_of_contract');
    end if;
    v_building := c.building_id; v_title := s.name; v_tpl := s.report_template_id; v_key := s.service_key;
    if v_start is null and v_end is null then v_start := s.start_time; v_end := s.end_time; end if;
  else
    if r.status in ('done', 'cancelled') then return jsonb_build_object('ok', false, 'reason', 'request_closed'); end if;
    v_building := r.building_id; v_title := r.title;
  end if;
  v_title := coalesce(nullif(btrim(p_title), ''), v_title);

  insert into public.works (id, tenant_id, building_id, contract_service_id, request_id, service_key, title, report_template_id, scheduled_date, start_time, end_time)
  values (p_id, v_tenant, v_building, p_contract_service_id, p_request_id, v_key, v_title, v_tpl, p_date, v_start, v_end);
  if p_contract_service_id is not null and s.billing = 'per_visit' then
    insert into public.work_charges (tenant_id, work_id, amount) values (v_tenant, p_id, s.amount);
  end if;
  insert into public.work_assignments (tenant_id, work_id, membership_id)
  select v_tenant, p_id, q.x from (select distinct unnest(coalesce(p_members, '{}')) as x) q;
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

-- 5. 担当の入れ替え（work.assign）。外す・付けるを1つの処理で ---------------------------------
create function public.swap_assignment(p_work_id uuid, p_from uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_row uuid;
begin
  select * into w from public.works where id = p_work_id and deleted_at is null for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'work.assign');
  perform app.mark_rpc();
  if w.status not in ('scheduled', 'in_progress') then return jsonb_build_object('ok', false, 'reason', 'work_closed'); end if;
  select id into v_row from public.work_assignments
   where tenant_id = w.tenant_id and work_id = w.id and membership_id = p_from and deleted_at is null;
  if v_row is null then return jsonb_build_object('ok', false, 'reason', 'not_assigned'); end if;
  if p_to is null or not app.request_assignee_ok(w.tenant_id, p_to)
     or not exists (select 1 from public.memberships x where x.id = p_to and x.tenant_id = w.tenant_id and x.status = 'active' and x.deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_member');
  end if;
  if exists (select 1 from public.work_assignments where tenant_id = w.tenant_id and work_id = w.id and membership_id = p_to and deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'already_assigned');
  end if;
  if exists (select 1 from public.work_records where tenant_id = w.tenant_id and work_id = w.id and membership_id = p_from and deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'has_record');
  end if;
  update public.work_assignments set deleted_at = now() where id = v_row;
  insert into public.work_assignments (tenant_id, work_id, membership_id) values (w.tenant_id, w.id, p_to);
  return jsonb_build_object('ok', true);
end $$;

-- 6. 担当にできる人の一覧（work.assign）。所属の表は user.manage だけが読むので、予定の画面のために別に出す ----
create function public.work_staff(p_tenant uuid) returns table (membership_id uuid, display_name text, role_code text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_perm(p_tenant, 'work.assign');
  return query
    select m.id, p.display_name, r.code
    from public.memberships m
    join public.roles r on r.id = m.role_id and r.code <> 'external'
    join public.profiles p on p.id = m.user_id
    where m.tenant_id = p_tenant and m.status = 'active' and m.deleted_at is null
    order by p.display_name, m.id;
end $$;

-- 7. 担当を付ける前の確かめ：その人の同じ日の、時刻が重なる別の作業（work.assign）----------------
create function public.assign_conflicts(p_work uuid, p_membership uuid)
returns table (work_id uuid, title text, building_id uuid, scheduled_date date, start_time time, end_time time)
language plpgsql stable security definer set search_path = '' as $$
declare w public.works;
begin
  select * into w from public.works where id = p_work and deleted_at is null;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'work.assign');
  return query
    select o.id, o.title, o.building_id, o.scheduled_date, o.start_time, o.end_time
    from public.works o
    join public.work_assignments a on a.tenant_id = o.tenant_id and a.work_id = o.id and a.deleted_at is null and a.membership_id = p_membership
    where o.tenant_id = w.tenant_id and o.id <> w.id and o.deleted_at is null and o.scheduled_date = w.scheduled_date
      and o.status not in ('skipped', 'cancelled')
      and w.start_time is not null and w.end_time is not null and o.start_time is not null and o.end_time is not null
      and w.start_time < o.end_time and o.start_time < w.end_time
    order by o.start_time;
end $$;

-- 8. 010 の定時の処理：動かした予定の元の日は作り直さない（schedule_insert に1つ条件を足した。ほかは 010 のまま）----
create or replace function public.schedule_insert(p_tenant uuid, p_run uuid, p_works jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_input int; v_created int; v_asg int; v_chg int;
begin
  if jsonb_typeof(p_works) is distinct from 'array' then raise exception '作業の一覧は配列' using errcode = '22023'; end if;
  with input as (
    select distinct (e ->> 'service_id')::uuid as sid, (e ->> 'date')::date as d from jsonb_array_elements(p_works) e
  ),
  ins as (
    insert into public.works (tenant_id, building_id, contract_service_id, service_key, title, report_template_id, scheduled_date, start_time, end_time, run_id)
    select p_tenant, c.building_id, s.id, s.service_key, s.name, s.report_template_id, i.d, s.start_time, s.end_time, p_run
    from input i
    join public.contract_services s on s.id = i.sid and s.tenant_id = p_tenant and s.deleted_at is null
    join public.contracts c on c.tenant_id = s.tenant_id and c.id = s.contract_id and c.status = 'active' and c.deleted_at is null
    where i.d >= s.valid_from and (s.valid_to is null or i.d <= s.valid_to) and i.d >= c.start_date and (c.end_date is null or i.d <= c.end_date)
      and not exists (select 1 from public.works t where t.tenant_id = p_tenant and t.service_key = s.service_key and i.d = any (t.moved_from) and t.deleted_at is null)
    on conflict (tenant_id, service_key, scheduled_date) where run_id is not null and deleted_at is null do nothing
    returning id, contract_service_id
  ),
  asg as (
    insert into public.work_assignments (tenant_id, work_id, membership_id)
    select p_tenant, ins.id, st.membership_id
    from ins
    join public.contract_service_staff st on st.tenant_id = p_tenant and st.contract_service_id = ins.contract_service_id and st.deleted_at is null
    join public.memberships m on m.tenant_id = p_tenant and m.id = st.membership_id and m.status = 'active' and m.deleted_at is null
    returning 1
  ),
  chg as (
    insert into public.work_charges (tenant_id, work_id, amount)
    select p_tenant, ins.id, s.amount from ins
    join public.contract_services s on s.id = ins.contract_service_id and s.billing = 'per_visit'
    returning 1
  )
  select (select count(*) from input), (select count(*) from ins), (select count(*) from asg), (select count(*) from chg)
  into v_input, v_created, v_asg, v_chg;
  return jsonb_build_object('created', v_created, 'skipped', v_input - v_created, 'assignments', v_asg, 'charges', v_chg);
end $$;

-- 9. 実行の権限 ------------------------------------------------------------------------
select app.lock_functions();
revoke execute on function app.my_assignment(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.schedule_insert(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.schedule_insert(uuid, uuid, jsonb) to service_role;
grant execute on function
  public.start_work(uuid, uuid, timestamptz, text, timestamptz), public.finish_work(uuid, uuid, timestamptz),
  public.skip_work(uuid, int), public.cancel_work(uuid, int), public.reschedule_work(uuid, int, date, time, time),
  public.create_work(uuid, date, time, time, uuid, uuid, text, uuid[]), public.swap_assignment(uuid, uuid, uuid),
  public.work_staff(uuid), public.assign_conflicts(uuid, uuid)
to authenticated;
