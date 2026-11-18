-- 機能 010：契約の RPC（作る・変える・終える）と、予定を作る定時の処理が呼ぶ関数。
-- RPC は security definer で RLS を通らない。中で必ず権限（contract.edit）と、行の会社・状況を確かめる。
-- 行が見つからない・権限がないは、同じ 42501 で返す（ほかの会社の行の存在を探らせない）。
-- 業務の決まりで断るときは、例外ではなく {ok:false, reason} を返す（画面が日本語で理由を出せる）。

-- 1. 見積から契約を作る ------------------------------------------------------------
-- 承認された見積の明細が、清掃の中身になる：基本 → 基本（毎月）、オプション → オプション（行った回ごと）、単発 → 特別清掃（行った回ごと）。
-- 繰り返しのない明細は単発（FREQ=DAILY;COUNT=1）。起点は開始日。同じ見積からもう一度呼んでも、同じ契約を返す。
create function public.create_contract_from_quote(p_quote_id uuid, p_start_date date, p_end_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes; v_existing uuid; v_id uuid := gen_random_uuid(); v_n int;
begin
  select * into q from public.quotes where id = p_quote_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'contract.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  select id into v_existing from public.contracts where tenant_id = q.tenant_id and quote_id = q.id and deleted_at is null;
  if found then return jsonb_build_object('ok', true, 'already', true, 'id', v_existing); end if;
  if q.status <> 'approved' then return jsonb_build_object('ok', false, 'reason', 'not_approved'); end if;
  if p_start_date is null then return jsonb_build_object('ok', false, 'reason', 'start_required'); end if;
  if p_end_date is not null and p_end_date < p_start_date then return jsonb_build_object('ok', false, 'reason', 'end_before_start'); end if;
  if not exists (select 1 from public.quote_lines l where l.tenant_id = q.tenant_id and l.quote_id = q.id and l.deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'no_lines');
  end if;

  insert into public.contracts (id, tenant_id, client_id, building_id, source, quote_id, kind, start_date, end_date)
  values (v_id, q.tenant_id, q.client_id, q.building_id, 'quote', q.id,
          case when q.kind = 'recurring' then 'recurring' else 'one_time' end, p_start_date, p_end_date);
  insert into public.contract_services (tenant_id, contract_id, service_kind, name, amount, billing, recurrence, valid_from)
  select l.tenant_id, v_id,
         case l.line_kind when 'base' then 'base' when 'option' then 'option' else 'special' end,
         l.name, l.amount,
         case when l.line_kind = 'base' then 'monthly' else 'per_visit' end,
         coalesce(l.recurrence, 'FREQ=DAILY;COUNT=1'), p_start_date
  from public.quote_lines l
  where l.tenant_id = q.tenant_id and l.quote_id = q.id and l.deleted_at is null
  order by l.sort, l.created_at;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'id', v_id, 'services', v_n);
end $$;

-- 2. 取り込みで契約を作る（014。見積はなし。取り込んだ人の権限で呼ぶ）-----------------------
-- p_services：[{service_kind, name, amount, billing?, recurrence?, start_time?, end_time?, report_template_id?}]
create function public.create_contract_import(
  p_client_id uuid, p_building_id uuid, p_kind text, p_start_date date, p_end_date date, p_services jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid; v_id uuid := gen_random_uuid(); e jsonb; v_kind text; v_amount text; v_billing text; v_rec text;
  v_st time; v_et time; v_n int := 0;
begin
  select tenant_id into v_tenant from public.buildings where id = p_building_id and deleted_at is null;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'contract.edit');
  if not exists (select 1 from public.clients where id = p_client_id and tenant_id = v_tenant and deleted_at is null) then
    raise exception '権限がない' using errcode = '42501';
  end if;
  perform app.mark_rpc();
  if p_kind not in ('recurring', 'one_time') then return jsonb_build_object('ok', false, 'reason', 'invalid_kind'); end if;
  if p_start_date is null then return jsonb_build_object('ok', false, 'reason', 'start_required'); end if;
  if p_end_date is not null and p_end_date < p_start_date then return jsonb_build_object('ok', false, 'reason', 'end_before_start'); end if;
  if jsonb_typeof(p_services) is distinct from 'array' or jsonb_array_length(p_services) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_services');
  end if;
  -- 先に全部を確かめる（途中で断って、半分だけ作らない）
  for e in select * from jsonb_array_elements(p_services) loop
    v_kind := e ->> 'service_kind';
    if v_kind is null or v_kind not in ('base', 'option', 'special') then return jsonb_build_object('ok', false, 'reason', 'invalid_service_kind'); end if;
    if nullif(btrim(e ->> 'name'), '') is null then return jsonb_build_object('ok', false, 'reason', 'invalid_name'); end if;
    v_amount := e ->> 'amount';
    if v_amount is null or v_amount !~ '^[0-9]{1,11}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
    v_billing := coalesce(e ->> 'billing', case when v_kind = 'base' then 'monthly' else 'per_visit' end);
    if v_billing not in ('monthly', 'per_visit') then return jsonb_build_object('ok', false, 'reason', 'invalid_billing'); end if;
    v_rec := coalesce(e ->> 'recurrence', 'FREQ=DAILY;COUNT=1');
    if v_rec !~ '^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$' then return jsonb_build_object('ok', false, 'reason', 'invalid_recurrence'); end if;
    begin
      v_st := (e ->> 'start_time')::time; v_et := (e ->> 'end_time')::time;
    exception when others then
      return jsonb_build_object('ok', false, 'reason', 'invalid_time');
    end;
    if v_st is not null and v_et is not null and v_et <= v_st then return jsonb_build_object('ok', false, 'reason', 'invalid_time'); end if;
  end loop;

  insert into public.contracts (id, tenant_id, client_id, building_id, source, quote_id, kind, start_date, end_date)
  values (v_id, v_tenant, p_client_id, p_building_id, 'import', null, p_kind, p_start_date, p_end_date);
  for e in select * from jsonb_array_elements(p_services) loop
    v_kind := e ->> 'service_kind';
    insert into public.contract_services (tenant_id, contract_id, service_kind, name, amount, billing, recurrence, start_time, end_time, report_template_id, valid_from)
    values (v_tenant, v_id, v_kind, btrim(e ->> 'name'), (e ->> 'amount')::bigint,
            coalesce(e ->> 'billing', case when v_kind = 'base' then 'monthly' else 'per_visit' end),
            coalesce(e ->> 'recurrence', 'FREQ=DAILY;COUNT=1'),
            (e ->> 'start_time')::time, (e ->> 'end_time')::time, (e ->> 'report_template_id')::uuid, p_start_date);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'id', v_id, 'services', v_n);
end $$;

-- 3. 契約の中身を変える -------------------------------------------------------------
-- 今の行を valid_to（適用日の前日）で閉じ、同じ service_key で新しい行（valid_from は適用日）を作る。
-- 決まった担当は新しい行に引き継ぐ。適用日以降の、まだ始まっていない予定（定時の処理が作ったもの）は取り消す
-- （status を cancelled にし、deleted_at も入れる。次の定時の処理が、新しい中身で作り直す）。
-- p_changes：name・amount・recurrence・start_time・end_time・report_template_id のうち、変えるものだけ
create function public.change_contract_service(p_service_id uuid, p_effective date, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.contract_services; c public.contracts; n public.contract_services;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_eff date := coalesce(p_effective, (now() at time zone 'Asia/Tokyo')::date);
  v_name text; v_amount bigint; v_rec text; v_st time; v_et time; v_tpl uuid; v_new uuid := gen_random_uuid(); v_cancelled int;
begin
  select * into s from public.contract_services where id = p_service_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(s.tenant_id, 'contract.edit');
  if s.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  select * into c from public.contracts where tenant_id = s.tenant_id and id = s.contract_id for update;
  if c.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if c.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'contract_ended'); end if;
  if s.valid_to is not null then return jsonb_build_object('ok', false, 'reason', 'not_current'); end if;
  if jsonb_typeof(p_changes) is distinct from 'object' or p_changes = '{}'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_change');
  end if;
  if v_eff < v_today then return jsonb_build_object('ok', false, 'reason', 'effective_in_past'); end if;
  if v_eff <= s.valid_from then return jsonb_build_object('ok', false, 'reason', 'effective_not_after_start'); end if;
  if c.end_date is not null and v_eff > c.end_date then return jsonb_build_object('ok', false, 'reason', 'after_contract_end'); end if;

  v_name := s.name; v_amount := s.amount; v_rec := s.recurrence; v_st := s.start_time; v_et := s.end_time; v_tpl := s.report_template_id;
  if p_changes ? 'name' then
    v_name := nullif(btrim(p_changes ->> 'name'), '');
    if v_name is null then return jsonb_build_object('ok', false, 'reason', 'invalid_name'); end if;
  end if;
  if p_changes ? 'amount' then
    if (p_changes ->> 'amount') is null or (p_changes ->> 'amount') !~ '^[0-9]{1,11}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
    v_amount := (p_changes ->> 'amount')::bigint;
  end if;
  if p_changes ? 'recurrence' then
    v_rec := p_changes ->> 'recurrence';
    if v_rec is null or v_rec !~ '^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$' then return jsonb_build_object('ok', false, 'reason', 'invalid_recurrence'); end if;
  end if;
  begin
    if p_changes ? 'start_time' then v_st := (p_changes ->> 'start_time')::time; end if;
    if p_changes ? 'end_time' then v_et := (p_changes ->> 'end_time')::time; end if;
    if p_changes ? 'report_template_id' then v_tpl := (p_changes ->> 'report_template_id')::uuid; end if;
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'invalid_value');
  end;
  if v_st is not null and v_et is not null and v_et <= v_st then return jsonb_build_object('ok', false, 'reason', 'invalid_time'); end if;
  if (v_name, v_amount, v_rec, v_st, v_et, v_tpl) is not distinct from (s.name, s.amount, s.recurrence, s.start_time, s.end_time, s.report_template_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_change');
  end if;
  -- 請求書に載った月（適用日の月以降）の中身は直せない
  if app.service_invoiced(s.tenant_id, s.service_key, v_eff) then return jsonb_build_object('ok', false, 'reason', 'invoiced'); end if;

  update public.contract_services set valid_to = v_eff - 1 where id = s.id;
  insert into public.contract_services (id, tenant_id, contract_id, service_key, service_kind, name, amount, billing, recurrence, start_time, end_time, report_template_id, valid_from)
  values (v_new, s.tenant_id, s.contract_id, s.service_key, s.service_kind, v_name, v_amount, s.billing, v_rec, v_st, v_et, v_tpl, v_eff);
  insert into public.contract_service_staff (tenant_id, contract_service_id, membership_id)
  select st.tenant_id, v_new, st.membership_id from public.contract_service_staff st
  where st.tenant_id = s.tenant_id and st.contract_service_id = s.id and st.deleted_at is null;

  v_cancelled := app.cancel_future_works(s.tenant_id, s.service_key, v_eff);
  return jsonb_build_object('ok', true, 'id', v_new, 'cancelled', v_cancelled);
end $$;

-- 適用日以降の、まだ始まっていない予定（定時の処理が作ったもの）を取り消す。取り消した数を返す。
-- 始まった・終わった作業と、手で足した作業は取り消さない。作業の金額と担当も一緒に論理削除する。
create function app.cancel_future_works(p_tenant uuid, p_service_key uuid, p_from date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_n int;
begin
  select coalesce(array_agg(w.id), '{}') into v_ids from public.works w
  where w.tenant_id = p_tenant and w.service_key = p_service_key and w.run_id is not null
    and w.status = 'scheduled' and w.scheduled_date >= p_from and w.deleted_at is null;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then return 0; end if;
  update public.work_charges set deleted_at = now() where tenant_id = p_tenant and work_id = any (v_ids) and deleted_at is null;
  update public.work_assignments set deleted_at = now() where tenant_id = p_tenant and work_id = any (v_ids) and deleted_at is null;
  update public.works set status = 'cancelled', deleted_at = now() where tenant_id = p_tenant and id = any (v_ids);
  return v_n;
end $$;

-- 4. 契約を終える ---------------------------------------------------------------------
-- 終了日（省くと今日）で、契約を「終了」にし、開いている中身を閉じ、終了日より後の予定を取り消す
create function public.end_contract(p_id uuid, p_end_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.contracts; v_end date; s record; v_cancelled int := 0; v_manual int;
begin
  select * into c from public.contracts where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(c.tenant_id, 'contract.edit');
  if c.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if c.status = 'ended' then return jsonb_build_object('ok', true, 'already', true); end if;
  v_end := coalesce(p_end_date, (now() at time zone 'Asia/Tokyo')::date);
  if v_end < c.start_date then return jsonb_build_object('ok', false, 'reason', 'end_before_start'); end if;
  if c.end_date is not null and v_end > c.end_date then v_end := c.end_date; end if;
  -- 終了日の月より後の月が請求書に載っていれば、終えられない
  if exists (
    select 1 from public.contract_services x
    where x.tenant_id = c.tenant_id and x.contract_id = c.id and x.deleted_at is null
      and app.service_invoiced(c.tenant_id, x.service_key, (date_trunc('month', v_end) + interval '1 month')::date)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invoiced');
  end if;

  update public.contracts set status = 'ended', end_date = v_end where id = c.id;
  for s in select * from public.contract_services where tenant_id = c.tenant_id and contract_id = c.id and deleted_at is null and (valid_to is null or valid_to > v_end) loop
    if s.valid_from > v_end then
      -- 終了日より後から始まる中身は、始まらないので消す
      update public.contract_services set deleted_at = now() where id = s.id;
    else
      update public.contract_services set valid_to = v_end where id = s.id;
    end if;
    v_cancelled := v_cancelled + app.cancel_future_works(c.tenant_id, s.service_key, v_end + 1);
  end loop;
  -- 手で足した、終了日より後の予定も取り消す（status だけ。行は残す）
  update public.works w set status = 'cancelled'
  where w.tenant_id = c.tenant_id and w.run_id is null and w.status = 'scheduled' and w.scheduled_date > v_end and w.deleted_at is null
    and w.contract_service_id in (select id from public.contract_services where tenant_id = c.tenant_id and contract_id = c.id);
  get diagnostics v_manual = row_count;
  return jsonb_build_object('ok', true, 'end_date', v_end, 'cancelled', v_cancelled + v_manual);
end $$;

-- 5. 定時の処理（予定の作成。会社をまたぐので service_role だけ。Edge Function generate-works が会社ごとに呼ぶ）------------
-- 同じ会社の処理は同時に1つだけ動かす
create unique index job_runs_schedule_works_running_uq on public.job_runs (tenant_id, kind)
  where kind = 'schedule_works' and status = 'running' and deleted_at is null;

-- 対象の会社：今ある契約（終了していない）を持つ会社（止めた会社を除く）
create function public.schedule_tenants() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct c.tenant_id from public.contracts c
  join public.tenants t on t.id = c.tenant_id and t.status <> 'suspended' and t.deleted_at is null
  where c.deleted_at is null and c.status = 'active'
    and (c.end_date is null or c.end_date >= (now() at time zone 'Asia/Tokyo')::date)
$$;

-- 処理の記録を始める。同じ会社ですでに動いていれば null（30 分を過ぎた古い記録は失敗で閉じる）
create function public.schedule_start(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.job_runs set status = 'failure', ended_at = now(), error = 'timeout'
  where tenant_id = p_tenant and kind = 'schedule_works' and status = 'running' and deleted_at is null
    and started_at < now() - interval '30 minutes';
  begin
    insert into public.job_runs (tenant_id, kind) values (p_tenant, 'schedule_works') returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

create function public.schedule_finish(p_tenant uuid, p_run uuid, p_status text, p_counts jsonb, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_status not in ('success', 'failure') then
    raise exception '状況は success か failure：%', p_status using errcode = '22023';
  end if;
  update public.job_runs set status = p_status, ended_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 300)
  where id = p_run and tenant_id = p_tenant and kind = 'schedule_works' and status = 'running';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- 予定を作る元になる、今の清掃の中身（期間が p_from〜p_to にかかるもの）。起点・繰り返し・期間・決まった担当を返す
create function public.schedule_services(p_tenant uuid, p_from date, p_to date, p_contract uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'service_id', s.id, 'service_key', s.service_key, 'contract_id', c.id, 'name', s.name, 'recurrence', s.recurrence,
    'valid_from', s.valid_from, 'valid_to', s.valid_to, 'contract_start', c.start_date, 'contract_end', c.end_date,
    'staff', (select coalesce(jsonb_agg(st.membership_id order by st.membership_id), '[]'::jsonb)
              from public.contract_service_staff st
              where st.tenant_id = s.tenant_id and st.contract_service_id = s.id and st.deleted_at is null)
  ) order by s.id), '[]'::jsonb)
  from public.contract_services s
  join public.contracts c on c.tenant_id = s.tenant_id and c.id = s.contract_id
  where s.tenant_id = p_tenant and s.deleted_at is null and c.deleted_at is null and c.status = 'active'
    and s.valid_from <= p_to and (s.valid_to is null or s.valid_to >= p_from)
    and c.start_date <= p_to and (c.end_date is null or c.end_date >= p_from)
    and (p_contract is null or c.id = p_contract)
$$;

-- 作業を作る。p_works：[{service_id, date}]。書く行の tenant_id は引数の会社（中身・契約が別の会社なら作らない）。
-- 同じ中身・同じ日がすでにあれば作らない（二度動いても重ならない）。作った作業に、決まった担当と、
-- 行った回ごとの中身なら作業の金額を入れる。戻り：{created, skipped, assignments, charges}
create function public.schedule_insert(p_tenant uuid, p_run uuid, p_works jsonb) returns jsonb
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

-- 画面から「いま作り直す」を呼ぶとき、Edge Function が操作した人の鍵で呼んで、会社を確かめる（権限がなければ 42501）
create function public.contract_schedule_tenant(p_contract uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.contracts where id = p_contract and deleted_at is null;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'contract.edit');
  return v_tenant;
end $$;

-- 6. 実行の権限 ---------------------------------------------------------------------
select app.lock_functions();
revoke execute on function app.cancel_future_works(uuid, uuid, date) from public, anon, authenticated, service_role;
revoke execute on function public.schedule_tenants() from public, anon, authenticated;
revoke execute on function public.schedule_start(uuid) from public, anon, authenticated;
revoke execute on function public.schedule_finish(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.schedule_services(uuid, date, date, uuid) from public, anon, authenticated;
revoke execute on function public.schedule_insert(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.schedule_tenants() to service_role;
grant execute on function public.schedule_start(uuid) to service_role;
grant execute on function public.schedule_finish(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.schedule_services(uuid, date, date, uuid) to service_role;
grant execute on function public.schedule_insert(uuid, uuid, jsonb) to service_role;
grant execute on function
  public.create_contract_from_quote(uuid, date, date), public.create_contract_import(uuid, uuid, text, date, date, jsonb),
  public.change_contract_service(uuid, date, jsonb), public.end_contract(uuid, date), public.contract_schedule_tenant(uuid)
to authenticated;
