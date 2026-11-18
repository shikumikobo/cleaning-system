-- policy の型（A・B・C1・C2・D・E）を、その場で作った表に付け、型ごとの決まりを確かめる。
-- 後の機能の本物の表は、01・02 が自動で見る。ここは「型の関数そのものが正しい」ことを確かめる。
begin;
select * from no_plan();
select tests.seed();

create table public.t_parent (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id), unique (tenant_id, id));
create table public.t_child (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id), parent_id uuid not null,
  foreign key (tenant_id, parent_id) references public.t_parent (tenant_id, id));

create table public.t_a (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id), v text,
  status text not null default 'draft', created_at timestamptz default now(), created_by uuid, updated_at timestamptz default now(), updated_by uuid,
  unique (tenant_id, id));
select app.apply_policy('public.t_a', 'A', '{"write_perm": "master.edit", "lock_sql": "status = ''draft''"}');

create table public.t_b (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id), amount int,
  unique (tenant_id, id));
select app.apply_policy('public.t_b', 'B', '{"write_perm": "quote.edit"}');

create table public.t_c1 (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id),
  membership_id uuid not null, v text, unique (tenant_id, id),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id));
select app.apply_policy('public.t_c1', 'C1', '{}');

create table public.t_assign (work_id uuid, membership_id uuid);
create function public.t_assigned(p_tenant uuid, p_work uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.t_assign a join public.memberships m on m.id = a.membership_id
                 where a.work_id = p_work and m.tenant_id = p_tenant and m.user_id = (select auth.uid()) and m.status = 'active')
$$;
grant execute on function public.t_assigned(uuid, uuid) to authenticated;
create table public.t_c2 (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id),
  work_id uuid not null, v text, status text not null default 'draft', unique (tenant_id, id));
select app.apply_policy('public.t_c2', 'C2', '{"scope_fn": "public.t_assigned", "lock_sql": "status = ''draft''"}');

create table public.t_d (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id),
  building_id uuid not null, v text, unique (tenant_id, id));
select app.apply_policy('public.t_d', 'A', '{"write_perm": "master.edit", "external_read": "app.can_external_see_building(tenant_id, building_id)"}');

create table public.t_e (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id), v text,
  unique (tenant_id, id));
select app.apply_policy('public.t_e', 'E', '{}');

-- 種
insert into public.t_parent (id, tenant_id) values (tests.id('pA'), tests.t('A')), (tests.id('pB'), tests.t('B'));
insert into public.t_a (id, tenant_id, v, status) values
  (tests.id('aA'), tests.t('A'), 'a', 'draft'), (tests.id('aA-sub'), tests.t('A'), 'a', 'submitted'), (tests.id('aB'), tests.t('B'), 'b', 'draft');
insert into public.t_b (id, tenant_id, amount) values (tests.id('bA'), tests.t('A'), 100), (tests.id('bB'), tests.t('B'), 200);
insert into public.t_c1 (id, tenant_id, membership_id, v) values
  (tests.id('c1-staff'), tests.t('A'), tests.id('m:A:staffA'), 's'), (tests.id('c1-member'), tests.t('A'), tests.id('m:A:memberA'), 'm'),
  (tests.id('c1-B'), tests.t('B'), tests.id('m:B:staffB'), 'b');
insert into public.t_assign values (tests.id('w1'), tests.id('m:A:staffA'));
insert into public.t_c2 (id, tenant_id, work_id, v) values
  (tests.id('c2-w1'), tests.t('A'), tests.id('w1'), 'x'), (tests.id('c2-w2'), tests.t('A'), tests.id('w2'), 'y'),
  (tests.id('c2-B'), tests.t('B'), tests.id('w3'), 'z');
insert into public.t_d (id, tenant_id, building_id, v) values
  (tests.id('d-b1'), tests.t('A'), tests.id('buildingA1'), 'one'), (tests.id('d-b2'), tests.t('A'), tests.id('buildingA2'), 'two'),
  (tests.id('d-B'), tests.t('B'), tests.id('buildingB1'), 'b');
insert into public.t_e (id, tenant_id, v) values (tests.id('eA'), tests.t('A'), 'e'), (tests.id('eB'), tests.t('B'), 'e');

-- 型の登録
select is((select policy_type from app.policy_registry where table_name = 't_d'), 'A+D', 'R-001-22 型 D は A に足した形（A+D）で登録される');
select is((select policy_type from app.policy_registry where table_name = 't_c2'), 'C2', 'R-001-22 型 C2 が登録される');

-- R-001-20 親子は同じ会社
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
select is(pg_temp.try(format('insert into public.t_child (tenant_id, parent_id) values (%L, %L)', tests.t('A'), tests.id('pA'))), 'ok', 'R-001-20 同じ会社の親を指す子は作れる');
select is(pg_temp.try(format('insert into public.t_child (tenant_id, parent_id) values (%L, %L)', tests.t('A'), tests.id('pB'))), '23503', 'R-001-20 別の会社の親を指す子は作れない');

-- 型 A
select is(tests.n(tests.u('memberA'), 'select 1 from public.t_a'), 2::bigint, 'R-001-19 型 A：社員は自分の会社の行だけ読める（B の行は読めない）');
select is(tests.n(tests.u('staffA'), 'select 1 from public.t_a'), 2::bigint, 'R-001-19 型 A：スタッフも会社の中の人として読める');
select is(tests.n(tests.u('extA'), 'select 1 from public.t_a'), 0::bigint, 'R-001-19 型 A：外部の人は読めない');
select is(tests.err(tests.u('memberA'), format('insert into public.t_a (tenant_id, v) values (%L, ''n'')', tests.t('A'))), null, 'R-001-23 型 A：master.edit を持つ人は作れる');
select is(tests.err(tests.u('staffA'), format('insert into public.t_a (tenant_id, v) values (%L, ''n'')', tests.t('A'))), '42501', 'R-001-23 型 A：master.edit のない人は作れない');
select is(tests.err(tests.u('memberA'), format('insert into public.t_a (tenant_id, v) values (%L, ''n'')', tests.t('B'))), '42501', 'R-001-19 型 A：別の会社の行は作れない');
select is(tests.cnt(tests.u('staffA'), format('update public.t_a set v = ''z'' where id = %L', tests.id('aA'))), 0::bigint, 'R-001-23 型 A：master.edit のない人は直せない（0 行）');
select is(tests.cnt(tests.u('memberA'), format('update public.t_a set v = ''z'' where id = %L', tests.id('aA'))), 1::bigint, '型 A：master.edit を持つ人は下書きを直せる');
select is(tests.cnt(tests.u('memberA'), format('update public.t_a set v = ''z'' where id = %L', tests.id('aA-sub'))), 0::bigint, '型 A：lock_sql（下書きだけ）に合わない行は直せない');
select is(tests.err(tests.u('memberA'), format('update public.t_a set status = ''submitted'' where id = %L', tests.id('aA'))), '42501', '型 A：直したあとの行も lock_sql に合わなければ拒否（状況は RPC だけが変える）');
select is(tests.err(tests.u('memberA'), format('delete from public.t_a where id = %L', tests.id('aA'))), '42501', '型 A：削除はできない（論理削除だけ）');
-- 2つの会社に入っている人（multi）が、行を別の会社へ移せない
select is(tests.err(tests.u('multi'), format('update public.t_a set tenant_id = %L where id = %L', tests.t('B'), tests.id('aA'))), '42501',
          'R-001-19 型 A：2つの会社に入っている人も、行の会社は変えられない');
select is(tests.n(tests.u('multi'), format('select 1 from public.t_a where tenant_id = %L', tests.t('A'))), (select count(*) from public.t_a where tenant_id = tests.t('A')), 'R-001-17 2つの会社の人は、選んだ会社（A）の行を読める');
select is(tests.n(tests.u('multi'), format('select 1 from public.t_a where tenant_id = %L', tests.t('B'))), 1::bigint, 'R-001-17 2つの会社の人は、選んだ会社（B）の行を読める');

-- 型 B（金額）
select is(tests.n(tests.u('memberA'), 'select 1 from public.t_b'), 1::bigint, 'R-001-25 型 B：amount.read を持つ社員は読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.t_b'), 0::bigint, 'R-001-25 型 B：スタッフは読めない');
select is(tests.n(tests.u('extA'), 'select 1 from public.t_b'), 0::bigint, 'R-001-25 型 B：外部の人は読めない');
select is(tests.err(tests.u('staffA'), format('insert into public.t_b (tenant_id, amount) values (%L, 1)', tests.t('A'))), '42501', 'R-001-23 型 B：スタッフは作れない');
select is(tests.err(tests.u('memberA'), format('insert into public.t_b (tenant_id, amount) values (%L, 1)', tests.t('A'))), null, '型 B：quote.edit を持つ人は作れる');

-- 型 C1（本人）
select is(tests.n(tests.u('staffA'), 'select 1 from public.t_c1'), 1::bigint, 'R-001-19 型 C1：スタッフは自分の行だけ読める');
select is(tests.n(tests.u('memberA'), 'select 1 from public.t_c1'), 2::bigint, '型 C1：work.assign を持つ社員は、会社の全員の行を読める（B は読めない）');
select is(tests.n(tests.u('extA'), 'select 1 from public.t_c1'), 0::bigint, '型 C1：外部の人は読めない');
select is(tests.err(tests.u('staffA'), format('insert into public.t_c1 (tenant_id, membership_id) values (%L, %L)', tests.t('A'), tests.id('m:A:staffA'))), null, '型 C1：本人の行は作れる');
select is(tests.err(tests.u('staffA'), format('insert into public.t_c1 (tenant_id, membership_id) values (%L, %L)', tests.t('A'), tests.id('m:A:memberA'))), '42501', 'R-001-23 型 C1：他人の行は作れない');
select is(tests.cnt(tests.u('memberA'), format('update public.t_c1 set v = ''z'' where id = %L', tests.id('c1-staff'))), 0::bigint, '型 C1：全員分を読める人も、他人の行は直せない');
select is(tests.cnt(tests.u('staffA'), format('update public.t_c1 set v = ''z'' where id = %L', tests.id('c1-staff'))), 1::bigint, '型 C1：本人は自分の行を直せる');

-- 型 C2（作業の担当）
select is(tests.n(tests.u('staffA'), 'select 1 from public.t_c2'), 1::bigint, 'R-001-19 型 C2：スタッフは担当の作業の行だけ読める');
select is(tests.n(tests.u('memberA'), 'select 1 from public.t_c2'), 2::bigint, '型 C2：work.assign を持つ社員は、会社の全員の行を読める');
select is(tests.cnt(tests.u('staffA'), format('update public.t_c2 set v = ''z'' where id = %L', tests.id('c2-w2'))), 0::bigint, '型 C2：担当でない作業の行は直せない');
select is(tests.cnt(tests.u('staffA'), format('update public.t_c2 set v = ''z'' where id = %L', tests.id('c2-w1'))), 1::bigint, '型 C2：担当の作業の行は直せる');

-- 型 D（外部に見せる）
select is(tests.n(tests.u('extA'), 'select 1 from public.t_d'), 1::bigint, 'R-001-18 型 D：外部の人は、許された建物の行だけ読める');
select is(tests.run_as(tests.u('extA'), 'select v from public.t_d') -> 'rows' -> 0 ->> 'v', 'one', 'R-001-18 型 D：読めるのは許された建物（1つ目）の行');
select is(tests.n(tests.u('extB'), format('select 1 from public.t_d where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-001-18 型 D：別の会社の外部の人は、A の行を読めない');
select is(tests.n(tests.u('extB'), 'select 1 from public.t_d'), 1::bigint, 'R-001-18 型 D：外部の人は、自分の会社の許された建物の行を読める');
select is(tests.err(tests.u('extA'), format('insert into public.t_d (tenant_id, building_id) values (%L, %L)', tests.t('A'), tests.id('buildingA1'))), '42501', 'R-001-23 型 D：外部の人は書けない');
select is(tests.n(tests.u('memberA'), 'select 1 from public.t_d'), 2::bigint, '型 D：会社の中の人は、全部の建物の行を読める');

-- 型 E（管理）
select is(tests.n(tests.u('adminA'), 'select 1 from public.t_e'), 1::bigint, '型 E：user.manage を持つ人は読める');
select is(tests.n(tests.u('memberA'), 'select 1 from public.t_e'), 0::bigint, '型 E：user.manage のない人は読めない');
select is(tests.err(tests.u('adminA'), format('insert into public.t_e (tenant_id, v) values (%L, ''x'')', tests.t('A'))), '42501', 'R-001-23 型 E：管理者も、画面（直接）からは書けない');
select is(tests.cnt(tests.u('adminA'), 'update public.t_e set v = ''x'''), -1::bigint, 'R-001-23 型 E：管理者も、画面（直接）からは直せない');

-- 型 C は履歴を付けない、A は付ける
select is((select count(*)::int from public.audit_logs where table_name = 't_c1'), 0, 'R-001-26 型 C（現場の記録）は履歴を付けない');
select ok((select count(*) from public.audit_logs where table_name = 't_a') > 0, 'R-001-26 型 A は履歴を付ける');
select ok((select count(*) from public.audit_logs where table_name = 't_b') > 0, 'R-001-26 型 B は履歴を付ける');
select ok((select count(*) from public.audit_logs where table_name = 't_e') > 0, 'R-001-26 型 E は履歴を付ける');

select * from finish();
rollback;
