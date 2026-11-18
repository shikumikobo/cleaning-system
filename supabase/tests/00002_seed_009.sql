-- 機能 009 の種：ひな形・項目・報告書・報告書の項目（会社 A・B）。tests.seed() の最後から呼ばれる。
-- 00000_helpers.sql と同じく、この1本は rollback せず、関数を残す。
--   会社 A：建物 A10 のひな形 tplA10（項目 3 つ：場所つき・場所なし・使わない）、建物 A1 のひな形 tplA1、
--           作業 wA10（担当：スタッフA・社員A）の下書きの報告書 rA10（項目 2 つ）
--   会社 B：建物 B10 のひな形 tplB10（項目 1 つ）、作業 wB10（担当：スタッフB）の下書きの報告書 rB10（項目 1 つ）
-- 確認済み・提出済みの報告書は、各テストが自分の作業・報告書を作って確かめる（010 の作業・担当の件数を変えないため）。
create or replace function tests.seed_009() returns void language plpgsql as $$
declare ta uuid := tests.t('A'); tb uuid := tests.t('B');
begin
  insert into public.building_areas (id, tenant_id, building_id, name, sort) values
    (tests.id('areaA10'), ta, tests.id('buildingA10'), 'A10ロビー', 1);
  insert into public.report_templates (id, tenant_id, building_id, name) values
    (tests.id('tplA10'), ta, tests.id('buildingA10'), 'A10の定期清掃'),
    (tests.id('tplA1'), ta, tests.id('buildingA1'), 'A1の定期清掃'),
    (tests.id('tplB10'), tb, tests.id('buildingB10'), 'B10の定期清掃');
  insert into public.template_items (id, tenant_id, template_id, area_id, name, sort, active) values
    (tests.id('tiA10-1'), ta, tests.id('tplA10'), tests.id('areaA10'), 'エントランスの床', 1, true),
    (tests.id('tiA10-2'), ta, tests.id('tplA10'), null, 'ゴミ置き場', 2, true),
    (tests.id('tiA10-off'), ta, tests.id('tplA10'), null, 'もう使わない項目', 3, false),
    (tests.id('tiA1-1'), ta, tests.id('tplA1'), null, 'A1の共用部', 1, true),
    (tests.id('tiB10-1'), tb, tests.id('tplB10'), null, 'B10の共用部', 1, true);
  insert into public.reports (id, tenant_id, work_id, template_id, remarks) values
    (tests.id('rA10'), ta, tests.id('wA10'), tests.id('tplA10'), 'A10の下書き'),
    (tests.id('rB10'), tb, tests.id('wB10'), tests.id('tplB10'), 'B10の下書き');
  insert into public.report_items (id, tenant_id, report_id, template_item_id, area_id, name, sort, done, note) values
    (tests.id('riA10-1'), ta, tests.id('rA10'), tests.id('tiA10-1'), tests.id('areaA10'), 'エントランスの床', 1, true, '拭いた'),
    (tests.id('riA10-2'), ta, tests.id('rA10'), tests.id('tiA10-2'), null, 'ゴミ置き場', 2, false, ''),
    (tests.id('riB10-1'), tb, tests.id('rB10'), tests.id('tiB10-1'), null, 'B10の共用部', 1, true, '');
end $$;
select plan(1);
select pass('009 の種を入れた');
select * from finish();
