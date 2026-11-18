-- 機能 006 の種（会社 A・B に、小口・レシート・出入りを1つ以上）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
create or replace function tests.seed_006() returns void language plpgsql as $$
declare ta uuid := tests.t('A'); tb uuid := tests.t('B');
begin
  insert into public.cash_accounts (id, tenant_id, holder_id, name) values
    (tests.id('cashA-staff'), ta, tests.id('m:A:staffA'), 'スタッフA の小口'),
    (tests.id('cashA-member'), ta, tests.id('m:A:memberA'), '社員A の小口'),
    (tests.id('cashB-staff'), tb, tests.id('m:B:staffB'), 'スタッフB の小口');
  insert into public.receipts (id, tenant_id, holder_id, storage_path, status) values
    (tests.id('rcpA-staff'), ta, tests.id('m:A:staffA'), ta::text || '/receipts/' || tests.id('rcpA-staff')::text || '.jpg', 'pending'),
    (tests.id('rcpA-member'), ta, tests.id('m:A:memberA'), ta::text || '/receipts/' || tests.id('rcpA-member')::text || '.jpg', 'pending'),
    (tests.id('rcpB-staff'), tb, tests.id('m:B:staffB'), tb::text || '/receipts/' || tests.id('rcpB-staff')::text || '.jpg', 'pending');
  -- スタッフA：渡した10000（確認済み）、買い物の出金500（下書き・レシート付き）
  insert into public.cash_entries (id, tenant_id, account_id, holder_id, entry_date, direction, amount, purpose, status, confirmed_at)
  values (tests.id('entA-in'), ta, tests.id('cashA-staff'), tests.id('m:A:staffA'), date '2026-10-05', 'in', 10000, '小口を渡した', 'confirmed', now());
  insert into public.cash_entries (id, tenant_id, account_id, holder_id, entry_date, direction, amount, purpose, receipt_id)
  values (tests.id('entA-out'), ta, tests.id('cashA-staff'), tests.id('m:A:staffA'), date '2026-10-06', 'out', 500, '洗剤', tests.id('rcpA-staff'));
  insert into public.cash_entries (id, tenant_id, account_id, holder_id, entry_date, direction, amount, purpose)
  values (tests.id('entA-member'), ta, tests.id('cashA-member'), tests.id('m:A:memberA'), date '2026-10-06', 'out', 300, '電池'),
         (tests.id('entB-out'), tb, tests.id('cashB-staff'), tests.id('m:B:staffB'), date '2026-10-06', 'out', 800, '袋');
end $$;
select plan(1);
select pass('006 の種を入れた');
select * from finish();
