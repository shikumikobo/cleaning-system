-- 機能 013 の種：建物の位置（東京駅と大阪駅のあたり。架空の建物に付けただけ）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
-- 実績・作業の行は足さない（012 の種の件数を変えないため）。90 日の掃除のテストは、テストの中で古い実績を作る。
create or replace function tests.seed_013() returns void language plpgsql as $$
begin
  update public.buildings set lat = 35.681236, lng = 139.767125 where id = tests.id('buildingA1');
  update public.buildings set lat = 34.702485, lng = 135.495951 where id = tests.id('buildingB1');
end $$;
select plan(1);
select pass('013 の種を入れた');
select * from finish();
