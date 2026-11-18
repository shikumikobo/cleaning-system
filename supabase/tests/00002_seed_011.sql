-- 機能 011 の種：専用の取引先（A11・B11）に、請求書（状況ごと）・明細・入金（会社 A・B）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
-- 既存の取引先・建物・契約・作業・案件には、請求書を付けない（002・003・010 のテストを変えないため）。明細の元は、契約の中身の鍵（service_key）だけを使う。
create or replace function tests.seed_011() returns void language plpgsql as $$
declare ta uuid := tests.t('A'); tb uuid := tests.t('B');
begin
  insert into public.clients (id, tenant_id, kind, name) values
    (tests.id('clientA11'), ta, 'management_company', 'テスト請求先A'),
    (tests.id('clientB11'), tb, 'management_company', 'テスト請求先B');
  insert into public.invoices (id, tenant_id, client_id, period, number, issue_date, due_date, tax_rate, subtotal, tax, total, status, issued_at, sent_at, cancelled_at, cancel_reason) values
    (tests.id('iA-draft'), ta, tests.id('clientA11'), date '2026-02-01', null, null, null, 0.1, 0, 0, 0, 'draft', null, null, null, null),
    (tests.id('iA-issued'), ta, tests.id('clientA11'), date '2026-03-01', 'I-2025-0001', date '2026-04-01', date '2026-04-30', 0.1, 40000, 4000, 44000, 'issued', now(), null, null, null),
    (tests.id('iA-sent'), ta, tests.id('clientA11'), date '2026-04-01', 'I-2025-0002', date '2026-05-01', date '2026-05-31', 0.1, 30000, 3000, 33000, 'sent', now(), now(), null, null),
    (tests.id('iA-partial'), ta, tests.id('clientA11'), date '2026-05-01', 'I-2025-0003', date '2026-06-01', date '2026-06-30', 0.1, 20000, 2000, 22000, 'partial', now(), now(), null, null),
    (tests.id('iA-paid'), ta, tests.id('clientA11'), date '2026-06-01', 'I-2025-0004', date '2026-07-01', date '2026-07-31', 0.1, 20000, 2000, 22000, 'paid', now(), now(), null, null),
    (tests.id('iA-cancel'), ta, tests.id('clientA11'), date '2026-03-01', 'I-2025-0005', date '2026-04-01', date '2026-04-30', 0.1, 10000, 1000, 11000, 'cancelled', now(), null, now(), '二重に出した'),
    (tests.id('iB-issued'), tb, tests.id('clientB11'), date '2026-03-01', 'I-2025-0001', date '2026-04-01', date '2026-04-30', 0.1, 25000, 2500, 27500, 'issued', now(), null, null, null);
  insert into public.invoice_lines (id, tenant_id, invoice_id, service_key, service_month, name, qty, unit, unit_price, sort) values
    (tests.id('lA-draft1'), ta, tests.id('iA-draft'), tests.id('key:A11-1'), date '2026-02-01', '定期清掃', 1, '月', 30000, 1),
    (tests.id('lA-draft2'), ta, tests.id('iA-draft'), tests.id('key:A11-2'), date '2026-02-01', '共用部の清掃', 2, '回', 5000, 2),
    (tests.id('lA-issued1'), ta, tests.id('iA-issued'), tests.id('key:A11-1'), date '2026-03-01', '定期清掃', 1, '月', 30000, 1),
    (tests.id('lA-issued2'), ta, tests.id('iA-issued'), tests.id('key:A11-2'), date '2026-03-01', '共用部の清掃', 2, '回', 5000, 2),
    (tests.id('lA-sent1'), ta, tests.id('iA-sent'), tests.id('key:A11-1'), date '2026-04-01', '定期清掃', 1, '月', 30000, 1),
    (tests.id('lA-partial1'), ta, tests.id('iA-partial'), tests.id('key:A11-1'), date '2026-05-01', '定期清掃', 1, '月', 20000, 1),
    (tests.id('lA-paid1'), ta, tests.id('iA-paid'), tests.id('key:A11-1'), date '2026-06-01', '定期清掃', 1, '月', 20000, 1),
    (tests.id('lB-issued1'), tb, tests.id('iB-issued'), tests.id('key:B11-1'), date '2026-03-01', '定期清掃（B）', 1, '月', 25000, 1);
  insert into public.invoice_lines (id, tenant_id, invoice_id, service_key, service_month, name, qty, unit, unit_price, sort, deleted_at) values
    (tests.id('lA-cancel1'), ta, tests.id('iA-cancel'), tests.id('key:A11-1'), date '2026-03-01', '定期清掃', 1, '月', 10000, 1, now());
  insert into public.payments (id, tenant_id, invoice_id, paid_on, amount, note) values
    (tests.id('pA-partial'), ta, tests.id('iA-partial'), date '2026-06-20', 10000, '内金'),
    (tests.id('pA-paid'), ta, tests.id('iA-paid'), date '2026-07-20', 22000, null),
    (tests.id('pB-1'), tb, tests.id('iB-issued'), date '2026-04-20', 10000, '内金');
end $$;
select plan(1);
select pass('011 の種を入れた');
select * from finish();
