-- 機能 014 の種：取り込みの記録（会社 A・B に1つずつ）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
create or replace function tests.seed_014() returns void language plpgsql as $$
begin
  insert into public.import_jobs (id, tenant_id, kind, file_name, status, total_rows, created_count, skipped_count, error_rows, details) values
    (tests.id('importA'), tests.t('A'), 'clients', '取引先A.csv', 'partial', 3, 1, 1, 1,
      '[{"row":3,"status":"error","messages":["name_required"],"by":"client"},{"row":4,"status":"duplicate","messages":["duplicate"],"by":"client"}]'::jsonb),
    (tests.id('importB'), tests.t('B'), 'clients', '取引先B.csv', 'done', 1, 1, 0, 0, '[]'::jsonb);
end $$;
select plan(1);
select pass('014 の種を入れた');
select * from finish();
