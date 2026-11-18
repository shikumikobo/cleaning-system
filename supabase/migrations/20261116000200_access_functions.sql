-- 権限の判定と、policy の型を表に付ける関数。
-- 判定は has_perm(tenant_id, perm) に集める。policy に役割の名前を直接書かない。

-- 運営の印：JWT の app_metadata.operator（利用者が自分では書き換えられない領域）
create function app.is_operator() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'operator', '') = 'true'
$$;

-- 権限：自分が有効な所属を持つ会社で、その権限を持つか（止めた人・外部の人は false）
create function public.has_perm(p_tenant uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id = m.role_id
    join public.permissions p on p.id = rp.permission_id
    where m.user_id = (select auth.uid())
      and m.tenant_id = p_tenant
      and m.status = 'active' and m.deleted_at is null
      and p.code = p_perm
  )
$$;

-- 会社の中の人（外部を除く）
create function app.is_internal(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.user_id = (select auth.uid()) and m.tenant_id = p_tenant
      and m.status = 'active' and m.deleted_at is null and r.code <> 'external'
  )
$$;

-- 外部の人
create function app.is_external(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.user_id = (select auth.uid()) and m.tenant_id = p_tenant
      and m.status = 'active' and m.deleted_at is null and r.code = 'external'
  )
$$;

-- 運営が、許された期間の間だけ見られる（読むだけ）
create function app.is_support_viewer(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_operator() and exists (
    select 1 from public.support_access_grants g
    where g.tenant_id = p_tenant and g.deleted_at is null and g.revoked_at is null
      and g.starts_at <= now() and now() < g.ends_at
  )
$$;

-- 自分が有効な所属を持つ会社
create function app.my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.memberships m
  where m.user_id = (select auth.uid()) and m.status = 'active' and m.deleted_at is null
$$;

-- その所属が自分のものか（型 C1 の持ち主の判定）
create function app.is_owner_membership(p_tenant uuid, p_membership uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.id = p_membership and m.tenant_id = p_tenant
      and m.user_id = (select auth.uid()) and m.status = 'active' and m.deleted_at is null
  )
$$;

-- 自分の所属の id か（外部の建物の表の「自分の行」）
create function app.is_my_membership(p_tenant uuid, p_membership uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_owner_membership(p_tenant, p_membership)
$$;

-- 外部の人が、その建物を見てよいか（型 D で使う）
create function app.can_external_see_building(p_tenant uuid, p_building uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.external_building_access a
    join public.memberships m on m.tenant_id = a.tenant_id and m.id = a.membership_id
    where a.tenant_id = p_tenant and a.building_id = p_building and a.deleted_at is null
      and m.user_id = (select auth.uid()) and m.status = 'active' and m.deleted_at is null
  )
$$;

-- ファイルの置き場所：パスの最初のフォルダが会社の id か
create function app.storage_tenant(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and position('/' in p_name) > 0
              then split_part(p_name, '/', 1)::uuid end
$$;

-- 表の storage_path の check 制約に使う：<tenant_id>/ で始まる
create function app.storage_path_ok(p_tenant uuid, p_path text) returns boolean
language sql immutable set search_path = '' as $$
  select p_path is not null and left(p_path, 37) = p_tenant::text || '/' and length(p_path) > 37
$$;

-- 2. 触る・履歴・会社の固定のトリガー ----------------------------------------

-- 更新の時刻と、直した人
create function app.touch_row() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- 行の会社は変えられない（2つの会社に入っている人が、行を別の会社へ移せないように）
create function app.forbid_tenant_change() returns trigger language plpgsql set search_path = '' as $$
begin
  if to_jsonb(new) -> 'tenant_id' is distinct from to_jsonb(old) -> 'tenant_id' then
    raise exception 'tenant_id は変えられない' using errcode = '42501';
  end if;
  return new;
end $$;

-- 変更の履歴：だれが・いつ・どこから・何を（変わった列の前と後）
create function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_new jsonb; v_base jsonb; v_changed jsonb := '{}'::jsonb;
  v_tenant uuid; v_row uuid; k text; v_req uuid; v_src text; v_claims jsonb;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_base := coalesce(v_new, v_old);

  for k in select jsonb_object_keys(v_base) loop
    continue when k in ('updated_at', 'updated_by');
    if tg_op = 'UPDATE' and (v_old -> k) is not distinct from (v_new -> k) then continue; end if;
    v_changed := v_changed || jsonb_build_object(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k));
  end loop;
  if tg_op = 'UPDATE' and v_changed = '{}'::jsonb then return null; end if;

  v_tenant := case when tg_table_name = 'tenants' then (v_base ->> 'id')::uuid else (v_base ->> 'tenant_id')::uuid end;
  v_row := (v_base ->> 'id')::uuid;

  -- 1つの操作（トランザクション）で変わった行は、同じ request_id でまとまる
  v_req := nullif(current_setting('app.request_id', true), '')::uuid;
  if v_req is null then
    v_req := gen_random_uuid();
    perform set_config('app.request_id', v_req::text, true);
  end if;

  v_src := nullif(current_setting('app.source', true), '');
  if v_src is null then
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_src := case when v_claims ->> 'role' = 'service_role' then 'job' else 'ui' end;
  end if;

  insert into public.audit_logs (tenant_id, table_name, row_id, action, changed, actor, source, request_id)
  values (v_tenant, tg_table_name, v_row, lower(tg_op), v_changed, auth.uid(), v_src, v_req);
  return null;
end $$;

-- 履歴は、だれも直せず・消せない
create function app.audit_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '変更の履歴は直せず、消せない' using errcode = '42501';
end $$;

-- 3. policy の型を表に付ける --------------------------------------------------
-- 型：A 業務・B 金額・C1 現場の記録（本人）・C2 現場の記録（作業の担当）・E 管理（＋D 外部に見せる）
-- 表ごとに手で policy を書かない。後の機能は、表を作ったらこの関数を1回呼ぶ。
--
-- 選べる項目（p_opts）
--   tenant_col     会社の列。既定 tenant_id（tenants は id）
--   write_perm     書ける権限（A・B は必須。C1・C2 は任意で、全員分を書ける権限）
--   lock_sql       update できる行の条件（例 status = 'draft'）。直したあとの行にも同じ条件を求める
--   read_scope     （A）スタッフなどに見せる行の条件。read_bypass の権限を持つ人は全部見える
--   read_bypass    （A）read_scope を飛ばす権限。既定 work.assign
--   owner_col      （C1）持ち主の所属を指す列。既定 membership_id
--   supervise_perm （C1・C2）全員分を読める権限。既定 work.assign
--   scope_fn       （C2）関数名。(tenant_id, scope_col の値) が、自分がその作業の担当なら true
--   scope_col      （C2）既定 work_id
--   insert_only    （C1）true なら update をさせない（端末が書き足すだけ）
--   read_perm      （E）読める権限。既定 user.manage。'none' なら管理者も読めない
--   own_row_sql    （E）自分の行の条件
--   external_read  （D）外部の人が読める行の条件（例 app.can_external_see_building(tenant_id, building_id)）
--   audit          変更の履歴を付けるか。A・B・E は既定 true、C は付けない
create function app.apply_policy(p_table regclass, p_type text, p_opts jsonb default '{}'::jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  v_name text := (select relname from pg_class where oid = p_table);
  v_tc text := coalesce(p_opts ->> 'tenant_col', 'tenant_id');
  v_write text := p_opts ->> 'write_perm';
  v_lock text := nullif(p_opts ->> 'lock_sql', '');
  v_sup text := coalesce(p_opts ->> 'supervise_perm', 'work.assign');
  v_owner text := coalesce(p_opts ->> 'owner_col', 'membership_id');
  v_scope_col text := coalesce(p_opts ->> 'scope_col', 'work_id');
  v_read text; v_ins text; v_upd text; v_ext text;
  v_audit boolean;
  v_pol text;
  v_tcol text := quote_ident(v_tc);
  v_lock_and text := case when v_lock is null then '' else ' and (' || v_lock || ')' end;
begin
  if p_type not in ('A', 'B', 'C1', 'C2', 'E') then
    raise exception '型は A・B・C1・C2・E のどれか：%', p_type;
  end if;
  if p_type in ('A', 'B') and v_write is null then
    raise exception '型 % は write_perm が要る（%）', p_type, v_name;
  end if;
  if p_type = 'C2' and p_opts ->> 'scope_fn' is null then
    raise exception '型 C2 は scope_fn が要る（%）', v_name;
  end if;
  v_audit := coalesce((p_opts ->> 'audit')::boolean, p_type in ('A', 'B', 'E'));

  -- いったん既存の型の policy を外す（もう一度呼べる）
  for v_pol in select policyname from pg_policies where schemaname = 'public' and tablename = v_name and policyname like 'tp\_%' loop
    execute format('drop policy %I on %s', v_pol, p_table);
  end loop;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from anon, authenticated', p_table);
  execute format('grant select on %s to authenticated', p_table);
  if p_type in ('A', 'B', 'C1', 'C2') then
    execute format('grant insert on %s to authenticated', p_table);
    if not coalesce((p_opts ->> 'insert_only')::boolean, false) then
      execute format('grant update on %s to authenticated', p_table);
    end if;
  end if;

  -- 読む
  if p_type = 'A' then
    v_read := format('app.is_internal(%s)', v_tcol);
    if p_opts ->> 'read_scope' is not null then
      v_read := v_read || format(' and (public.has_perm(%s, %L) or (%s))',
                                 v_tcol, coalesce(p_opts ->> 'read_bypass', 'work.assign'), p_opts ->> 'read_scope');
    end if;
  elsif p_type = 'B' then
    v_read := format('public.has_perm(%s, %L)', v_tcol, 'amount.read');
  elsif p_type = 'C1' then
    v_read := format('app.is_owner_membership(%s, %I) or public.has_perm(%s, %L)', v_tcol, v_owner, v_tcol, v_sup);
  elsif p_type = 'C2' then
    v_read := format('%s(%s, %I) or public.has_perm(%s, %L)', p_opts ->> 'scope_fn', v_tcol, v_scope_col, v_tcol, v_sup);
  else -- E
    if coalesce(p_opts ->> 'read_perm', 'user.manage') = 'none' then
      v_read := 'false';
    else
      v_read := format('public.has_perm(%s, %L)', v_tcol, coalesce(p_opts ->> 'read_perm', 'user.manage'));
    end if;
    if p_opts ->> 'own_row_sql' is not null then
      v_read := v_read || ' or (' || (p_opts ->> 'own_row_sql') || ')';
    end if;
  end if;
  execute format('create policy tp_select on %s for select to authenticated using (%s)', p_table, v_read);

  -- 運営は、許された期間だけ、すべての型を読める（書けない）
  execute format('create policy tp_support_select on %s for select to authenticated using (app.is_support_viewer(%s))', p_table, v_tcol);

  -- 外部の人に見せる（D）
  if p_opts ->> 'external_read' is not null then
    v_ext := format('app.is_external(%s) and (%s)', v_tcol, p_opts ->> 'external_read');
    execute format('create policy tp_external_select on %s for select to authenticated using (%s)', p_table, v_ext);
  end if;

  -- 書く（E は RPC と Edge Function だけ。policy を作らない）
  if p_type in ('A', 'B') then
    v_ins := format('public.has_perm(%s, %L)', v_tcol, v_write);
    v_upd := v_ins;
  elsif p_type = 'C1' then
    v_ins := format('app.is_owner_membership(%s, %I)', v_tcol, v_owner);
    v_upd := v_ins;
    if v_write is not null then
      v_ins := v_ins || format(' or public.has_perm(%s, %L)', v_tcol, v_write);
      v_upd := v_upd || format(' or public.has_perm(%s, %L)', v_tcol, v_write);
    end if;
  elsif p_type = 'C2' then
    v_ins := format('%s(%s, %I)', p_opts ->> 'scope_fn', v_tcol, v_scope_col);
    v_upd := v_ins;
  end if;
  if p_type <> 'E' then
    execute format('create policy tp_insert on %s for insert to authenticated with check (%s)', p_table, v_ins);
    if not coalesce((p_opts ->> 'insert_only')::boolean, false) then
      execute format('create policy tp_update on %s for update to authenticated using ((%s)%s) with check ((%s)%s)',
                     p_table, v_upd, v_lock_and, v_upd, v_lock_and);
    end if;
  end if;

  -- トリガー
  execute format('drop trigger if exists tp_no_tenant_change on %s', p_table);
  if v_tc = 'tenant_id' then
    execute format('create trigger tp_no_tenant_change before update on %s for each row execute function app.forbid_tenant_change()', p_table);
  end if;
  execute format('drop trigger if exists tp_touch on %s', p_table);
  if exists (select 1 from pg_attribute where attrelid = p_table and attname = 'updated_at' and not attisdropped)
     and exists (select 1 from pg_attribute where attrelid = p_table and attname = 'updated_by' and not attisdropped) then
    execute format('create trigger tp_touch before update on %s for each row execute function app.touch_row()', p_table);
  end if;
  execute format('drop trigger if exists tp_audit on %s', p_table);
  if v_audit then
    execute format('create trigger tp_audit after insert or update or delete on %s for each row execute function app.audit_row()', p_table);
  end if;

  insert into app.policy_registry (table_name, policy_type, tenant_col, opts)
  values (v_name, p_type || case when p_opts ->> 'external_read' is not null then '+D' else '' end, v_tc, p_opts)
  on conflict (table_name) do update
    set policy_type = excluded.policy_type, tenant_col = excluded.tenant_col, opts = excluded.opts;
end $$;

-- 型の登録（どの表に何の型を付けたか。テストが「付け忘れ」を見つけるのに使う）
create table app.policy_registry (
  table_name text primary key,
  policy_type text not null,
  tenant_col text not null default 'tenant_id',
  opts jsonb not null default '{}'::jsonb,
  registered_at timestamptz not null default now()
);
revoke all on app.policy_registry from public, anon, authenticated;

-- 共通のマスタ（M）：ログインした人が読むだけ
create function app.apply_master_policy(p_table regclass) returns void language plpgsql set search_path = '' as $$
declare v_name text := (select relname from pg_class where oid = p_table);
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from anon, authenticated', p_table);
  execute format('grant select on %s to authenticated', p_table);
  execute format('drop policy if exists tp_select on %s', p_table);
  execute format('create policy tp_select on %s for select to authenticated using (true)', p_table);
  insert into app.policy_registry (table_name, policy_type, tenant_col) values (v_name, 'M', 'none')
  on conflict (table_name) do update set policy_type = 'M';
end $$;

select app.lock_functions();
-- 実行の権限：policy が使う判定は authenticated に、型を付ける関数は migration だけに
revoke execute on function app.apply_policy(regclass, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app.apply_master_policy(regclass) from public, anon, authenticated, service_role;
grant execute on function
  app.is_operator(), public.has_perm(uuid, text), app.is_internal(uuid), app.is_external(uuid),
  app.is_support_viewer(uuid), app.my_tenant_ids(), app.is_owner_membership(uuid, uuid),
  app.is_my_membership(uuid, uuid), app.can_external_see_building(uuid, uuid),
  app.storage_tenant(text), app.storage_path_ok(uuid, text)
to authenticated, service_role;
