-- 機能 003 の種（会社 A・B に、案件と金額を1つ以上）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
create or replace function tests.seed_003() returns void language plpgsql as $$
declare ta uuid := tests.t('A'); tb uuid := tests.t('B'); today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  insert into public.requests (id, tenant_id, client_id, building_id, room_id, source, category, title, detail, due_date, assignee_id, status) values
    -- スタッフA が担当（明日が期限）
    (tests.id('reqA-1'), ta, tests.id('clientA1'), tests.id('buildingA1'), null, 'phone', 'repair', '共用部の電球交換', '3階の廊下', today + 1, tests.id('m:A:staffA'), 'new'),
    -- 担当なし・期限切れ・対応中
    (tests.id('reqA-2'), ta, tests.id('clientA1'), tests.id('buildingA1'), null, 'manual', 'complaint', '階段の汚れ', null, today - 2, null, 'in_progress'),
    -- 社員A が担当・期限なし
    (tests.id('reqA-3'), ta, tests.id('clientA1'), tests.id('buildingA2'), null, 'email', 'inquiry', '年末の大掃除の相談', null, null, tests.id('m:A:memberA'), 'new'),
    -- 完了
    (tests.id('reqA-4'), ta, tests.id('clientA1'), tests.id('buildingA2'), null, 'manual', 'cleaning', '窓ガラスの拭き直し', null, today - 10, tests.id('m:A:staffA'), 'done'),
    (tests.id('reqB-1'), tb, tests.id('clientB1'), tests.id('buildingB1'), null, 'manual', 'cleaning', 'B のロビーの清掃', null, today + 2, tests.id('m:B:staffB'), 'new');
  insert into public.request_charges (id, tenant_id, request_id, amount, billable) values
    (tests.id('chgA-1'), ta, tests.id('reqA-1'), 5000, true),
    (tests.id('chgA-4'), ta, tests.id('reqA-4'), 12000, false),
    (tests.id('chgB-1'), tb, tests.id('reqB-1'), 3000, true);
end $$;
select plan(1);
select pass('003 の種を入れた');
select * from finish();
