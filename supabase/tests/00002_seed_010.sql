-- 機能 010 の種：専用の取引先・建物（A10・B10）に契約・清掃の中身・決まった担当・作業・作業の金額・担当（会社 A・B）。
-- tests.seed() の最後から呼ばれる。00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
-- 外部の人 extA が許されているのは建物 A1 だけ（tests.seed() の external_building_access）。A1 にも契約と作業を1つ置く。
-- 既存の取引先・建物（A4 ほか）には契約を付けない（002・004 の「消せるか」のテストを変えないため）。
create or replace function tests.seed_010() returns void language plpgsql as $$
declare ta uuid := tests.t('A'); tb uuid := tests.t('B'); today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  insert into public.clients (id, tenant_id, kind, name) values
    (tests.id('clientA10'), ta, 'management_company', 'テスト契約先A'),
    (tests.id('clientB10'), tb, 'management_company', 'テスト契約先B');
  insert into public.buildings (id, tenant_id, client_id, name, address) values
    (tests.id('buildingA10'), ta, tests.id('clientA10'), 'テスト契約ビルA10', '東京都A区10-10-10'),
    (tests.id('buildingB10'), tb, tests.id('clientB10'), 'テスト契約ビルB10', '大阪府B市10-10-10');
  insert into public.contracts (id, tenant_id, client_id, building_id, source, quote_id, kind, start_date, end_date, status) values
    (tests.id('cA10'), ta, tests.id('clientA10'), tests.id('buildingA10'), 'import', null, 'recurring', date '2026-01-01', null, 'active'),
    (tests.id('cA1'), ta, tests.id('clientA10'), tests.id('buildingA1'), 'import', null, 'recurring', date '2026-01-01', null, 'active'),
    (tests.id('cB10'), tb, tests.id('clientB10'), tests.id('buildingB10'), 'import', null, 'recurring', date '2026-01-01', null, 'active');
  insert into public.contract_services (id, tenant_id, contract_id, service_key, service_kind, name, amount, billing, recurrence, start_time, end_time, valid_from) values
    (tests.id('svcA10-base'), ta, tests.id('cA10'), tests.id('key:A10-base'), 'base', '定期清掃', 30000, 'monthly', 'FREQ=WEEKLY;BYDAY=MO', time '09:00', time '12:00', date '2026-01-01'),
    (tests.id('svcA10-opt'), ta, tests.id('cA10'), tests.id('key:A10-opt'), 'option', '窓清掃', 12000, 'per_visit', 'FREQ=MONTHLY;INTERVAL=3', null, null, date '2026-01-01'),
    (tests.id('svcA1-base'), ta, tests.id('cA1'), tests.id('key:A1-base'), 'base', '定期清掃（A1）', 20000, 'monthly', 'FREQ=MONTHLY;BYDAY=2TU', null, null, date '2026-01-01'),
    (tests.id('svcB10-base'), tb, tests.id('cB10'), tests.id('key:B10-base'), 'base', '定期清掃（B）', 25000, 'monthly', 'FREQ=WEEKLY;BYDAY=TU', null, null, date '2026-01-01');
  insert into public.contract_service_staff (id, tenant_id, contract_service_id, membership_id) values
    (tests.id('cssA10-staff'), ta, tests.id('svcA10-base'), tests.id('m:A:staffA')),
    (tests.id('cssA10-member'), ta, tests.id('svcA10-base'), tests.id('m:A:memberA')),
    (tests.id('cssB10-staff'), tb, tests.id('svcB10-base'), tests.id('m:B:staffB'));
  -- 作業：A10 のもの（スタッフ A が担当）・A1 のもの（担当なし。外部の人に日と状況だけ見える）・終わったもの・B のもの
  insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, start_time, end_time, status) values
    (tests.id('wA10'), ta, tests.id('buildingA10'), tests.id('svcA10-base'), tests.id('key:A10-base'), '定期清掃', today + 7, time '09:00', time '12:00', 'scheduled'),
    (tests.id('wA10-done'), ta, tests.id('buildingA10'), tests.id('svcA10-base'), tests.id('key:A10-base'), '定期清掃', today - 7, time '09:00', time '12:00', 'done'),
    (tests.id('wA1'), ta, tests.id('buildingA1'), tests.id('svcA1-base'), tests.id('key:A1-base'), '定期清掃（A1）', today + 9, null, null, 'scheduled'),
    (tests.id('wB10'), tb, tests.id('buildingB10'), tests.id('svcB10-base'), tests.id('key:B10-base'), '定期清掃（B）', today + 3, null, null, 'scheduled');
  insert into public.work_assignments (id, tenant_id, work_id, membership_id) values
    (tests.id('waA10-staff'), ta, tests.id('wA10'), tests.id('m:A:staffA')),
    (tests.id('waA10-member'), ta, tests.id('wA10'), tests.id('m:A:memberA')),
    (tests.id('waB10-staff'), tb, tests.id('wB10'), tests.id('m:B:staffB'));
  insert into public.work_charges (id, tenant_id, work_id, amount) values
    (tests.id('wcA10'), ta, tests.id('wA10'), 12000),
    (tests.id('wcA1'), ta, tests.id('wA1'), 5000),
    (tests.id('wcB10'), tb, tests.id('wB10'), 8000);
end $$;
select plan(1);
select pass('010 の種を入れた');
select * from finish();
