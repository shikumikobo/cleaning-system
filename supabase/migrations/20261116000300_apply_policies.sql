-- 001 の表に、policy の型を付ける。表ごとに policy を書き分けない（型の選び方だけがここに残る）。

select app.apply_master_policy('public.roles');
select app.apply_master_policy('public.permissions');
select app.apply_master_policy('public.role_permissions');

-- 型 A：拠点（書けるのは user.manage）
select app.apply_policy('public.offices', 'A', '{"write_perm": "user.manage"}');

-- 型 E：会社・所属・招待・外部の建物・運営の許可・履歴・処理の記録・番号
-- 会社：所属する全員が、自分の会社だけ読める。書くのは RPC と運営の Edge Function だけ
select app.apply_policy('public.tenants', 'E', jsonb_build_object(
  'tenant_col', 'id',
  'own_row_sql', 'id in (select app.my_tenant_ids())'));

-- 所属：管理者のほか、自分の行
select app.apply_policy('public.memberships', 'E', jsonb_build_object(
  'own_row_sql', 'user_id = (select auth.uid()) and status = ''active'''));

select app.apply_policy('public.invitations', 'E');

-- 外部の建物：管理者のほか、外部の本人
select app.apply_policy('public.external_building_access', 'E', jsonb_build_object(
  'own_row_sql', 'app.is_my_membership(tenant_id, membership_id)'));

-- 運営の許可：管理者のほか、運営（許可の期間は support_select が読ませる）
select app.apply_policy('public.support_access_grants', 'E');

-- 履歴は、自分自身には履歴を付けない。だれも直せない
select app.apply_policy('public.audit_logs', 'E', '{"audit": false}');
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function app.audit_immutable();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function app.audit_immutable();

select app.apply_policy('public.job_runs', 'E');

-- 番号は RPC だけが振る。管理者も読まない
select app.apply_policy('public.document_counters', 'E', '{"read_perm": "none"}');

-- 型 C1：端末のエラー（持ち主の本人が書き足すだけ。全員分は work.assign を持つ人が読む）
select app.apply_policy('public.client_error_logs', 'C1', '{"insert_only": true}');

-- 人：同じ会社に所属する人（外部の人を除く）と本人。書き換えるのは本人の表示名だけ
create function app.can_see_profile(p_profile uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_profile = (select auth.uid())
    or exists (
      select 1
      from public.memberships me
      join public.roles mr on mr.id = me.role_id and mr.code <> 'external'
      join public.memberships them on them.tenant_id = me.tenant_id and them.user_id = p_profile
      join public.roles tr on tr.id = them.role_id and tr.code <> 'external'
      where me.user_id = (select auth.uid())
        and me.status = 'active' and me.deleted_at is null
        and them.status = 'active' and them.deleted_at is null
    )
$$;
grant execute on function app.can_see_profile(uuid) to authenticated, service_role;

select app.lock_functions();
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy tp_select on public.profiles for select to authenticated using (app.can_see_profile(id));
create policy tp_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- 運営は、許可の間も、人の名前は読まない（会社の所属を持たないため）。
-- 外部の人が見られる「見積と報告書を作った・確かめた人の名前」は、004・009 の design で足す。
create function app.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger tp_touch before update on public.profiles for each row execute function app.touch_updated_at();
insert into app.policy_registry (table_name, policy_type, tenant_col) values ('profiles', 'P', 'none');
