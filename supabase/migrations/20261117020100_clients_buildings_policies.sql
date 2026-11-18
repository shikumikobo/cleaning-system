-- 機能 002：policy の型。表ごとに policy を書き分けない（型の選び方だけがここに残る）。

select app.apply_policy('public.clients', 'A', '{"write_perm": "master.edit"}');
select app.apply_policy('public.client_contacts', 'A', '{"write_perm": "master.edit"}');
-- 建物：外部の人は、許された建物の名前と住所を読める（型 D）
select app.apply_policy('public.buildings', 'A', jsonb_build_object(
  'write_perm', 'master.edit',
  'external_read', 'app.can_external_see_building(tenant_id, id)'));
-- カルテ・部屋・場所：外部の人には見せない（型 A だけ）
select app.apply_policy('public.building_profiles', 'A', '{"write_perm": "master.edit"}');
select app.apply_policy('public.rooms', 'A', '{"write_perm": "master.edit"}');
select app.apply_policy('public.building_areas', 'A', '{"write_perm": "master.edit"}');

-- 消すのは RPC だけ（子も一緒に消し、使われていれば止めるため）。
-- 型 A は update をすべての列に与えるので、deleted_at を除いた列だけに作り直す。
-- （client_contacts は、画面から直接消す決まりなので、そのまま）
do $$
declare t text; cols text;
begin
  foreach t in array array['clients', 'buildings', 'building_profiles', 'rooms', 'building_areas'] loop
    execute format('revoke update on public.%I from authenticated', t);
    select string_agg(quote_ident(attname), ', ' order by attnum) into cols
    from pg_attribute
    where attrelid = ('public.' || t)::regclass and attnum > 0 and not attisdropped
      and attname not in ('deleted_at', 'created_at', 'created_by');
    execute format('grant update (%s) on public.%I to authenticated', cols, t);
  end loop;
end $$;
