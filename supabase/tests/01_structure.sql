-- 全部の表に対する構造の確かめ（R-001-22 ほか）。後の機能の表も自動で対象になる。
begin;
select * from no_plan();

-- 対象：public の通常の表すべて
create temp table _tbls on commit drop as
select c.relname::text as t, c.oid as oid from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p');

select ok((select count(*) from _tbls) >= 14, 'R-001-22 001 の表が揃っている（14 以上）');

select is((select coalesce(string_agg(t, ','), '') from _tbls
           where not (select relrowsecurity from pg_class where oid = _tbls.oid)),
          '', 'R-001-22 すべての表で RLS が ON');

select is((select coalesce(string_agg(t, ','), '') from _tbls where t not in (select table_name from app.policy_registry)),
          '', 'R-001-22 すべての表に policy の型が登録されている');

select is((select coalesce(string_agg(table_name, ','), '') from app.policy_registry
           where table_name not in (select t from _tbls)),
          '', '登録に、存在しない表がない');

select is((select coalesce(string_agg(distinct policy_type, ','), '') from app.policy_registry
           where split_part(policy_type, '+', 1) not in ('A', 'B', 'C1', 'C2', 'E', 'M', 'P')),
          '', 'R-001-22 型は A・B・C1・C2・E（＋D）か、共通のマスタ M・人 P のどれか');

select is((select coalesce(string_agg(t, ','), '') from _tbls
           where not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = _tbls.t)),
          '', 'R-001-22 すべての表に型の policy が1つ以上ある');

select is((select coalesce(string_agg(policyname, ','), '') from pg_policies
           where schemaname = 'public' and policyname not like 'tp\_%'),
          '', 'R-001-22 policy は型から作ったもの（tp_ で始まる）だけで、手で書いたものがない');

select is((select coalesce(string_agg(tablename || ':' || policyname, ','), '') from pg_policies
           where schemaname = 'public' and (roles <> array['authenticated']::name[])),
          '', '型の policy は authenticated だけに付く（anon・public には付けない）');

-- 型 A・B・E のうち、型の policy に書かれた判定が has_perm か型の関数を通っている
select is((select coalesce(string_agg(tablename || ':' || policyname, ','), '') from pg_policies
           where schemaname = 'public' and policyname like 'tp\_%'
             and tablename not in (select table_name from app.policy_registry where split_part(policy_type, '+', 1) in ('M', 'P'))
             and coalesce(qual, '') !~ '(has_perm|is_internal|is_external|is_support_viewer|is_owner_membership|is_my_|my_tenant_ids)'
             and coalesce(qual, '') <> 'false'
             and coalesce(with_check, '') !~ '(has_perm|is_internal|is_external|is_support_viewer|is_owner_membership|is_my_|my_tenant_ids)'),
          '', 'R-001-23 policy は権限の関数だけで判定し、役割の名前を直接書かない');

select is((select coalesce(string_agg(tablename || ':' || policyname, ','), '') from pg_policies
           where schemaname = 'public' and (coalesce(qual, '') ~* '(admin|member|staff|external)''' or coalesce(with_check, '') ~* '(admin|member|staff|external)''')),
          '', 'R-001-23 policy に役割の名前を直接書かない');

-- 書き込みの経路：削除の policy はない（論理削除だけ）、delete の権限もない
select is((select coalesce(string_agg(tablename || ':' || policyname, ','), '') from pg_policies
           where schemaname = 'public' and cmd = 'DELETE'),
          '', '業務の表に delete の policy がない（論理削除だけ）');

select is((select coalesce(string_agg(t, ','), '') from _tbls
           where has_table_privilege('authenticated', oid, 'DELETE')),
          '', 'authenticated に delete の権限がない');

select is((select coalesce(string_agg(t, ','), '') from _tbls
           where has_table_privilege('anon', oid, 'SELECT') or has_table_privilege('anon', oid, 'INSERT')
              or has_table_privilege('anon', oid, 'UPDATE') or has_table_privilege('anon', oid, 'DELETE')),
          '', 'anon はどの表にも権限がない');

-- 型 E は、画面から書けない（RPC・Edge Function だけ）
select is((select coalesce(string_agg(t, ','), '') from _tbls
           join app.policy_registry r on r.table_name = _tbls.t and split_part(r.policy_type, '+', 1) = 'E'
           where has_table_privilege('authenticated', oid, 'INSERT') or has_table_privilege('authenticated', oid, 'UPDATE')),
          '', '型 E の表は authenticated から書けない');

-- 組の決まり
select is((select coalesce(string_agg(r.table_name, ','), '') from app.policy_registry r
           where r.tenant_col = 'tenant_id'
             and not exists (select 1 from pg_constraint c where c.conrelid = ('public.' || quote_ident(r.table_name))::regclass
                             and c.contype = 'u'
                             and (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
                                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = array['tenant_id', 'id']::text[])),
          '', 'R-001-20 tenant_id を持つ表は unique (tenant_id, id) を持つ（子が組で参照できる）');

select is((select coalesce(string_agg(conrelid::regclass::text || '→' || confrelid::regclass::text, ','), '') from pg_constraint c
           where c.contype = 'f' and c.connamespace = 'public'::regnamespace
             and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'tenant_id' and not a.attisdropped)
             and exists (select 1 from pg_attribute a where a.attrelid = c.confrelid and a.attname = 'tenant_id' and not a.attisdropped)
             and not (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) @> array['tenant_id']::text[]),
          '', 'R-001-20 会社を持つ表どうしの外部キーは tenant_id を含む組');

select is((select coalesce(string_agg(r.table_name, ','), '') from app.policy_registry r
           where r.tenant_col = 'tenant_id' and split_part(r.policy_type, '+', 1) not in ('M', 'P')
             and not exists (select 1 from pg_index i where i.indrelid = ('public.' || quote_ident(r.table_name))::regclass
                             and (select a.attname from pg_attribute a where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) = 'tenant_id')),
          '', '会社を持つ表は tenant_id から始まる索引を持つ');

select is((select coalesce(string_agg(c.conrelid::regclass::text || '.' || c.conname, ','), '') from pg_constraint c
           where c.contype = 'f' and c.connamespace = 'public'::regnamespace
             and not exists (select 1 from pg_index i where i.indrelid = c.conrelid
                             and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)),
          '', '外部キーの列に索引がある');

-- 関数の決まり
select is((select coalesce(string_agg(p.oid::regprocedure::text, ','), '') from pg_proc p
           where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace) and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')),
          '', 'security definer の関数は search_path を固定している');

select is((select coalesce(string_agg(p.oid::regprocedure::text, ','), '') from pg_proc p
           where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
             and (has_function_privilege('anon', p.oid, 'EXECUTE')
                  or p.proacl is null
                  or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))),
          '', 'anon・public は public と app の関数を実行できない');

select is((select coalesce(string_agg(p.oid::regprocedure::text, ','), '') from pg_proc p
           where p.proname = 'has_perm' and p.pronamespace = 'public'::regnamespace and p.provolatile <> 's'),
          '', 'has_perm は stable');

select is((select count(*)::int from pg_proc p where p.proname = 'has_perm' and p.pronamespace = 'public'::regnamespace), 1,
          'has_perm(tenant_id, perm) が1つある');

select is((select coalesce(string_agg(c.relname, ','), '') from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
             and not coalesce((select 'security_invoker=true' = any (c.reloptions)), false)),
          '', 'view はすべて security_invoker = true');

select * from finish();
rollback;
