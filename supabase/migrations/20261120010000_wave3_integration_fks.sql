-- 波 3 の取り込み：008（写真）と 010（契約・作業）のつなぎ。
-- 1. photos.work_id → works：会社をまたがないよう (tenant_id, id) の組で指す。空は許す。索引は 008 のマイグレーションに既にある。
alter table public.photos
  add constraint photos_work_fk foreign key (tenant_id, work_id) references public.works (tenant_id, id);

-- 1b. cash_entries.work_id → works（006 の出入り）。006 では作業の表がなかったので列だけを置いていた。空は許す。
alter table public.cash_entries
  add constraint cash_entries_work_fk foreign key (tenant_id, work_id) references public.works (tenant_id, id);
create index cash_entries_work_idx on public.cash_entries (tenant_id, work_id) where work_id is not null;

-- 2. 写真の「持ち主」の判定を、本物の担当の表（work_assignments）を直接読む形に置き換える。
--    008 では、表がまだなければ撮った本人で決める動的な形にしていた。010 が表を作ったので、その分岐をなくす。
--    あわせて、外された担当（deleted_at が入った行）は担当に数えない（008 の作り込みでは見落としていた）。
--    作業のある写真：その作業の担当の全員。作業のない写真：撮った本人。
create or replace function app.is_my_photo(p_tenant uuid, p public.photos) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_internal(p_tenant) then return false; end if;
  if p.work_id is not null then
    return exists (
      select 1 from public.work_assignments a
      where a.tenant_id = p_tenant and a.work_id = p.work_id and a.deleted_at is null
        and app.is_owner_membership(p_tenant, a.membership_id));
  end if;
  return app.is_owner_membership(p_tenant, p.taken_by);
end $$;

-- 3. app.usage_refs：作業は消さず、取り消す（status=cancelled と deleted_at）だけで、作業を消す RPC はない。
--    取り消した作業を指す写真は、外部キーがあるので行は残る（作業の論理削除は写真に影響しない）。
--    作業を物理的に消す経路は無いので、「写真に使われている作業」の行は足さない。
