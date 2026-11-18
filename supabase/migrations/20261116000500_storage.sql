-- ファイルの置き場所：非公開。パスは <tenant_id>/… で始める。見せるときは期限つきの URL（Edge Function）。
-- 別の会社のフォルダへは、上げられず、読めない。外部の人は、直接は読まない（URL で渡す）。

insert into storage.buckets (id, name, public)
values ('tenant-files', 'tenant-files', false)
on conflict (id) do update set public = false;

create function app.can_write_storage(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_perm(p_tenant, 'master.edit') or public.has_perm(p_tenant, 'field.record')
$$;
grant execute on function app.can_write_storage(uuid) to authenticated, service_role;

select app.lock_functions();
create policy tenant_files_select on storage.objects for select to authenticated
  using (bucket_id = 'tenant-files' and app.is_internal(app.storage_tenant(name)));
create policy tenant_files_support_select on storage.objects for select to authenticated
  using (bucket_id = 'tenant-files' and app.is_support_viewer(app.storage_tenant(name)));
create policy tenant_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-files' and app.can_write_storage(app.storage_tenant(name)));
create policy tenant_files_update on storage.objects for update to authenticated
  using (bucket_id = 'tenant-files' and app.can_write_storage(app.storage_tenant(name)))
  with check (bucket_id = 'tenant-files' and app.can_write_storage(app.storage_tenant(name)));
create policy tenant_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'tenant-files' and app.can_write_storage(app.storage_tenant(name)));
