-- 波 1 の取り込み：006 の出入り（cash_entries）の building_id に、002 の建物（buildings）への外部キーを付ける。
-- 006 の時点では建物の表がなかったので、列だけを置いていた。会社をまたがないよう、(tenant_id, id) の組で指す。
-- work_id は、作業（works。012）ができるまで保留（外部キーなし）。
alter table public.cash_entries
  add constraint cash_entries_building_fk foreign key (tenant_id, building_id) references public.buildings (tenant_id, id);
create index cash_entries_building_idx on public.cash_entries (tenant_id, building_id) where building_id is not null;
