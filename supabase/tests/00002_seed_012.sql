-- 機能 012 の種：実績（work_records）。会社 A・B に1件ずつ（終わった実績）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
-- 作業・担当・報告書の行は足さない（009・010・011 の種の件数を変えないため。R-012-26）。
--   会社 A：終わった作業 wA10-done のスタッフ A の実績（9:05〜11:50）
--   会社 B：作業 wB10 のスタッフ B の実績（終わったもの）
create or replace function tests.seed_012() returns void language plpgsql as $$
declare ta uuid := tests.t('A'); tb uuid := tests.t('B'); today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  insert into public.work_records (id, tenant_id, work_id, membership_id, started_at, ended_at, client_created_at, device_id) values
    (tests.id('wrA10-done'), ta, tests.id('wA10-done'), tests.id('m:A:staffA'),
     ((today - 7) + time '09:05') at time zone 'Asia/Tokyo', ((today - 7) + time '11:50') at time zone 'Asia/Tokyo', now(), 'dev-seed-a'),
    (tests.id('wrB10'), tb, tests.id('wB10'), tests.id('m:B:staffB'),
     (today + time '09:00') at time zone 'Asia/Tokyo', (today + time '10:00') at time zone 'Asia/Tokyo', now(), 'dev-seed-b');
end $$;
select plan(1);
select pass('012 の種を入れた');
select * from finish();
