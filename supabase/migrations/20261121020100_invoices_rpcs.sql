-- 機能 011：請求の RPC（下書きを作る・発行・送付・取消・下書きを消す・入金）。
-- RPC は security definer で RLS を通らない。中で必ず権限（invoice.edit）と、行の会社・状況を確かめる。
-- 行が見つからない・権限がないは、同じ 42501 で返す（ほかの会社の行の存在を探らせない）。
-- 業務の決まりで断るときは、例外ではなく {ok:false, reason} を返す（画面が日本語で理由を出せる）。

-- 番号：I-<西暦>-<4桁>
create function app.invoice_number(p_year int, p_no int) returns text language sql immutable set search_path = '' as $$
  select 'I-' || p_year::text || '-' || lpad(p_no::text, 4, '0')
$$;

-- 請求する元（まだ明細に載っていないもの）を、取引先ごとに並べる。下書きを作る RPC だけが使う
--  1. 契約の中身（毎月請求）：その月の1日に有効な中身（月の途中から始まるなら、その月で最初に始まる中身）。日割りしない
--  2. 契約の作業の金額：状況が完了で、予定の日がその月
--  3. 案件の金額：完了・請求する。案件を作った日（日本時間）が、その月の末日以前
create function app.invoice_candidates(p_tenant uuid, p_period date, p_client uuid)
returns table (client_id uuid, service_key uuid, service_month date, work_id uuid, request_id uuid, name text, unit text, unit_price bigint, ord int, sort_name text)
language sql stable security definer set search_path = '' as $$
  select c.client_id, s.service_key, p_period, null::uuid, null::uuid,
         concat_ws(' ', b.name, s.name), '月'::text, s.amount, 1, s.name
  from (
    select distinct on (x.service_key) x.*
    from public.contract_services x
    where x.tenant_id = p_tenant and x.deleted_at is null and x.billing = 'monthly'
      and x.valid_from < (p_period + interval '1 month')::date
      and (x.valid_to is null or x.valid_to >= p_period)
    order by x.service_key, (x.valid_from > p_period),
             case when x.valid_from <= p_period then p_period - x.valid_from else x.valid_from - p_period end
  ) s
  join public.contracts c on c.tenant_id = s.tenant_id and c.id = s.contract_id and c.deleted_at is null
  join public.buildings b on b.tenant_id = c.tenant_id and b.id = c.building_id
  where c.start_date < (p_period + interval '1 month')::date and (c.end_date is null or c.end_date >= p_period)
    and s.amount > 0 and (p_client is null or c.client_id = p_client)
    and not exists (select 1 from public.invoice_lines l where l.tenant_id = p_tenant and l.service_key = s.service_key and l.service_month = p_period and l.deleted_at is null)
  union all
  select c.client_id, null::uuid, null::date, w.id, null::uuid,
         concat_ws(' ', b.name, w.title) || '（' || to_char(w.scheduled_date, 'FMMM/FMDD') || '）', '回'::text, wc.amount, 2, w.title
  from public.work_charges wc
  join public.works w on w.tenant_id = wc.tenant_id and w.id = wc.work_id
  join public.contract_services s on s.tenant_id = w.tenant_id and s.id = w.contract_service_id
  join public.contracts c on c.tenant_id = s.tenant_id and c.id = s.contract_id and c.deleted_at is null
  join public.buildings b on b.tenant_id = w.tenant_id and b.id = w.building_id
  where wc.tenant_id = p_tenant and wc.deleted_at is null and w.deleted_at is null and w.status = 'done'
    and w.scheduled_date >= p_period and w.scheduled_date < (p_period + interval '1 month')::date
    and wc.amount > 0 and (p_client is null or c.client_id = p_client)
    and not exists (select 1 from public.invoice_lines l where l.tenant_id = p_tenant and l.work_id = w.id and l.deleted_at is null)
  union all
  select r.client_id, null::uuid, null::date, null::uuid, r.id,
         concat_ws(' ', b.name, r.title), '式'::text, rc.amount::bigint, 3, r.title
  from public.request_charges rc
  join public.requests r on r.tenant_id = rc.tenant_id and r.id = rc.request_id
  join public.buildings b on b.tenant_id = r.tenant_id and b.id = r.building_id
  where rc.tenant_id = p_tenant and rc.deleted_at is null and r.deleted_at is null and r.status = 'done'
    and rc.billable and rc.amount > 0 and (p_client is null or r.client_id = p_client)
    and (r.created_at at time zone 'Asia/Tokyo')::date < (p_period + interval '1 month')::date
    and not exists (select 1 from public.invoice_lines l where l.tenant_id = p_tenant and l.request_id = r.id and l.deleted_at is null)
$$;

-- 入金の合計から、請求書の状況（発行・送付・一部入金・入金済み）を決め直す。入金の RPC の中だけで呼ぶ
create function app.invoice_recalc(p_invoice uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare q public.invoices; v_paid bigint; v_status text;
begin
  select * into q from public.invoices where id = p_invoice;
  select coalesce(sum(p.amount), 0) into v_paid from public.payments p where p.tenant_id = q.tenant_id and p.invoice_id = q.id and p.deleted_at is null;
  v_status := case
    when v_paid > 0 and v_paid >= q.total then 'paid'
    when v_paid > 0 then 'partial'
    when q.sent_at is not null then 'sent'
    else 'issued' end;
  if v_status <> q.status then update public.invoices set status = v_status where id = q.id; end if;
  return v_status;
end $$;

-- 下書きを作る：月（その月の1日に直す）と取引先（空なら全部）。同じ月を二度呼んでも明細は増えない
create function public.create_invoice_drafts(p_tenant uuid, p_period date, p_client_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_period date; c record; inv public.invoices; v_prev uuid; v_base int; v_n int;
  v_created int := 0; v_added int := 0; v_locked int := 0; v_ids uuid[] := '{}';
begin
  if p_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(p_tenant, 'invoice.edit');
  if p_client_id is not null and not exists (select 1 from public.clients where id = p_client_id and tenant_id = p_tenant and deleted_at is null) then
    raise exception '権限がない' using errcode = '42501';
  end if;
  perform app.mark_rpc();
  if p_period is null then return jsonb_build_object('ok', false, 'reason', 'period_required'); end if;
  v_period := date_trunc('month', p_period)::date;

  for c in select distinct x.client_id from app.invoice_candidates(p_tenant, v_period, p_client_id) x order by 1 loop
    select * into inv from public.invoices
    where tenant_id = p_tenant and client_id = c.client_id and period = v_period and deleted_at is null and status <> 'cancelled' for update;
    if found then
      -- すでに発行した請求書には足さない（取り消して出し直す）
      if inv.status <> 'draft' then v_locked := v_locked + 1; continue; end if;
    else
      select i.id into v_prev from public.invoices i
      where i.tenant_id = p_tenant and i.client_id = c.client_id and i.period = v_period and i.status = 'cancelled' and i.deleted_at is null
        and not exists (select 1 from public.invoices r where r.tenant_id = i.tenant_id and r.previous_id = i.id and r.deleted_at is null)
      order by i.created_at desc, i.id limit 1;
      insert into public.invoices (tenant_id, client_id, period, previous_id) values (p_tenant, c.client_id, v_period, v_prev) returning * into inv;
      v_created := v_created + 1;
    end if;
    select coalesce(max(l.sort), 0) into v_base from public.invoice_lines l where l.tenant_id = p_tenant and l.invoice_id = inv.id;
    with ins as (
      insert into public.invoice_lines (tenant_id, invoice_id, service_key, service_month, work_id, request_id, name, qty, unit, unit_price, sort)
      select p_tenant, inv.id, x.service_key, x.service_month, x.work_id, x.request_id, x.name, 1, x.unit, x.unit_price,
             v_base + (row_number() over (order by x.ord, x.sort_name, x.name))::int
      from app.invoice_candidates(p_tenant, v_period, p_client_id) x where x.client_id = c.client_id
      on conflict do nothing
      returning 1)
    select count(*)::int into v_n from ins;
    v_added := v_added + v_n;
    v_ids := v_ids || inv.id;
  end loop;
  return jsonb_build_object('ok', true, 'period', v_period, 'created', v_created, 'added', v_added, 'locked', v_locked, 'ids', to_jsonb(v_ids));
end $$;

-- 発行：合計・税・番号・発行日・期日を決め、状況を「発行」にする（下書きだけ）
create function public.issue_invoice(p_id uuid, p_issue_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  q public.invoices; v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_issue date; v_due date; v_sub bigint; v_n int; v_tax bigint; v_no int; v_number text;
begin
  select * into q from public.invoices where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'invoice.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status in ('issued', 'sent', 'partial', 'paid') then
    return jsonb_build_object('ok', true, 'already', true, 'number', q.number, 'subtotal', q.subtotal, 'tax', q.tax, 'total', q.total);
  elsif q.status <> 'draft' then
    return jsonb_build_object('ok', false, 'reason', 'not_draft');
  end if;

  select coalesce(sum(l.amount), 0), count(*) into v_sub, v_n
  from public.invoice_lines l where l.tenant_id = q.tenant_id and l.invoice_id = q.id and l.deleted_at is null;
  if v_n = 0 then return jsonb_build_object('ok', false, 'reason', 'no_lines'); end if;
  v_tax := floor(v_sub * q.tax_rate)::bigint; -- 税は請求書1枚に1回、円未満は切り捨て
  if v_sub + v_tax = 0 then return jsonb_build_object('ok', false, 'reason', 'zero_total'); end if;
  v_issue := coalesce(p_issue_date, v_today);
  v_due := q.due_date;
  if v_due is null then
    v_due := (date_trunc('month', q.period) + interval '2 month' - interval '1 day')::date; -- 請求月の翌月末
    if v_due < v_issue then v_due := v_issue + 30; end if;
  elsif v_due < v_issue then
    return jsonb_build_object('ok', false, 'reason', 'due_before_issue');
  end if;

  v_no := app.next_doc_no(q.tenant_id, 'invoice', extract(year from v_issue)::int);
  v_number := app.invoice_number(extract(year from v_issue)::int, v_no);
  update public.invoices set
    status = 'issued', number = v_number, issue_date = v_issue, due_date = v_due,
    subtotal = v_sub, tax = v_tax, total = v_sub + v_tax, issued_at = now()
  where id = q.id;
  return jsonb_build_object('ok', true, 'number', v_number, 'subtotal', v_sub, 'tax', v_tax, 'total', v_sub + v_tax, 'due_date', v_due);
end $$;

-- 送付を記録する（送るのは人。システムはメールを送らない）
create function public.mark_invoice_sent(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.invoices;
begin
  select * into q from public.invoices where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'invoice.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status = 'sent' then return jsonb_build_object('ok', true, 'already', true); end if;
  if q.status in ('draft', 'cancelled') then return jsonb_build_object('ok', false, 'reason', 'not_issued'); end if;
  if q.status in ('partial', 'paid') then return jsonb_build_object('ok', false, 'reason', 'has_payments'); end if;
  update public.invoices set status = 'sent', sent_at = now() where id = q.id;
  return jsonb_build_object('ok', true);
end $$;

-- 取消：発行・送付の請求書を取消にし、明細を消す（元が空くので、同じ月に出し直せる）
create function public.cancel_invoice(p_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.invoices;
begin
  select * into q from public.invoices where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'invoice.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status = 'cancelled' then return jsonb_build_object('ok', true, 'already', true); end if;
  if q.status = 'draft' then return jsonb_build_object('ok', false, 'reason', 'draft'); end if;
  if q.status in ('partial', 'paid') then return jsonb_build_object('ok', false, 'reason', 'has_payments'); end if;
  update public.invoices set status = 'cancelled', cancelled_at = now(), cancel_reason = nullif(btrim(p_reason), '') where id = q.id;
  update public.invoice_lines set deleted_at = now() where tenant_id = q.tenant_id and invoice_id = q.id and deleted_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- 下書きを消す（明細も一緒に。元は次の下書きに入れ直せる）
create function public.delete_invoice(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.invoices;
begin
  select * into q from public.invoices where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'invoice.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status <> 'draft' then return jsonb_build_object('ok', false, 'reason', 'not_draft'); end if;
  update public.invoice_lines set deleted_at = now() where tenant_id = q.tenant_id and invoice_id = q.id and deleted_at is null;
  update public.invoices set deleted_at = now() where id = q.id;
  return jsonb_build_object('ok', true);
end $$;

-- 入金を記録する（請求書の状況も同じ処理で変える）
create function public.record_payment(p_invoice_id uuid, p_paid_on date, p_amount bigint, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.invoices; v_paid bigint; v_id uuid := gen_random_uuid(); v_status text;
begin
  select * into q from public.invoices where id = p_invoice_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'invoice.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status = 'draft' then return jsonb_build_object('ok', false, 'reason', 'not_issued'); end if;
  if q.status = 'cancelled' then return jsonb_build_object('ok', false, 'reason', 'cancelled'); end if;
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
  if p_paid_on is null then return jsonb_build_object('ok', false, 'reason', 'paid_on_required'); end if;
  select coalesce(sum(p.amount), 0) into v_paid from public.payments p where p.tenant_id = q.tenant_id and p.invoice_id = q.id and p.deleted_at is null;
  if v_paid + p_amount > q.total then return jsonb_build_object('ok', false, 'reason', 'overpaid'); end if;
  insert into public.payments (id, tenant_id, invoice_id, paid_on, amount, note) values (v_id, q.tenant_id, q.id, p_paid_on, p_amount, nullif(btrim(p_note), ''));
  v_status := app.invoice_recalc(q.id);
  return jsonb_build_object('ok', true, 'id', v_id, 'status', v_status, 'paid', v_paid + p_amount, 'balance', q.total - v_paid - p_amount);
end $$;

-- 入金を直す
create function public.update_payment(p_id uuid, p_paid_on date, p_amount bigint, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pay public.payments; q public.invoices; v_paid bigint; v_status text;
begin
  select * into pay from public.payments where id = p_id;
  if not found or pay.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  select * into q from public.invoices where id = pay.invoice_id for update;
  perform app.require_perm(q.tenant_id, 'invoice.edit');
  perform app.mark_rpc();
  select * into pay from public.payments where id = p_id for update;
  if pay.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  if q.status = 'cancelled' then return jsonb_build_object('ok', false, 'reason', 'cancelled'); end if;
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
  if p_paid_on is null then return jsonb_build_object('ok', false, 'reason', 'paid_on_required'); end if;
  select coalesce(sum(p.amount), 0) into v_paid from public.payments p where p.tenant_id = q.tenant_id and p.invoice_id = q.id and p.deleted_at is null and p.id <> pay.id;
  if v_paid + p_amount > q.total then return jsonb_build_object('ok', false, 'reason', 'overpaid'); end if;
  update public.payments set paid_on = p_paid_on, amount = p_amount, note = nullif(btrim(p_note), '') where id = pay.id;
  v_status := app.invoice_recalc(q.id);
  return jsonb_build_object('ok', true, 'status', v_status, 'paid', v_paid + p_amount, 'balance', q.total - v_paid - p_amount);
end $$;

-- 入金を消す（論理削除）
create function public.delete_payment(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pay public.payments; q public.invoices; v_paid bigint; v_status text;
begin
  select * into pay from public.payments where id = p_id;
  if not found or pay.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  select * into q from public.invoices where id = pay.invoice_id for update;
  perform app.require_perm(q.tenant_id, 'invoice.edit');
  perform app.mark_rpc();
  select * into pay from public.payments where id = p_id for update;
  if pay.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  if q.status = 'cancelled' then return jsonb_build_object('ok', false, 'reason', 'cancelled'); end if;
  update public.payments set deleted_at = now() where id = pay.id;
  v_status := app.invoice_recalc(q.id);
  select coalesce(sum(p.amount), 0) into v_paid from public.payments p where p.tenant_id = q.tenant_id and p.invoice_id = q.id and p.deleted_at is null;
  return jsonb_build_object('ok', true, 'status', v_status, 'paid', v_paid, 'balance', q.total - v_paid);
end $$;

-- 実行の権限：中の関数は誰にも渡さず、RPC は authenticated だけ
select app.lock_functions();
revoke execute on function app.invoice_number(int, int) from public, anon, authenticated, service_role;
revoke execute on function app.invoice_candidates(uuid, date, uuid) from public, anon, authenticated, service_role;
revoke execute on function app.invoice_recalc(uuid) from public, anon, authenticated, service_role;
grant execute on function
  public.create_invoice_drafts(uuid, date, uuid), public.issue_invoice(uuid, date), public.mark_invoice_sent(uuid),
  public.cancel_invoice(uuid, text), public.delete_invoice(uuid),
  public.record_payment(uuid, date, bigint, text), public.update_payment(uuid, date, bigint, text), public.delete_payment(uuid)
to authenticated;

-- 使われているものは消さない：002 の app.usage_refs に、取引先の `invoices`（has_invoices）がすでにある。ここでは足さない。
-- お知らせの種類 invoice_overdue は 015 が初めから登録している（波 6 の処理が使う）。ここでは足さない。
