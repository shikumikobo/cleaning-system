-- 機能 004 の種：専用の取引先・建物（A4・B4）に、品名の候補と、状況ごとの見積（会社 A・B）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
-- 既存の取引先・建物（A1 ほか）は使わない（002 の「消せるか」のテストを変えないため）。外部の建物の許可（A1）も足さない。
create or replace function tests.seed_004() returns void language plpgsql as $$
declare ta uuid := tests.t('A'); tb uuid := tests.t('B');
begin
  insert into public.clients (id, tenant_id, kind, name) values
    (tests.id('clientA4'), ta, 'management_company', 'テスト見積先A'),
    (tests.id('clientB4'), tb, 'management_company', 'テスト見積先B');
  insert into public.buildings (id, tenant_id, client_id, name, address) values
    (tests.id('buildingA4'), ta, tests.id('clientA4'), 'テスト見積ビルA4', '東京都A区4-4-4'),
    (tests.id('buildingB4'), tb, tests.id('clientB4'), 'テスト見積ビルB4', '大阪府B市4-4-4');
  insert into public.items (id, tenant_id, name, unit, unit_price, kind) values
    (tests.id('itemA-base'), ta, '定期清掃（月額）', '月', 30000, 'base'),
    (tests.id('itemA-opt'), ta, '窓清掃', '回', 12000, 'option'),
    (tests.id('itemB-base'), tb, '定期清掃（月額）B', '月', 25000, 'base');
  -- 下書き（合計はまだ 0）
  insert into public.quotes (id, tenant_id, client_id, building_id, kind, status, tax_rate) values
    (tests.id('qA-draft'), ta, tests.id('clientA4'), tests.id('buildingA4'), 'request', 'draft', 0.1),
    (tests.id('qB-draft'), tb, tests.id('clientB4'), tests.id('buildingB4'), 'request', 'draft', 0.1);
  -- 提出・承認・不成立（番号は 2025 年のもの。今年の番号とぶつからない）
  insert into public.quotes (id, tenant_id, client_id, building_id, kind, status, number, issue_date, valid_until, tax_rate,
                             subtotal, tax, total, submitted_at, decided_at, decided_by) values
    (tests.id('qA-sub'), ta, tests.id('clientA4'), tests.id('buildingA4'), 'recurring', 'submitted', 'Q-2025-0001', date '2025-12-01', date '2025-12-31', 0.1, 42000, 4200, 46200, now(), null, null),
    (tests.id('qA-app'), ta, tests.id('clientA4'), tests.id('buildingA4'), 'recurring', 'approved', 'Q-2025-0002', date '2025-12-01', date '2025-12-31', 0.1, 42000, 4200, 46200, now(), now(), tests.u('adminA')),
    (tests.id('qA-rej'), ta, tests.id('clientA4'), tests.id('buildingA4'), 'recurring', 'rejected', 'Q-2025-0003', date '2025-12-01', date '2025-12-31', 0.1, 42000, 4200, 46200, now(), now(), tests.u('adminA')),
    (tests.id('qA-subOther'), ta, tests.id('clientA4'), tests.id('buildingA2'), 'recurring', 'submitted', 'Q-2025-0004', date '2025-12-01', date '2025-12-31', 0.1, 42000, 4200, 46200, now(), null, null),
    (tests.id('qB-sub'), tb, tests.id('clientB4'), tests.id('buildingB4'), 'recurring', 'submitted', 'Q-2025-0001', date '2025-12-01', date '2025-12-31', 0.1, 30000, 3000, 33000, now(), null, null);
  insert into public.quote_lines (id, tenant_id, quote_id, item_id, line_kind, name, qty, unit, unit_price, recurrence, sort)
  select tests.id('ln:' || q || ':base'), ta, tests.id(q), tests.id('itemA-base'), 'base', '定期清掃（月額）', 1, '月', 30000, 'FREQ=MONTHLY', 1
  from unnest(array['qA-sub', 'qA-app', 'qA-rej', 'qA-subOther']) q;
  insert into public.quote_lines (id, tenant_id, quote_id, item_id, line_kind, name, qty, unit, unit_price, recurrence, sort)
  select tests.id('ln:' || q || ':opt'), ta, tests.id(q), tests.id('itemA-opt'), 'option', '窓清掃', 1, '回', 12000, 'FREQ=MONTHLY;INTERVAL=3', 2
  from unnest(array['qA-sub', 'qA-app', 'qA-rej', 'qA-subOther']) q;
  insert into public.quote_lines (id, tenant_id, quote_id, item_id, line_kind, name, qty, unit, unit_price, sort) values
    (tests.id('ln:qA-draft:1'), ta, tests.id('qA-draft'), null, 'one_time', '共用部の清掃', 2, '回', 5000, 1),
    (tests.id('ln:qA-draft:2'), ta, tests.id('qA-draft'), tests.id('itemA-opt'), 'one_time', '窓清掃', 1, '回', 12000, 2),
    (tests.id('ln:qB-draft:1'), tb, tests.id('qB-draft'), null, 'one_time', 'B の清掃', 1, '回', 8000, 1);
  insert into public.quote_lines (id, tenant_id, quote_id, item_id, line_kind, name, qty, unit, unit_price, recurrence, sort) values
    (tests.id('ln:qB-sub:base'), tb, tests.id('qB-sub'), tests.id('itemB-base'), 'base', '定期清掃（月額）B', 1, '月', 30000, 'FREQ=MONTHLY', 1);
  -- 外部の人 extA が許された建物 A1 の見積（型 D の確かめ用）：提出・承認は見える、下書き・不成立は見えない
  insert into public.quotes (id, tenant_id, client_id, building_id, kind, status, number, issue_date, valid_until, tax_rate,
                             subtotal, tax, total, submitted_at, decided_at, decided_by) values
    (tests.id('qA1-sub'), ta, tests.id('clientA4'), tests.id('buildingA1'), 'recurring', 'submitted', 'Q-2025-0005', date '2025-12-01', date '2025-12-31', 0.1, 30000, 3000, 33000, now(), null, null),
    (tests.id('qA1-app'), ta, tests.id('clientA4'), tests.id('buildingA1'), 'recurring', 'approved', 'Q-2025-0006', date '2025-12-01', date '2025-12-31', 0.1, 30000, 3000, 33000, now(), now(), tests.u('adminA')),
    (tests.id('qA1-rej'), ta, tests.id('clientA4'), tests.id('buildingA1'), 'recurring', 'rejected', 'Q-2025-0007', date '2025-12-01', date '2025-12-31', 0.1, 30000, 3000, 33000, now(), now(), tests.u('adminA'));
  insert into public.quotes (id, tenant_id, client_id, building_id, kind, status, tax_rate) values
    (tests.id('qA1-draft'), ta, tests.id('clientA4'), tests.id('buildingA1'), 'request', 'draft', 0.1);
  insert into public.quote_lines (id, tenant_id, quote_id, item_id, line_kind, name, qty, unit, unit_price, recurrence, sort)
  select tests.id('ln:' || q || ':base'), ta, tests.id(q), tests.id('itemA-base'), 'base', '定期清掃（月額）', 1, '月', 30000, 'FREQ=MONTHLY', 1
  from unnest(array['qA1-sub', 'qA1-app', 'qA1-rej']) q;
  insert into public.quote_lines (id, tenant_id, quote_id, line_kind, name, qty, unit, unit_price, sort) values
    (tests.id('ln:qA1-draft:1'), ta, tests.id('qA1-draft'), 'one_time', '下書きの清掃', 1, '回', 1000, 1);
end $$;
select plan(1);
select pass('004 の種を入れた');
select * from finish();
