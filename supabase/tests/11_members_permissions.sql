-- 所属と役割（R-001-14〜18）、権限と役割の割り当て（R-001-24・25）
begin;
select * from no_plan();
select tests.seed();

-- R-001-24 役割ごとの権限は、data-model.md の表のとおり
create or replace function pg_temp.perms(p_role text) returns text language sql as $$
  select coalesce(string_agg(p.code, ',' order by p.code), '') from public.role_permissions rp
  join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = p_role
$$;
select is((select count(*)::int from public.permissions), 10, 'R-001-24 権限は10個');
select is(pg_temp.perms('admin'), 'amount.read,cash.manage,contract.edit,field.record,invoice.edit,master.edit,quote.edit,request.edit,user.manage,work.assign',
          'R-001-24 管理者は全部の権限を持つ');
select is(pg_temp.perms('member'), 'amount.read,cash.manage,contract.edit,field.record,invoice.edit,master.edit,quote.edit,request.edit,work.assign',
          'R-001-24 社員は利用者の管理のほか全部の権限を持つ');
select is(pg_temp.perms('staff'), 'field.record', 'R-001-24 スタッフは現場の記録（field.record）だけ');
select is(pg_temp.perms('external'), '', 'R-001-24 外部の人は権限を持たない');
select is((select count(*)::int from public.roles), 4, 'R-001-24 役割は4つ（管理者・社員・スタッフ・外部）');

-- has_perm が、役割どおりに答える
select is(tests.run_as(tests.u('adminA'), format('select public.has_perm(%L, ''user.manage'') as v', tests.t('A'))) -> 'rows' -> 0 ->> 'v', 'true', 'R-001-24 管理者は user.manage を持つ');
select is(tests.run_as(tests.u('memberA'), format('select public.has_perm(%L, ''user.manage'') as v', tests.t('A'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-001-24 社員は user.manage を持たない');
select is(tests.run_as(tests.u('memberA'), format('select public.has_perm(%L, ''amount.read'') as v', tests.t('A'))) -> 'rows' -> 0 ->> 'v', 'true', 'R-001-24 社員は amount.read を持つ');
select is(tests.run_as(tests.u('staffA'), format('select public.has_perm(%L, ''amount.read'') as v', tests.t('A'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-001-25 スタッフは金額を読む権限を持たない');
select is(tests.run_as(tests.u('extA'), format('select public.has_perm(%L, ''field.record'') as v', tests.t('A'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-001-25 外部の人は権限を持たない');
select is(tests.run_as(tests.u('adminA'), format('select public.has_perm(%L, ''user.manage'') as v', tests.t('B'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-001-19 A の管理者は、B で権限を持たない');
select is(tests.run_as(tests.u('multi'), format('select public.has_perm(%L, ''user.manage'') as v', tests.t('B'))) -> 'rows' -> 0 ->> 'v', 'true', 'R-001-17 2つの会社の人は、B では管理者として判定される');
select is(tests.run_as(tests.u('multi'), format('select public.has_perm(%L, ''user.manage'') as v', tests.t('A'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-001-17 2つの会社の人は、A では社員として判定される');

-- 役割と権限の表は、全員が読めるが、だれも書けない
select ok(tests.n(tests.u('staffA'), 'select 1 from public.role_permissions') > 0, 'R-001-24 役割と権限の表は、ログインした人が読める');
select is(tests.err(tests.u('adminA'), format('insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = ''staff'' and p.code = ''amount.read''')), '42501',
          'R-001-24 管理者も、役割の権限を直接は変えられない（マイグレーションだけ）');

-- R-001-14 役割を変えたら、次の操作から新しい役割で判定する
select is(tests.n(tests.u('staffA'), format('select 1 from public.job_runs where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-001-14 変更前：スタッフは処理の記録を読めない');
select is(tests.err(tests.u('adminA'), format('select public.change_member_role(%L, ''admin'')', tests.id('m:A:staffA'))), null, 'R-001-14 管理者は人の役割を変えられる');
select is(tests.n(tests.u('staffA'), format('select 1 from public.job_runs where tenant_id = %L', tests.t('A'))), 1::bigint, 'R-001-14 変更の次の操作から、管理者の権限で判定される');
select is(tests.err(tests.u('adminA'), format('select public.change_member_role(%L, ''staff'')', tests.id('m:A:staffA'))), null, 'R-001-14 元に戻せる');
select is(tests.n(tests.u('staffA'), format('select 1 from public.job_runs where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-001-14 戻したあとは、すぐスタッフの権限で判定される');
select is(tests.err(tests.u('memberA'), format('select public.change_member_role(%L, ''admin'')', tests.id('m:A:staffA'))), '42501', 'R-001-14 管理者でない人は役割を変えられない');
select is(tests.err(tests.u('adminB'), format('select public.change_member_role(%L, ''admin'')', tests.id('m:A:staffA'))), '42501', 'R-001-14 別の会社の管理者は役割を変えられない');
select is(tests.err(tests.u('adminA'), format('select public.change_member_role(%L, ''boss'')', tests.id('m:A:staffA'))), '22023', 'R-001-14 役割の名前が違えば変えない');
select is(tests.cnt(tests.u('adminA'), format('update public.memberships set role_id = (select id from public.roles where code = ''admin'') where id = %L', tests.id('m:A:staffA'))), -1::bigint,
          'R-001-23 管理者も、所属を直接は書き換えられない（RPC だけ）');

-- R-001-15 止めたら、次の操作から読めず・書けない
select is(tests.n(tests.u('staffA'), format('select 1 from public.offices where tenant_id = %L', tests.t('A'))), 1::bigint, 'R-001-15 止める前：スタッフは会社のデータを読める');
select is(tests.err(tests.u('adminA'), format('select public.set_member_status(%L, ''suspended'')', tests.id('m:A:staffA'))), null, 'R-001-15 管理者は人を止められる');
select is(tests.n(tests.u('staffA'), format('select 1 from public.offices where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-001-15 止めた人は、次の操作から会社のデータを読めない');
select is(tests.n(tests.u('staffA'), format('select 1 from public.tenants where id = %L', tests.t('A'))), 0::bigint, 'R-001-15 止めた人は、会社の情報も読めない');
select is(tests.n(tests.u('staffA'), format('select 1 from public.client_error_logs where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-001-15 止めた人は、自分の端末のエラーの行も読めない');
select is(tests.err(tests.u('staffA'), format('insert into public.client_error_logs (tenant_id, membership_id, device_id, kind, message) values (%L, %L, ''d'', ''sync_failed'', ''x'')', tests.t('A'), tests.id('m:A:staffA'))), '42501',
          'R-001-15 止めた人は、会社のデータを書けない');
select is(tests.run_as(tests.u('staffA'), format('select public.has_perm(%L, ''field.record'') as v', tests.t('A'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-001-15 止めた人は、権限を持たない');
select is(tests.err(tests.u('adminA'), format('select public.set_member_status(%L, ''active'')', tests.id('m:A:staffA'))), null, 'R-001-15 止めた人を、もう一度有効にできる');
select is(tests.n(tests.u('staffA'), format('select 1 from public.offices where tenant_id = %L', tests.t('A'))), 1::bigint, 'R-001-15 有効に戻すと、すぐ読める');
select is(tests.err(tests.u('memberA'), format('select public.set_member_status(%L, ''suspended'')', tests.id('m:A:staffA'))), '42501', 'R-001-15 管理者でない人は人を止められない');

-- R-001-17 複数の会社に所属している人
select is(tests.n(tests.u('multi'), 'select 1 from public.tenants'), 2::bigint, 'R-001-17 2つの会社の人は、所属する2つの会社を読める（切り替えの一覧）');
select is(tests.n(tests.u('multi'), format('select 1 from public.offices where tenant_id = %L', tests.t('A'))), 1::bigint, 'R-001-17 選んだ会社（A）の拠点だけが出る');
select is(tests.run_as(tests.u('multi'), format('select name from public.offices where tenant_id = %L', tests.t('B'))) -> 'rows' -> 0 ->> 'name', '本社B', 'R-001-17 選んだ会社（B）の拠点だけが出る');
select is(tests.n(tests.u('multi'), format('select 1 from public.memberships where tenant_id = %L', tests.t('A'))), 1::bigint, 'R-001-17 管理者でない会社（A）では、本人の所属だけが見える');
select is(tests.n(tests.u('multi'), format('select 1 from public.memberships where tenant_id = %L', tests.t('B'))), 4::bigint, 'R-001-17 管理者の会社（B）では、会社の全員の所属が見える');

-- R-001-18 外部の人が見られる建物
select is(tests.n(tests.u('extA'), 'select 1 from public.external_building_access'), 1::bigint, 'R-001-18 外部の人は、自分に許された建物の行だけ読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.external_building_access'), 0::bigint, 'R-001-18 外部の人でも管理者でもない人は読めない');
select is(tests.err(tests.u('adminB'), format('select public.set_external_building_access(%L, array[%L]::uuid[])', tests.id('m:A:extA'), tests.id('x'))), '42501', 'R-001-18 別の会社の管理者は決められない');
select is(tests.err(tests.u('memberA'), format('select public.set_external_building_access(%L, array[%L]::uuid[])', tests.id('m:A:extA'), tests.id('x'))), '42501', 'R-001-18 管理者でない人は決められない');
select is(tests.err(tests.u('multi'), format('select public.set_external_building_access(%L, array[%L]::uuid[])', tests.id('m:A:extA'), tests.id('x'))), '42501', 'R-001-18 その会社で管理者でない人は決められない');
select is(tests.err(tests.u('adminA'), format('select public.set_external_building_access(%L, array[%L]::uuid[])', tests.id('m:A:staffA'), tests.id('x'))), '22023', 'R-001-18 外部の人でない所属には決められない');
select is(tests.err(tests.u('adminA'), format('select public.set_external_building_access(%L, array[%L, %L]::uuid[])', tests.id('m:A:extA'), tests.id('buildingA1'), tests.id('buildingA2'))), null, 'R-001-18 管理者は、外部の人が見られる建物を決められる');
select is(tests.n(tests.u('extA'), 'select 1 from public.external_building_access'), 2::bigint, 'R-001-18 決めた建物だけが外部の人に見える（2つ）');
select is(tests.err(tests.u('adminA'), format('select public.set_external_building_access(%L, array[%L]::uuid[])', tests.id('m:A:extA'), tests.id('buildingA2'))), null, 'R-001-18 建物を減らせる');
select is(tests.n(tests.u('extA'), format('select 1 from public.external_building_access where deleted_at is null')), 1::bigint, 'R-001-18 外された建物は、外部の人から見えなくなる');
select is(tests.run_as(tests.u('extA'), format('select app.can_external_see_building(%L, %L) as v', tests.t('A'), tests.id('buildingA2'))) -> 'rows' -> 0 ->> 'v', 'true', 'R-001-18 外部の人は許された建物を見られる');
select is(tests.run_as(tests.u('extA'), format('select app.can_external_see_building(%L, %L) as v', tests.t('A'), tests.id('buildingA1'))) -> 'rows' -> 0 ->> 'v', 'false', 'R-001-18 外部の人は許されていない建物を見られない');

-- 人（profiles）：同じ会社の人（外部を除く）と本人だけ
select is(tests.n(tests.u('staffA'), 'select 1 from public.profiles'), 4::bigint, '人：スタッフは、同じ会社の有効な人（外部を除く。A は管理者・社員・multi と本人）を読める');
select is(tests.n(tests.u('staffA'), format('select 1 from public.profiles where id = %L', tests.u('extA'))), 0::bigint, '人：外部の人の名前は、会社の中の人にも見えない');
select is(tests.n(tests.u('extA'), 'select 1 from public.profiles'), 1::bigint, '人：外部の人が読めるのは本人だけ');
select is(tests.n(tests.u('adminB'), format('select 1 from public.profiles where id = %L', tests.u('adminA'))), 0::bigint, '人：別の会社の人の名前は読めない');
select is(tests.cnt(tests.u('staffA'), format('update public.profiles set display_name = ''本人'' where id = %L', tests.u('staffA'))), 1::bigint, '人：本人は表示名を直せる');
select is(tests.cnt(tests.u('staffA'), format('update public.profiles set display_name = ''他人'' where id = %L', tests.u('memberA'))), 0::bigint, '人：他人の表示名は直せない');

-- R-001-16 最後の管理者は、止めたり管理者以外にしたりできない
select is(tests.err(tests.u('adminA'), format('select public.set_member_status(%L, ''suspended'')', tests.id('m:A:adminA'))), 'P0002', 'R-001-16 有効な管理者が1人だけなら、止められない');
select is(tests.err(tests.u('adminA'), format('select public.change_member_role(%L, ''member'')', tests.id('m:A:adminA'))), 'P0002', 'R-001-16 有効な管理者が1人だけなら、管理者以外にできない');
select is(tests.err(tests.u('adminA'), format('select public.change_member_role(%L, ''admin'')', tests.id('m:A:memberA'))), null, '2人目の管理者を作れる');
select is(tests.err(tests.u('adminA'), format('select public.set_member_status(%L, ''suspended'')', tests.id('m:A:adminA'))), null, 'R-001-16 管理者が2人いれば、1人を止められる');
select is(tests.err(tests.u('memberA'), format('select public.change_member_role(%L, ''member'')', tests.id('m:A:memberA'))), 'P0002', 'R-001-16 残った最後の管理者は、自分でも管理者以外にできない');
select is(tests.err(tests.u('memberA'), format('select public.set_member_status(%L, ''suspended'')', tests.id('m:A:memberA'))), 'P0002', 'R-001-16 残った最後の管理者は、自分を止められない');


select * from finish();
rollback;
