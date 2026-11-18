-- 機能 015（波 6）：出来事ごとのお知らせ。設計は specs/015-notifications/design.md の8章
--  1. 予定の変更（work_changed）：012 の日時の変更・行わず・取消・担当の入れ替えの RPC に、お知らせを足した（create or replace。ほかは 012 のまま）
--  2. 毎日の定時の処理（会社ごと・処理ごとに job_runs に記録）：明日の作業・出ていない報告書・請求の入金の遅れ
-- 期限の近い案件（003）・見積の承認（004）は、それぞれの機能で作ってある。
-- お知らせは app.enqueue_notification で「送る前」を作るだけ。送るのは send-notifications（Edge Function）。

-- 1. 道具 ----------------------------------------------------------------------

-- 日付と時刻の見せ方：07/25 09:00〜12:00（時刻がなければ日付だけ）
create function app.work_when(p_date date, p_start time, p_end time) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_date, 'MM/DD')
    || coalesce(' ' || to_char(p_start, 'HH24:MI') || coalesce('〜' || to_char(p_end, 'HH24:MI'), ''), '')
$$;

-- 作業の担当（有効な所属）に work_changed を作る。操作した本人（今ログインしている人）には作らない。
-- 重複の印：work_changed:<段階>:<作業>:<版>。戻り：作ったお知らせ（一覧の行）の数
create function app.notify_work_assignees(p_tenant uuid, p_work uuid, p_stage text, p_version int, p_title text, p_body text) returns int
language plpgsql security definer set search_path = '' as $$
declare m record; v_n int := 0;
begin
  for m in
    select distinct a.membership_id as id
    from public.work_assignments a
    join public.memberships x on x.tenant_id = a.tenant_id and x.id = a.membership_id and x.status = 'active' and x.deleted_at is null
    where a.tenant_id = p_tenant and a.work_id = p_work and a.deleted_at is null
      and x.user_id is distinct from (select auth.uid())
    order by 1
  loop
    v_n := v_n + app.enqueue_notification(p_tenant, m.id, 'work_changed', left(p_title, 100), left(p_body, 500), '/schedule/mine/',
      'work_changed:' || p_stage || ':' || p_work::text || ':' || p_version::text, null);
  end loop;
  return v_n;
end $$;

-- 2. 012 の RPC（予定の変更のお知らせを足したもの。それ以外は 012 のまま）----------------------

create or replace function public.skip_work(p_work_id uuid, p_version int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_building text;
begin
  select * into w from public.works where id = p_work_id and deleted_at is null for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(w.tenant_id, 'work.assign');
  perform app.mark_rpc();
  if w.status = 'skipped' then return jsonb_build_object('ok', true, 'already', true, 'status', 'skipped', 'version', w.version); end if;
  if w.status <> 'scheduled' then return jsonb_build_object('ok', false, 'reason', 'not_scheduled'); end if;
  if p_version is not null and p_version <> w.version then return jsonb_build_object('ok', false, 'reason', 'conflict'); end if;
  update public.works set status = 'skipped', version = version + 1 where id = w.id returning version into w.version;
  select b.name into v_building from public.buildings b where b.tenant_id = w.tenant_id and b.id = w.building_id;
  perform app.notify_work_assignees(w.tenant_id, w.id, 'skipped', w.version, '作業は行わないことになりました：' || w.title,
    coalesce(v_building, '') || '／' || app.work_when(w.scheduled_date, w.start_time, w.end_time));
  return jsonb_build_object('ok', true, 'status', 'skipped', 'version', w.version);
end $$;

create or replace function public.cancel_work(p_work_id uuid, p_version int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_building text;
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
  select b.name into v_building from public.buildings b where b.tenant_id = w.tenant_id and b.id = w.building_id;
  perform app.notify_work_assignees(w.tenant_id, w.id, 'cancelled', w.version, '作業が取り消されました：' || w.title,
    coalesce(v_building, '') || '／' || app.work_when(w.scheduled_date, w.start_time, w.end_time));
  return jsonb_build_object('ok', true, 'status', 'cancelled', 'version', w.version);
end $$;

create or replace function public.reschedule_work(p_work_id uuid, p_version int, p_date date, p_start time, p_end time) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_moved date[]; v_building text; v_old text; v_changed boolean;
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
  v_old := app.work_when(w.scheduled_date, w.start_time, w.end_time);
  v_changed := (w.scheduled_date, w.start_time, w.end_time) is distinct from (p_date, p_start, p_end);
  begin
    update public.works set scheduled_date = p_date, start_time = p_start, end_time = p_end, moved_from = v_moved, version = version + 1
     where id = w.id returning version into w.version;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_date');
  end;
  -- 日付・時刻が実際に変わったときだけ、担当に知らせる
  if v_changed then
    select b.name into v_building from public.buildings b where b.tenant_id = w.tenant_id and b.id = w.building_id;
    perform app.notify_work_assignees(w.tenant_id, w.id, 'rescheduled', w.version, '予定が変わりました：' || w.title,
      coalesce(v_building, '') || '／' || v_old || ' → ' || app.work_when(p_date, p_start, p_end));
  end if;
  return jsonb_build_object('ok', true, 'status', w.status, 'version', w.version);
end $$;

create or replace function public.swap_assignment(p_work_id uuid, p_from uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.works; v_row uuid; v_new uuid; v_building text; v_body text; v_me uuid := (select auth.uid()); v_user uuid;
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
  insert into public.work_assignments (tenant_id, work_id, membership_id) values (w.tenant_id, w.id, p_to) returning id into v_new;
  -- 新しい担当に「担当になった」、外れた人に「担当から外れた」。操作した本人には作らない
  select b.name into v_building from public.buildings b where b.tenant_id = w.tenant_id and b.id = w.building_id;
  v_body := coalesce(v_building, '') || '／' || app.work_when(w.scheduled_date, w.start_time, w.end_time);
  select m.user_id into v_user from public.memberships m where m.tenant_id = w.tenant_id and m.id = p_to;
  if v_user is distinct from v_me then
    perform app.enqueue_notification(w.tenant_id, p_to, 'work_changed', left('担当になりました：' || w.title, 100), left(v_body, 500), '/schedule/mine/',
      'work_changed:assigned:' || w.id::text || ':' || v_new::text, null);
  end if;
  select m.user_id into v_user from public.memberships m where m.tenant_id = w.tenant_id and m.id = p_from;
  if v_user is distinct from v_me then
    perform app.enqueue_notification(w.tenant_id, p_from, 'work_changed', left('担当から外れました：' || w.title, 100), left(v_body, 500), '/schedule/mine/',
      'work_changed:unassigned:' || w.id::text || ':' || v_row::text, null);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 3. 毎日の定時の処理の記録 ---------------------------------------------------------
-- 処理の名前：work_tomorrow（明日の作業）・report_missing（出ていない報告書）・invoice_overdue（請求の入金の遅れ）。
-- job_runs の kind は notify_<処理の名前>。同じ会社・同じ処理の running は1つだけ。

create unique index job_runs_daily_notify_running_uq on public.job_runs (tenant_id, kind)
  where kind in ('notify_work_tomorrow', 'notify_report_missing', 'notify_invoice_overdue') and status = 'running' and deleted_at is null;

-- 対象の会社：止めた会社を除く全部
create function public.daily_notify_tenants() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.tenants t where t.status <> 'suspended' order by t.id
$$;

-- 記録を始める。すでに動いていれば null。30 分を過ぎた running は、失敗（timeout）で閉じて始め直す
create function public.daily_notify_start(p_tenant uuid, p_task text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_kind text;
begin
  if p_task not in ('work_tomorrow', 'report_missing', 'invoice_overdue') then
    raise exception '知らない処理：%', p_task using errcode = '22023';
  end if;
  v_kind := 'notify_' || p_task;
  update public.job_runs set status = 'failure', ended_at = now(), error = 'timeout'
  where tenant_id = p_tenant and kind = v_kind and status = 'running' and deleted_at is null
    and started_at < now() - interval '30 minutes';
  begin
    insert into public.job_runs (tenant_id, kind) values (p_tenant, v_kind) returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

create function public.daily_notify_finish(p_tenant uuid, p_run uuid, p_task text, p_status text, p_counts jsonb, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_status not in ('success', 'failure') then
    raise exception '結果は success か failure：%', p_status using errcode = '22023';
  end if;
  update public.job_runs set status = p_status, ended_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 300)
  where id = p_run and tenant_id = p_tenant and kind = 'notify_' || p_task and status = 'running';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- 4. 明日の作業（R-015-33・34）---------------------------------------------------------
-- 日本時間の明日が日付の「予定」の作業を持つ担当（有効な所属）ごとに1件。本文は時刻順（時刻のないものは最後）。
-- 重複の印：work_tomorrow:<日付>。戻り：{works: 明日の作業の数（担当がいるもの）, notified: お知らせを作った人の数}
create function public.work_tomorrow_notify(p_tenant uuid, p_run uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tomorrow date := (now() at time zone 'Asia/Tokyo')::date + 1;
  m record; v_lines text[]; v_line text; v_body text; v_shown int;
  v_works int; v_notified int := 0;
begin
  select count(distinct w.id) into v_works
  from public.works w
  where w.tenant_id = p_tenant and w.deleted_at is null and w.status = 'scheduled' and w.scheduled_date = v_tomorrow
    and exists (select 1 from public.work_assignments a join public.memberships x on x.tenant_id = a.tenant_id and x.id = a.membership_id and x.status = 'active' and x.deleted_at is null
                where a.tenant_id = w.tenant_id and a.work_id = w.id and a.deleted_at is null);
  for m in
    select a.membership_id as id, count(*)::int as n,
           array_agg(left(coalesce(to_char(w.start_time, 'HH24:MI'), '時刻未定') || ' ' || coalesce(b.name, '') || ' ' || w.title, 150)
                     order by w.start_time nulls last, w.title, w.id) as lines
    from public.work_assignments a
    join public.works w on w.tenant_id = a.tenant_id and w.id = a.work_id and w.deleted_at is null and w.status = 'scheduled' and w.scheduled_date = v_tomorrow
    join public.memberships x on x.tenant_id = a.tenant_id and x.id = a.membership_id and x.status = 'active' and x.deleted_at is null
    left join public.buildings b on b.tenant_id = w.tenant_id and b.id = w.building_id
    where a.tenant_id = p_tenant and a.deleted_at is null
    group by a.membership_id
    order by a.membership_id
  loop
    v_body := ''; v_shown := 0;
    foreach v_line in array m.lines loop
      exit when length(v_body) + length(v_line) + 1 > 470;
      v_body := v_body || case when v_body = '' then '' else E'\n' end || v_line;
      v_shown := v_shown + 1;
    end loop;
    if v_shown < m.n then v_body := v_body || E'\n' || 'ほか ' || (m.n - v_shown) || ' 件'; end if;
    if app.enqueue_notification(p_tenant, m.id, 'work_tomorrow', '明日の作業：' || m.n || '件', v_body, '/schedule/mine/',
         'work_tomorrow:' || v_tomorrow::text, p_run) > 0 then
      v_notified := v_notified + 1;
    end if;
  end loop;
  return jsonb_build_object('works', v_works, 'notified', v_notified);
end $$;

-- 5. 出ていない報告書（R-015-35・36）---------------------------------------------------
-- 012 の予実の決め方と同じ：完了した作業で、報告書が提出になっていない（なし・下書き・確認済み）。
-- 日付が今日（日本時間）より前から p_days 日前まで。担当と、work.assign を持つ有効な所属に、作業ごと・人ごとに1件。
-- 重複の印：report_missing:<作業>:<作業の日>
create function public.report_missing_notify(p_tenant uuid, p_run uuid default null, p_days int default 14) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  r record; m record; v_works int := 0; v_notified int := 0; v_state text;
begin
  for r in
    select w.id, w.title, w.scheduled_date, b.name as building, coalesce(rep.status, 'none') as report_status
    from public.works w
    left join public.buildings b on b.tenant_id = w.tenant_id and b.id = w.building_id
    left join public.reports rep on rep.tenant_id = w.tenant_id and rep.work_id = w.id and rep.deleted_at is null
    where w.tenant_id = p_tenant and w.deleted_at is null and w.status = 'done'
      and w.scheduled_date < v_today and w.scheduled_date >= v_today - greatest(coalesce(p_days, 14), 0)
      and coalesce(rep.status, 'none') <> 'submitted'
    order by w.scheduled_date, w.id
  loop
    v_works := v_works + 1;
    v_state := case r.report_status when 'draft' then '下書き' when 'checked' then '確認済み（提出前）' else '未作成' end;
    for m in
      select x.id from public.memberships x
      where x.tenant_id = p_tenant and x.status = 'active' and x.deleted_at is null
        and (
          exists (select 1 from public.work_assignments a where a.tenant_id = p_tenant and a.work_id = r.id and a.membership_id = x.id and a.deleted_at is null)
          or exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = x.role_id and p.code = 'work.assign')
        )
      order by x.id
    loop
      if app.enqueue_notification(p_tenant, m.id, 'report_missing',
           left('報告書がまだ出ていません：' || r.title, 100),
           left(coalesce(r.building, '') || '／' || to_char(r.scheduled_date, 'MM/DD') || ' の作業。報告書は' || v_state || 'です', 500),
           '/reports/edit/?work=' || r.id::text, 'report_missing:' || r.id::text || ':' || r.scheduled_date::text, p_run) > 0 then
        v_notified := v_notified + 1;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('works', v_works, 'notified', v_notified);
end $$;

-- 6. 請求の入金の遅れ（R-015-37・38）-----------------------------------------------------
-- 発行・送付・一部入金の請求書で、期日が今日（日本時間）より前、入金を引いた残高が0より大きいもの。
-- 請求書を作った人と管理者に（種類に要る amount.read は enqueue_notification が確かめる）。
-- 重複の印：invoice_overdue:<請求書>:<期日>。期日を直したときは、新しい期日として作る
create function public.invoice_overdue_notify(p_tenant uuid, p_run uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  r record; m record; v_invoices int := 0; v_notified int := 0;
begin
  for r in
    select i.id, i.number, i.due_date, i.created_by, c.name as client_name,
           i.total - coalesce((select sum(p.amount) from public.payments p where p.tenant_id = i.tenant_id and p.invoice_id = i.id and p.deleted_at is null), 0) as balance
    from public.invoices i
    left join public.clients c on c.tenant_id = i.tenant_id and c.id = i.client_id
    where i.tenant_id = p_tenant and i.deleted_at is null and i.status in ('issued', 'sent', 'partial')
      and i.due_date is not null and i.due_date < v_today
    order by i.due_date, i.id
  loop
    if r.balance <= 0 then continue; end if;
    v_invoices := v_invoices + 1;
    for m in
      select x.id from public.memberships x
      where x.tenant_id = p_tenant and x.status = 'active' and x.deleted_at is null
        and (
          (r.created_by is not null and x.user_id = r.created_by)
          or exists (select 1 from public.roles ro where ro.id = x.role_id and ro.code = 'admin')
        )
      order by x.id
    loop
      if app.enqueue_notification(p_tenant, m.id, 'invoice_overdue',
           left('入金が遅れています：' || coalesce(r.number, '') || ' ' || coalesce(r.client_name, ''), 100),
           '期日は ' || to_char(r.due_date, 'YYYY/MM/DD') || '（' || (v_today - r.due_date) || ' 日超過）、残高は ' || to_char(r.balance, 'FM999,999,999,999') || ' 円です',
           '/invoices/edit/?id=' || r.id::text, 'invoice_overdue:' || r.id::text || ':' || r.due_date::text, p_run) > 0 then
        v_notified := v_notified + 1;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('invoices', v_invoices, 'notified', v_notified);
end $$;

-- 7. 実行の権限 ---------------------------------------------------------------------
select app.lock_functions();
revoke execute on function app.work_when(date, time, time) from public, anon, authenticated, service_role;
revoke execute on function app.notify_work_assignees(uuid, uuid, text, int, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.daily_notify_tenants() from public, anon, authenticated;
revoke execute on function public.daily_notify_start(uuid, text) from public, anon, authenticated;
revoke execute on function public.daily_notify_finish(uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.work_tomorrow_notify(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.report_missing_notify(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.invoice_overdue_notify(uuid, uuid) from public, anon, authenticated;
grant execute on function public.daily_notify_tenants() to service_role;
grant execute on function public.daily_notify_start(uuid, text) to service_role;
grant execute on function public.daily_notify_finish(uuid, uuid, text, text, jsonb, text) to service_role;
grant execute on function public.work_tomorrow_notify(uuid, uuid) to service_role;
grant execute on function public.report_missing_notify(uuid, uuid, int) to service_role;
grant execute on function public.invoice_overdue_notify(uuid, uuid) to service_role;
