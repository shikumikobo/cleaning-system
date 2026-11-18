-- 機能 005 の種（会社 A・B に、ファイルを1つ以上）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
--   会社 A：建物 A1 に、共有（fileA-shared）・共有しない（fileA-private）・共有だが消した（fileA-deleted）、建物 A2 に共有（fileA-b2）
--   外部の extA が許されているのは建物 A1 だけ（tests.seed() の external_building_access）
--   置き場所（storage.objects）にも、fileA-shared・fileA-private・fileB-shared の実体を置く
create or replace function tests.file_path(p_tenant text, p_name text) returns text language sql immutable as
$$ select tests.t(p_tenant)::text || '/files/' || tests.id(p_name)::text || '/' || p_name || '.pdf' $$;

create or replace function tests.seed_005() returns void language plpgsql as $$
begin
  insert into public.files (id, tenant_id, building_id, name, mime, size, storage_path, shared_external, deleted_at) values
    (tests.id('fileA-shared'), tests.t('A'), tests.id('buildingA1'), '契約書.pdf', 'application/pdf', 1000, tests.file_path('A', 'fileA-shared'), true, null),
    (tests.id('fileA-private'), tests.t('A'), tests.id('buildingA1'), '社内メモ.pdf', 'application/pdf', 2000, tests.file_path('A', 'fileA-private'), false, null),
    (tests.id('fileA-deleted'), tests.t('A'), tests.id('buildingA1'), '消した.pdf', 'application/pdf', 3000, tests.file_path('A', 'fileA-deleted'), true, now()),
    (tests.id('fileA-b2'), tests.t('A'), tests.id('buildingA2'), '別の建物.pdf', 'application/pdf', 4000, tests.file_path('A', 'fileA-b2'), true, null),
    (tests.id('fileB-shared'), tests.t('B'), tests.id('buildingB1'), 'B社の契約書.pdf', 'application/pdf', 5000, tests.file_path('B', 'fileB-shared'), true, null);
  insert into storage.objects (bucket_id, name) values
    ('tenant-files', tests.file_path('A', 'fileA-shared')),
    ('tenant-files', tests.file_path('A', 'fileA-private')),
    ('tenant-files', tests.file_path('B', 'fileB-shared'));
end $$;
select plan(1);
select pass('005 の種を入れた');
select * from finish();
