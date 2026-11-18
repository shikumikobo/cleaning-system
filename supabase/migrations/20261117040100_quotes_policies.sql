-- 機能 004：policy の型（B＋D）と、提出したあとの固定。
-- 提出・承認・不成立のあとは、状況が下書きでなくなるので、RLS の条件（lock_sql）で直せなくなる。

-- 見積が下書きか（明細の policy が使う。消した下書きの明細も、下書きの間は直せる形のまま）
create function app.quote_is_draft(p_tenant uuid, p_quote uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.quotes q where q.tenant_id = p_tenant and q.id = p_quote and q.status = 'draft')
$$;

-- 外部の人に見せてよい見積か（提出・承認で、消しておらず、許された建物）
create function app.quote_external_visible(p_tenant uuid, p_quote uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.quotes q
    where q.tenant_id = p_tenant and q.id = p_quote and q.status in ('submitted', 'approved') and q.deleted_at is null
      and app.can_external_see_building(q.tenant_id, q.building_id)
  )
$$;

select app.lock_functions();
grant execute on function app.quote_is_draft(uuid, uuid), app.quote_external_visible(uuid, uuid) to authenticated, service_role;

-- 品名の候補：金額の型 B。書けるのは quote.edit。消すのは論理削除（deleted_at を直す）
select app.apply_policy('public.items', 'B', '{"write_perm": "quote.edit"}');

-- 見積：読めるのは amount.read と、外部の人（許された建物の提出・承認のもの）。直せるのは下書きだけ
select app.apply_policy('public.quotes', 'B', jsonb_build_object(
  'write_perm', 'quote.edit',
  'lock_sql', 'status = ''draft''',
  'external_read', 'status in (''submitted'', ''approved'') and deleted_at is null and app.can_external_see_building(tenant_id, building_id)'));

-- 明細：見積が下書きの間だけ直せる
select app.apply_policy('public.quote_lines', 'B', jsonb_build_object(
  'write_perm', 'quote.edit',
  'lock_sql', 'app.quote_is_draft(tenant_id, quote_id)',
  'external_read', 'app.quote_external_visible(tenant_id, quote_id)'));

-- 作るのは、下書きで、番号・合計・決めた人のない行だけ（これらは RPC だけが入れる。元の版つきも直す RPC だけ）
drop policy tp_insert on public.quotes;
create policy tp_insert on public.quotes for insert to authenticated
  with check (
    public.has_perm(tenant_id, 'quote.edit')
    and status = 'draft' and number is null and issue_date is null
    and subtotal = 0 and tax = 0 and total = 0
    and previous_id is null and submitted_at is null
    and decided_at is null and decided_by is null and decision_note is null
    and deleted_at is null
  );

-- 明細は、見積が下書きのときだけ足せる
drop policy tp_insert on public.quote_lines;
create policy tp_insert on public.quote_lines for insert to authenticated
  with check (public.has_perm(tenant_id, 'quote.edit') and app.quote_is_draft(tenant_id, quote_id));

-- 直接書ける列を絞る（状況・番号・発行日・合計・税・決めた人と日・元の版は、RPC だけが決める）
revoke update on public.quotes from authenticated;
grant update (tenant_id, client_id, building_id, request_id, kind, valid_until, tax_rate, note, deleted_at) on public.quotes to authenticated;
-- 明細の付け替え（quote_id）と、金額（amount は計算で出る列）は書けない
revoke update on public.quote_lines from authenticated;
grant update (tenant_id, item_id, line_kind, name, qty, unit, unit_price, recurrence, sort, deleted_at) on public.quote_lines to authenticated;
