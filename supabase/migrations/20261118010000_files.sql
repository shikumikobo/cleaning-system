-- 機能 005：ファイルと専用ページ。data-model.md の 005 の章と、005 の design.md が正。
-- ファイルの行（files）、掃除の関数（service_role だけ）、建物を消すときの使われ方の登録。
-- request_id・quote_id は、案件（003）と見積（004）の表ができるまで列だけ（外部キーは取り込みのときに足す）。

-- 1. 表 ------------------------------------------------------------------------

create table public.files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  building_id uuid not null,
  request_id uuid, -- 003 の表ができたら (tenant_id, request_id) の外部キーを足す
  quote_id uuid, -- 004 の表ができたら (tenant_id, quote_id) の外部キーを足す
  name text not null check (length(btrim(name)) > 0 and length(name) <= 255),
  mime text not null check (length(btrim(mime)) > 0),
  size bigint not null check (size >= 0),
  storage_path text not null,
  shared_external boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, building_id) references public.buildings (tenant_id, id),
  -- <tenant_id>/files/ で始まり、その下に1字以上
  check (app.storage_path_ok(tenant_id, storage_path) and left(storage_path, 43) = tenant_id::text || '/files/' and length(storage_path) > 43)
);
create unique index files_path_uq on public.files (tenant_id, storage_path) where deleted_at is null;
create index files_building_idx on public.files (tenant_id, building_id);
create index files_request_idx on public.files (tenant_id, request_id) where request_id is not null;
create index files_quote_idx on public.files (tenant_id, quote_id) where quote_id is not null;

-- 2. policy：型 A（書けるのは master.edit）に、外部の型 D を足す -------------------------
-- 外部の人が読めるのは、許された建物の、共有された、消していない行だけ

select app.apply_policy('public.files', 'A', jsonb_build_object(
  'write_perm', 'master.edit',
  'external_read', 'shared_external and deleted_at is null and app.can_external_see_building(tenant_id, building_id)'));

-- 作ったあとに直せるのは、名前・共有・つなぎ・消す（deleted_at）だけ。建物・パス・種類・大きさは直せない
revoke update on public.files from authenticated;
grant update (tenant_id, request_id, quote_id, name, shared_external, deleted_at, updated_at, updated_by) on public.files to authenticated;

-- 建物を消すとき、その建物のファイルの行も一緒に論理削除する（実体は、掃除が消す）
insert into app.usage_refs (parent, action, child_table, where_sql, reason)
values ('building', 'cascade', 'files', 'building_id = $2', '');

-- 3. 掃除の関数（service_role だけ。Edge Function sweep-files が会社ごとに呼ぶ）-----------------
-- 置き場所の実体は DB からは消せない（Supabase の決まり）ので、消す対象のパスを返し、Edge Function が Storage の API で消す。

-- 同じ会社の掃除は同時に1つだけ動かす
create unique index job_runs_sweep_files_running_uq on public.job_runs (tenant_id, kind)
  where kind = 'sweep_files' and status = 'running' and deleted_at is null;

create function public.file_sweep_tenants() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.tenants t where t.deleted_at is null order by t.id
$$;

-- 処理の記録を始める。同じ会社の掃除がすでに動いていれば null（30 分を過ぎた古い記録は失敗で閉じる）
create function public.file_sweep_start_run(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.job_runs set status = 'failure', ended_at = now(), error = 'timeout'
  where tenant_id = p_tenant and kind = 'sweep_files' and status = 'running' and deleted_at is null
    and started_at < now() - interval '30 minutes';
  begin
    insert into public.job_runs (tenant_id, kind) values (p_tenant, 'sweep_files') returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

create function public.file_sweep_finish_run(p_tenant uuid, p_run uuid, p_status text, p_counts jsonb, p_error text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_status not in ('success', 'failure') then
    raise exception '状況は success か failure：%', p_status using errcode = '22023';
  end if;
  update public.job_runs set status = p_status, ended_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 300)
  where id = p_run and tenant_id = p_tenant and kind = 'sweep_files' and status = 'running';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- 消す対象の実体のパス：<tenant>/files/ の下で、猶予より前に作られ、
-- 生きている行も、猶予の間に消した行も持たないもの。files/ の外（写真・レシート）と、ほかの会社は対象にしない
create function public.file_sweep_orphans(p_tenant uuid, p_grace interval default interval '1 day', p_limit int default 1000)
returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(x.name order by x.created_at, x.name), '{}'::text[])
  from (
    select o.name, o.created_at
    from storage.objects o
    where o.bucket_id = 'tenant-files'
      and left(o.name, 43) = p_tenant::text || '/files/'
      and o.created_at < now() - p_grace
      and not exists (
        select 1 from public.files f
        where f.tenant_id = p_tenant and f.storage_path = o.name
          and (f.deleted_at is null or f.deleted_at >= now() - p_grace))
    order by o.created_at, o.name
    limit greatest(p_limit, 0)
  ) x
$$;

-- 猶予より前に作った行で、実体のないものを論理削除する。件数を返す
create function public.file_sweep_rows(p_tenant uuid, p_grace interval default interval '1 day') returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform set_config('app.source', 'job', true);
  update public.files f set deleted_at = now()
  where f.tenant_id = p_tenant and f.deleted_at is null and f.created_at < now() - p_grace
    and not exists (select 1 from storage.objects o where o.bucket_id = 'tenant-files' and o.name = f.storage_path);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

select app.lock_functions();
revoke execute on function public.file_sweep_tenants() from public, anon, authenticated;
revoke execute on function public.file_sweep_start_run(uuid) from public, anon, authenticated;
revoke execute on function public.file_sweep_finish_run(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.file_sweep_orphans(uuid, interval, int) from public, anon, authenticated;
revoke execute on function public.file_sweep_rows(uuid, interval) from public, anon, authenticated;
grant execute on function public.file_sweep_tenants() to service_role;
grant execute on function public.file_sweep_start_run(uuid) to service_role;
grant execute on function public.file_sweep_finish_run(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.file_sweep_orphans(uuid, interval, int) to service_role;
grant execute on function public.file_sweep_rows(uuid, interval) to service_role;
