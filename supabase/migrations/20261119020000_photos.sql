-- 機能 008：現場の写真。data-model.md の 008 の章と、008 の design.md が正。
-- 写真の行（photos。型 C2＋D）、掃除の関数（写真の分。service_role だけ）、気づきから案件を作る RPC に写真の引数。
-- work_id・report_item_id は、作業（010）と報告書（009）の表ができるまで列と索引だけ（外部キーは取り込みのときに足す）。

-- 1. 表 ------------------------------------------------------------------------

create table public.photos (
  id uuid primary key default gen_random_uuid(), -- 端末で作った uuid をそのまま使う（二度送っても1件）
  tenant_id uuid not null references public.tenants (id),
  building_id uuid not null,
  area_id uuid,
  room_id uuid,
  work_id uuid, -- 作業（010）の表ができたら (tenant_id, work_id) の外部キーを足す
  report_item_id uuid, -- 報告書の項目（009）の表ができたら (tenant_id, report_item_id) の外部キーを足す
  request_id uuid,
  kind text not null check (kind in ('before', 'after', 'observation')),
  taken_at timestamptz not null, -- 端末で撮った時刻
  taken_by uuid not null, -- 撮った人（所属）
  storage_path text not null,
  thumb_path text not null,
  width int not null check (width > 0 and width <= 20000),
  height int not null check (height > 0 and height <= 20000),
  bytes bigint not null check (bytes > 0),
  created_at timestamptz not null default now(), -- 届いた時刻
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id),
  foreign key (tenant_id, area_id) references public.building_areas (tenant_id, id),
  foreign key (tenant_id, room_id) references public.rooms (tenant_id, id),
  foreign key (tenant_id, request_id) references public.requests (tenant_id, id),
  foreign key (tenant_id, taken_by) references public.memberships (tenant_id, id),
  -- 置き場所は <tenant_id>/photos/<写真の id>/ の下の決まった名前（別の写真・別の会社のファイルを指させない）
  check (storage_path = tenant_id::text || '/photos/' || id::text || '/photo.jpg'),
  check (thumb_path = tenant_id::text || '/photos/' || id::text || '/thumb.jpg')
);
create index photos_building_idx on public.photos (tenant_id, building_id, taken_at desc);
create index photos_area_idx on public.photos (tenant_id, area_id) where area_id is not null;
create index photos_room_idx on public.photos (tenant_id, room_id) where room_id is not null;
create index photos_request_idx on public.photos (tenant_id, request_id) where request_id is not null;
create index photos_work_idx on public.photos (tenant_id, work_id) where work_id is not null;
create index photos_report_item_idx on public.photos (tenant_id, report_item_id) where report_item_id is not null;
create index photos_taken_by_idx on public.photos (tenant_id, taken_by, taken_at desc);

-- 2. 判定の関数 --------------------------------------------------------------------

-- 報告書が提出・確認のあとで、写真を直せないか。報告書（009）ができるまでは、固定される写真はない。
-- 009 が、この関数を create or replace で本物（報告書の項目 → 報告書の状況が下書きでない）に置き換える
create function app.photo_report_locked(p_tenant uuid, p_report_item uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select false
$$;

-- 外部の人に見せてよい写真か（提出した報告書の写真だけ。型 D）。報告書（009）ができるまでは、だれにも見せない。
-- 009 が、この関数を create or replace で本物に置き換える（外部の人の policy は、この関数を呼ぶ）
create function app.photo_external_visible(p_tenant uuid, p_building uuid, p_report_item uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select false
$$;

-- 型 C2 の「持ち主」。その作業の担当の全員。作業のない写真は、撮った本人。
-- 作業と担当の表（010。work_assignments の tenant_id・work_id・membership_id）がまだなければ、作業つきでも撮った本人で決める。
-- 行ごと（whole row）に渡すのは、作業のない写真の判定に taken_by が要るため（apply_policy の scope_col に表の名前を渡す）。
-- 名前が is_my_ で始まるのは、構造のテストが「権限の関数で判定している」と見分けるため
create function app.is_my_photo(p_tenant uuid, p public.photos) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v boolean;
begin
  if not app.is_internal(p_tenant) then return false; end if;
  if p.work_id is not null
     and (select count(*) from pg_attribute
          where attrelid = to_regclass('public.work_assignments') and attname in ('tenant_id', 'work_id', 'membership_id') and not attisdropped) = 3 then
    execute 'select exists (select 1 from public.work_assignments a where a.tenant_id = $1 and a.work_id = $2 and app.is_owner_membership($1, a.membership_id))'
      into v using p_tenant, p.work_id;
    return coalesce(v, false);
  end if;
  return app.is_owner_membership(p_tenant, p.taken_by);
end $$;

-- 3. policy：型 C2（作業の担当）に、外部の型 D を足す ------------------------------------
-- 読む：持ち主と work.assign を持つ人。直す：持ち主（報告書が下書きの間だけ）。外部の人は、photo_external_visible が真の行だけ

select app.apply_policy('public.photos', 'C2', jsonb_build_object(
  'scope_fn', 'app.is_my_photo',
  'scope_col', 'photos',
  'lock_sql', 'not app.photo_report_locked(tenant_id, report_item_id)',
  'external_read', 'deleted_at is null and app.photo_external_visible(tenant_id, building_id, report_item_id)'));

-- 作る：field.record を持ち、撮った人は自分。案件のつなぎは、自分が読める案件だけ
drop policy tp_insert on public.photos;
create policy tp_insert on public.photos for insert to authenticated
  with check (
    public.has_perm(tenant_id, 'field.record')
    and app.is_owner_membership(tenant_id, taken_by)
    and app.is_my_photo(tenant_id, photos)
    and (request_id is null or exists (select 1 from public.requests r where r.id = photos.request_id and r.tenant_id = photos.tenant_id)));

-- 直せるのは、種類・場所・部屋・消す（deleted_at）だけ。建物・撮った人・撮った時刻・置き場所・案件のつなぎは直せない
-- （案件のつなぎは、気づきから案件を作る RPC だけが入れる）
revoke update on public.photos from authenticated;
grant update (tenant_id, kind, area_id, room_id, deleted_at, updated_at, updated_by) on public.photos to authenticated;

-- 建物を消すとき、その建物の写真の行も一緒に論理削除する（実体は、掃除が消す）。
-- 部屋・場所を使っていれば消さずに「使わない」にする行は、002 に既にある（photos の room_id・area_id）
insert into app.usage_refs (parent, action, child_table, where_sql, reason)
values ('building', 'cascade', 'photos', 'building_id = $2', '');

-- 4. 掃除の関数（service_role だけ。Edge Function sweep-files が、ファイルの掃除と同じ会社ごとの1回の中で呼ぶ）------
-- 005 の file_sweep_* と同じ形。<tenant>/photos/ の下だけが対象。処理の記録（job_runs）は 005 のものを使う

-- 消す対象の実体のパス：<tenant>/photos/ の下で、猶予より前に作られ、
-- 生きている写真の行（元の画像・小さな画像）も、猶予の間に消した行も持たないもの
create function public.photo_sweep_orphans(p_tenant uuid, p_grace interval default interval '1 day', p_limit int default 1000)
returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(x.name order by x.created_at, x.name), '{}'::text[])
  from (
    select o.name, o.created_at
    from storage.objects o
    where o.bucket_id = 'tenant-files'
      and left(o.name, 44) = p_tenant::text || '/photos/'
      and o.created_at < now() - p_grace
      and not exists (
        select 1 from public.photos f
        where f.tenant_id = p_tenant and (f.storage_path = o.name or f.thumb_path = o.name)
          and (f.deleted_at is null or f.deleted_at >= now() - p_grace))
    order by o.created_at, o.name
    limit greatest(p_limit, 0)
  ) x
$$;

-- 猶予より前に作った行で、元の画像の実体がないものを論理削除する。件数を返す
create function public.photo_sweep_rows(p_tenant uuid, p_grace interval default interval '1 day') returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform set_config('app.source', 'job', true);
  update public.photos f set deleted_at = now()
  where f.tenant_id = p_tenant and f.deleted_at is null and f.created_at < now() - p_grace
    and not exists (select 1 from storage.objects o where o.bucket_id = 'tenant-files' and o.name = f.storage_path);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 5. 気づきの写真から案件を作る -----------------------------------------------------------
-- 003 の RPC に、写真の引数（p_photo_ids）を足して作り直す。端末で作った uuid（p_id）で、二度呼んでも1件（二度目は写真に触らない）。
-- 写真は、気づき（observation）で、同じ建物・同じ会社で、まだ案件に付いておらず、呼んだ人が直せるもの（持ち主か work.assign）だけ。
-- 1つでも合わなければ、案件も作らず、全部を戻す。見つからない写真は 42501、条件に合わない写真は 22023。
drop function public.create_request_from_observation(uuid, uuid, text, text, uuid, text);
create function public.create_request_from_observation(
  p_id uuid, p_building_id uuid, p_title text, p_detail text default null, p_room_id uuid default null, p_category text default 'other',
  p_photo_ids uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid; v_client uuid; v_member uuid; v_ex_tenant uuid; v_ex_by uuid;
  v_pid uuid; v_p public.photos; v_ids uuid[]; v_linked int := 0;
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

  -- 写真のつなぎ（写真の側にだけ request_id を持つ）
  if p_photo_ids is not null then
    select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(p_photo_ids) x where x is not null;
    foreach v_pid in array v_ids loop
      select * into v_p from public.photos where id = v_pid and tenant_id = v_tenant and deleted_at is null;
      if not found
         or not (app.is_my_photo(v_tenant, v_p) or public.has_perm(v_tenant, 'work.assign'))
         or app.photo_report_locked(v_tenant, v_p.report_item_id) then
        raise exception '権限がない' using errcode = '42501';
      end if;
      if v_p.kind <> 'observation' or v_p.building_id <> p_building_id or v_p.request_id is not null then
        raise exception '写真を案件につなげられない（気づきの写真で、同じ建物で、まだ案件に付いていないものだけ）' using errcode = '22023';
      end if;
      update public.photos set request_id = p_id where id = v_pid and tenant_id = v_tenant;
      v_linked := v_linked + 1;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'already', false, 'photos', v_linked);
end $$;

-- 6. 実行の権限 ---------------------------------------------------------------
select app.lock_functions();
revoke execute on function public.create_request_from_observation(uuid, uuid, text, text, uuid, text, uuid[]) from public, anon;
grant execute on function public.create_request_from_observation(uuid, uuid, text, text, uuid, text, uuid[]) to authenticated;
grant execute on function app.photo_report_locked(uuid, uuid), app.photo_external_visible(uuid, uuid, uuid), app.is_my_photo(uuid, public.photos)
  to authenticated, service_role;
revoke execute on function public.photo_sweep_orphans(uuid, interval, int) from public, anon, authenticated;
revoke execute on function public.photo_sweep_rows(uuid, interval) from public, anon, authenticated;
grant execute on function public.photo_sweep_orphans(uuid, interval, int) to service_role;
grant execute on function public.photo_sweep_rows(uuid, interval) to service_role;
