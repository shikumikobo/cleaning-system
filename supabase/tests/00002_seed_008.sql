-- 機能 008 の種（会社 A・B に、写真を1つ以上）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
--   会社 A：建物 A1 に、スタッフA が撮った前の写真（photoA-staff）・社員A が撮った気づきの写真（photoA-obs）・
--           スタッフA が撮った気づきの写真（photoA-obs-staff）、建物 A2 にスタッフA が撮った後の写真（photoA-b2）
--   会社 B：建物 B1 に、スタッフB の写真（photoB-staff）
--   置き場所（storage.objects）にも、全部の写真の元の画像・小さな画像の実体を置く
create or replace function tests.photo_path(p_tenant text, p_name text, p_file text default 'photo.jpg') returns text language sql immutable as
$$ select tests.t(p_tenant)::text || '/photos/' || tests.id(p_name)::text || '/' || p_file $$;

-- 写真の行を1つ作る（持ち主・種類・建物などを選べる。実体の行は作らない）
create or replace function tests.make_photo(p_tenant text, p_name text, p_building text, p_member text, p_kind text default 'before',
  p_extra text default '') returns uuid language plpgsql as $$
declare v_id uuid := tests.id(p_name);
begin
  execute format(
    'insert into public.photos (id, tenant_id, building_id, kind, taken_at, taken_by, storage_path, thumb_path, width, height, bytes%s) values (%L, %L, %L, %L, now(), %L, %L, %L, 1600, 1200, 300000%s)',
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '|', 1) end,
    v_id, tests.t(p_tenant), tests.id(p_building), p_kind, tests.id('m:' || p_tenant || ':' || p_member),
    tests.photo_path(p_tenant, p_name), tests.photo_path(p_tenant, p_name, 'thumb.jpg'),
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '|', 2) end);
  return v_id;
end $$;

create or replace function tests.seed_008() returns void language plpgsql as $$
declare n text;
begin
  perform tests.make_photo('A', 'photoA-staff', 'buildingA1', 'staffA', 'before');
  perform tests.make_photo('A', 'photoA-obs', 'buildingA1', 'memberA', 'observation');
  perform tests.make_photo('A', 'photoA-obs-staff', 'buildingA1', 'staffA', 'observation');
  perform tests.make_photo('A', 'photoA-b2', 'buildingA2', 'staffA', 'after');
  perform tests.make_photo('B', 'photoB-staff', 'buildingB1', 'staffB', 'before');
  foreach n in array array['photoA-staff', 'photoA-obs', 'photoA-obs-staff', 'photoA-b2'] loop
    insert into storage.objects (bucket_id, name) values ('tenant-files', tests.photo_path('A', n)), ('tenant-files', tests.photo_path('A', n, 'thumb.jpg'));
  end loop;
  insert into storage.objects (bucket_id, name) values ('tenant-files', tests.photo_path('B', 'photoB-staff')), ('tenant-files', tests.photo_path('B', 'photoB-staff', 'thumb.jpg'));
end $$;
select plan(1);
select pass('008 の種を入れた');
select * from finish();
