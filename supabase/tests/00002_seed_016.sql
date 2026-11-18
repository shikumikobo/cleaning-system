-- 機能 016 の種：費用（手で入れる外注・材料・その他）を会社 A・B に1行ずつ。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
-- 建物・契約には付けない（共通の費用）。002・010・011 のテストの数を変えないため。
create or replace function tests.seed_016() returns void language plpgsql as $$
begin
  insert into public.costs (id, tenant_id, month, kind, amount, note) values
    (tests.id('costA16'), tests.t('A'), date '2026-01-01', 'other', 3000, '事務所の消耗品（共通）'),
    (tests.id('costB16'), tests.t('B'), date '2026-01-01', 'other', 4000, '事務所の消耗品（共通）');
end $$;
select plan(1);
select pass('016 の種を入れた');
select * from finish();
