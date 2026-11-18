-- 機能 004：見積の RPC（提出・承認・不成立・直す）と、使われ方の登録。
-- RPC は security definer で RLS を通らない。中で必ず権限（quote.edit）と、行の会社・状況を確かめる。
-- 行が見つからない・権限がないは、同じ 42501 で返す（ほかの会社の行の存在を探らせない）。
-- 業務の決まりで断るときは、例外ではなく {ok:false, reason} を返す（画面が日本語で理由を出せる）。

-- 番号：Q-<西暦>-<4桁>
create function app.quote_number(p_year int, p_no int) returns text language sql immutable set search_path = '' as $$
  select 'Q-' || p_year::text || '-' || lpad(p_no::text, 4, '0')
$$;

-- 提出：合計・税・番号・発行日を決め、状況を「提出」にする（下書きだけ）
create function public.submit_quote(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_year int := extract(year from (now() at time zone 'Asia/Tokyo'))::int;
  v_sub bigint; v_n int; v_base int; v_rec_missing int; v_rec_any int; v_tax bigint; v_no int; v_number text;
  v_valid date;
begin
  select * into q from public.quotes where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'quote.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status = 'submitted' then
    return jsonb_build_object('ok', true, 'already', true, 'number', q.number, 'subtotal', q.subtotal, 'tax', q.tax, 'total', q.total);
  elsif q.status <> 'draft' then
    return jsonb_build_object('ok', false, 'reason', 'not_draft');
  end if;

  select coalesce(sum(l.amount), 0), count(*),
         count(*) filter (where l.line_kind = 'base'),
         count(*) filter (where l.line_kind in ('base', 'option') and l.recurrence is null),
         count(*) filter (where l.recurrence is not null)
    into v_sub, v_n, v_base, v_rec_missing, v_rec_any
  from public.quote_lines l where l.tenant_id = q.tenant_id and l.quote_id = q.id and l.deleted_at is null;

  if v_n = 0 then return jsonb_build_object('ok', false, 'reason', 'no_lines'); end if;
  v_valid := coalesce(q.valid_until, v_today + 30);
  if v_valid < v_today then return jsonb_build_object('ok', false, 'reason', 'valid_until_before_issue'); end if;
  if q.kind = 'recurring' then
    if v_base = 0 then return jsonb_build_object('ok', false, 'reason', 'recurring_needs_base'); end if;
    if v_rec_missing > 0 then return jsonb_build_object('ok', false, 'reason', 'recurrence_missing'); end if;
  elsif v_rec_any > 0 then
    return jsonb_build_object('ok', false, 'reason', 'recurrence_not_allowed');
  end if;

  v_tax := floor(v_sub * q.tax_rate)::bigint; -- 税は帳票ごとに1回、円未満は切り捨て
  v_no := app.next_doc_no(q.tenant_id, 'quote', v_year);
  v_number := app.quote_number(v_year, v_no);
  update public.quotes set
    status = 'submitted', number = v_number, issue_date = v_today, valid_until = v_valid,
    subtotal = v_sub, tax = v_tax, total = v_sub + v_tax, submitted_at = now()
  where id = q.id;

  -- 直した版を提出したとき、元の版が「提出」のままなら不成立にする（有効な見積を1つにする）
  if q.previous_id is not null then
    update public.quotes set status = 'rejected', decided_at = now(), decided_by = (select auth.uid()), decision_note = '改訂版に置き換え'
    where id = q.previous_id and tenant_id = q.tenant_id and status = 'submitted';
  end if;
  return jsonb_build_object('ok', true, 'number', v_number, 'subtotal', v_sub, 'tax', v_tax, 'total', v_sub + v_tax);
end $$;

-- 承認：提出した見積を承認にし、金額を見られる所属（本人を除く）にお知らせを作る
create function public.approve_quote(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes; v_client text; v_building text; v_notified int := 0; m record;
begin
  select * into q from public.quotes where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'quote.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status = 'approved' then return jsonb_build_object('ok', true, 'already', true); end if;
  if q.status <> 'submitted' then return jsonb_build_object('ok', false, 'reason', 'not_submitted'); end if;

  update public.quotes set status = 'approved', decided_at = now(), decided_by = (select auth.uid()) where id = q.id;

  select name into v_client from public.clients where tenant_id = q.tenant_id and id = q.client_id;
  select name into v_building from public.buildings where tenant_id = q.tenant_id and id = q.building_id;
  for m in
    select ms.id from public.memberships ms
    join public.roles r on r.id = ms.role_id and r.code <> 'external'
    where ms.tenant_id = q.tenant_id and ms.status = 'active' and ms.deleted_at is null
      and ms.user_id is distinct from (select auth.uid())
    order by ms.id
  loop
    -- 受け取れない所属（金額を見る権限がない）には、何も作らず 0 が返る
    v_notified := v_notified + app.enqueue_notification(
      q.tenant_id, m.id, 'quote_approved', '見積が承認されました：' || q.number,
      coalesce(v_client, '') || ' / ' || coalesce(v_building, '') || ' / 合計 ' || q.total::text || '円',
      '/quotes/edit/?id=' || q.id::text, 'quote_approved:' || q.id::text);
  end loop;
  return jsonb_build_object('ok', true, 'notified', v_notified);
end $$;

-- 不成立：提出した見積を不成立にする（理由は任意）
create function public.reject_quote(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.quotes;
begin
  select * into q from public.quotes where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'quote.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status = 'rejected' then return jsonb_build_object('ok', true, 'already', true); end if;
  if q.status <> 'submitted' then return jsonb_build_object('ok', false, 'reason', 'not_submitted'); end if;
  update public.quotes set status = 'rejected', decided_at = now(), decided_by = (select auth.uid()), decision_note = nullif(btrim(p_note), '')
  where id = q.id;
  return jsonb_build_object('ok', true);
end $$;

-- 直す：提出済み・不成立の見積から、元の版を previous_id に入れた新しい下書きを作る（明細も写す）
create function public.revise_quote(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_existing public.quotes; v_new uuid := gen_random_uuid();
begin
  select * into q from public.quotes where id = p_id for update;
  if not found then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(q.tenant_id, 'quote.edit');
  if q.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.mark_rpc();
  if q.status not in ('submitted', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'not_revisable'); end if;
  select * into v_existing from public.quotes where tenant_id = q.tenant_id and previous_id = q.id and deleted_at is null;
  if found then
    if v_existing.status = 'draft' then return jsonb_build_object('ok', true, 'already', true, 'id', v_existing.id); end if;
    return jsonb_build_object('ok', false, 'reason', 'already_revised', 'id', v_existing.id);
  end if;

  insert into public.quotes (id, tenant_id, client_id, building_id, request_id, kind, tax_rate, note, previous_id)
  values (v_new, q.tenant_id, q.client_id, q.building_id, q.request_id, q.kind, q.tax_rate, q.note, q.id);
  insert into public.quote_lines (tenant_id, quote_id, item_id, line_kind, name, qty, unit, unit_price, recurrence, sort)
  select l.tenant_id, v_new, l.item_id, l.line_kind, l.name, l.qty, l.unit, l.unit_price, l.recurrence, l.sort
  from public.quote_lines l where l.tenant_id = q.tenant_id and l.quote_id = q.id and l.deleted_at is null
  order by l.sort, l.created_at;
  return jsonb_build_object('ok', true, 'id', v_new);
end $$;

select app.lock_functions();
revoke execute on function app.quote_number(int, int) from public, anon, authenticated, service_role;
grant execute on function public.submit_quote(uuid), public.approve_quote(uuid), public.reject_quote(uuid, text), public.revise_quote(uuid) to authenticated;

-- 使われているものは消さない（002 の app.usage_refs に登録する）：見積がある取引先・建物は消さない
insert into app.usage_refs (parent, action, child_table, where_sql, reason) values
  ('client', 'block', 'quotes', 'client_id = $2', 'has_quotes'),
  ('building', 'block', 'quotes', 'building_id = $2', 'has_quotes');
