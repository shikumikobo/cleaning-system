-- 機能 008：気づきの写真から案件を作る（R-008-13〜15）。003 の RPC に p_photo_ids を足した
begin;
select * from no_plan();
select tests.seed();

select tests.make_user('staff2A');
select tests.make_member('A', 'staff2A', 'staff');

create or replace function pg_temp.obs(p_uid uuid, p_req text, p_building text, p_photos text[]) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  v := tests.run_as(p_uid, format($q$select public.create_request_from_observation(%L, %L, '廊下の天井にしみ', '3階', null, 'repair', %s) as r$q$,
    tests.id(p_req), tests.id(p_building),
    case when p_photos is null then 'null' else format('array[%s]::uuid[]', (select string_agg(quote_literal(tests.id(n)), ',') from unnest(p_photos) n)) end));
  if v ? 'error' then return jsonb_build_object('error', v ->> 'error'); end if;
  return v -> 'rows' -> 0 -> 'r';
end $$;
create or replace function pg_temp.reqs(p_req text) returns bigint language sql as $$
  select count(*) from public.requests where id = tests.id(p_req)
$$;
create or replace function pg_temp.linked(p_photo text) returns text language sql as $$
  select coalesce((select request_id::text from public.photos where id = tests.id(p_photo)), 'none')
$$;

-- ===== R-008-13 写真をつなげて案件を作る =====
select tests.make_photo('A', 'obs1', 'buildingA1', 'staffA', 'observation');
select tests.make_photo('A', 'obs2', 'buildingA1', 'staffA', 'observation');
select is(pg_temp.obs(tests.u('staffA'), 'req1', 'buildingA1', array['obs1', 'obs2']) ->> 'ok', 'true', 'R-008-13 スタッフは、自分の気づきの写真をつけて、案件を作れる');
select is(pg_temp.linked('obs1') || ',' || pg_temp.linked('obs2'), tests.id('req1')::text || ',' || tests.id('req1')::text, 'R-008-13 写真の request_id に、案件の ID が入る');
select is((select source || ',' || assignee_id::text from public.requests where id = tests.id('req1')), 'field,' || tests.id('m:A:staffA')::text, 'R-008-13 案件は 003 の決まりどおり（入口は現場、担当は本人）で作られる');
select is(pg_temp.obs(tests.u('staffA'), 'req1', 'buildingA1', array['obs1']) ->> 'photos', null, '（確かめの確認）二度目は写真の数を返さない（R-008-15 で確かめる）');
select is(pg_temp.obs(tests.u('staffA'), 'req2', 'buildingA1', null) ->> 'photos', '0', 'R-008-13 写真を付けなくても作れる（引数は省略できる。003 のとおり）');
select tests.make_photo('A', 'obs3', 'buildingA1', 'staffA', 'observation');
select is(pg_temp.obs(tests.u('staffA'), 'req3', 'buildingA1', array['obs3', 'obs3']) ->> 'photos', '1', 'R-008-13 同じ写真を2回並べても1枚としてつなぐ');
select tests.make_photo('A', 'obs4', 'buildingA1', 'staffA', 'observation');
select is(pg_temp.obs(tests.u('memberA'), 'req4', 'buildingA1', array['obs4']) ->> 'ok', 'true', 'R-008-13 work.assign を持つ社員は、他のスタッフが撮った気づきの写真も、案件につなげられる');
select is(pg_temp.linked('obs4'), tests.id('req4')::text, 'R-008-13 つながる');
select is(tests.n(tests.u('staffA'), format('select 1 from public.photos where request_id = %L', tests.id('req1'))), 2::bigint, 'R-008-13 つないだ写真は、案件ごとに引ける（request_id）');
select is(tests.err(tests.u('staffA'), format('update public.photos set request_id = null where id = %L', tests.id('obs1'))), '42501', 'R-008-13 つないだあと、直接は外せない（つなぎは RPC だけ）');

-- ===== R-008-14 つなげられない写真は、案件ごと戻す =====
select tests.make_photo('A', 'before1', 'buildingA1', 'staffA', 'before');
select is(pg_temp.obs(tests.u('staffA'), 'r14a', 'buildingA1', array['before1']) ->> 'error', '22023', 'R-008-14 気づきでない写真（前・後）は、つなげられない');
select is(pg_temp.reqs('r14a'), 0::bigint, 'R-008-14 そのとき案件は作られない');
select tests.make_photo('A', 'obsB2', 'buildingA2', 'staffA', 'observation');
select is(pg_temp.obs(tests.u('staffA'), 'r14b', 'buildingA1', array['obsB2']) ->> 'error', '22023', 'R-008-14 案件の建物と違う建物の写真は、つなげられない');
select is(pg_temp.obs(tests.u('staffA'), 'r14c', 'buildingA1', array['obs1']) ->> 'error', '22023', 'R-008-14 すでに別の案件につながっている写真は、つなげられない');
select is(pg_temp.reqs('r14b') + pg_temp.reqs('r14c'), 0::bigint, 'R-008-14 どちらも案件は作られない');
select is(pg_temp.obs(tests.u('staff2A'), 'r14d', 'buildingA1', array['obs3']) ->> 'error', '42501', 'R-008-14 ほかのスタッフの写真は、つなげられない（読めない・直せない）');
select tests.make_photo('A', 'obs5', 'buildingA1', 'staffA', 'observation');
update public.photos set deleted_at = now() where id = tests.id('obs5');
select is(pg_temp.obs(tests.u('staffA'), 'r14e', 'buildingA1', array['obs5']) ->> 'error', '42501', 'R-008-14 消した写真は、つなげられない');
select is(pg_temp.obs(tests.u('staffA'), 'r14f', 'buildingA1', array[md5('id:no-such-photo')]) ->> 'error', '42501', 'R-008-14 ない写真は、つなげられない');
select is(pg_temp.obs(tests.u('staffA'), 'r14g', 'buildingA1', array['photoB-staff']) ->> 'error', '42501', 'R-008-14 別の会社の写真は、つなげられない（ない写真と同じ答え）');
-- 1枚でも合わなければ、全部を戻す
select tests.make_photo('A', 'obs6', 'buildingA1', 'staffA', 'observation');
select is(pg_temp.obs(tests.u('staffA'), 'r14h', 'buildingA1', array['obs6', 'before1']) ->> 'error', '22023', 'R-008-14 合わない写真が1枚でもあれば、断る');
select is(pg_temp.reqs('r14h') || ',' || pg_temp.linked('obs6'), '0,none', 'R-008-14 案件は作られず、合っていたほうの写真もつながらない（全部を戻す）');
-- 報告書の固定（009 の本物：提出済みの報告書の項目の写真）
insert into public.works (id, tenant_id, building_id, contract_service_id, service_key, title, scheduled_date, status)
  values (tests.id('workL'), tests.t('A'), tests.id('buildingA1'), tests.id('svcA1-base'), tests.id('key:A1-base'), '固定のテスト用の作業', current_date + 31, 'scheduled');
insert into public.work_assignments (id, tenant_id, work_id, membership_id) values (tests.id('waL-staffA'), tests.t('A'), tests.id('workL'), tests.id('m:A:staffA'));
insert into public.reports (id, tenant_id, work_id, status, checked_by, checked_at, submitted_by, submitted_at)
  values (tests.id('rL'), tests.t('A'), tests.id('workL'), 'submitted', tests.id('m:A:memberA'), now(), tests.id('m:A:memberA'), now());
insert into public.report_items (id, tenant_id, report_id, name) values (tests.id('item-locked'), tests.t('A'), tests.id('rL'), '固定された項目');
select tests.make_photo('A', 'obsL', 'buildingA1', 'staffA', 'observation', format('work_id, report_item_id|%L, %L', tests.id('workL'), tests.id('item-locked')));
select is(pg_temp.obs(tests.u('staffA'), 'r14i', 'buildingA1', array['obsL']) ->> 'error', '42501', 'R-008-14 提出・確認のあとの報告書の写真は、つなげられない');
select is(pg_temp.obs(tests.u('extA'), 'r14j', 'buildingA1', array['obs6']) ->> 'error', '42501', 'R-008-14 外部の人は呼べない');
select is(pg_temp.obs(tests.u('nobody'), 'r14k', 'buildingA1', array['obs6']) ->> 'error', '42501', 'R-008-14 どの会社にも属さない人は呼べない');
select is(coalesce(tests.run_as_anon(format('select public.create_request_from_observation(%L, %L, ''x'')', tests.id('r14l'), tests.id('buildingA1'))) ->> 'error', 'ok'), '42501', 'R-008-14 ログインしていない人は呼べない');

-- ===== R-008-15 二度呼んでも1件 =====
select tests.make_photo('A', 'obs7', 'buildingA1', 'staffA', 'observation');
select is(pg_temp.obs(tests.u('staffA'), 'req1', 'buildingA1', array['obs7']) ->> 'already', 'true', 'R-008-15 同じ uuid の二度目は、前の結果（already）を返す');
select is(pg_temp.linked('obs7'), 'none', 'R-008-15 二度目は、写真に触らない');
select is((select count(*)::int from public.requests where id = tests.id('req1')), 1, 'R-008-15 案件は1件だけ');
select is(pg_temp.obs(tests.u('memberA'), 'req1', 'buildingA1', array['obs7']) ->> 'error', '42501', 'R-008-15 別の人が作った uuid では呼べない');

select * from finish();
rollback;
