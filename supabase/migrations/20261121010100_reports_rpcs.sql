-- 機能 009：報告書の RPC（確認・差し戻し・提出）と、ひな形・項目を消す RPC。
-- RPC は security definer で RLS を通らない。中で必ず権限と、行の会社・状況を確かめる。
-- 行が見つからない・権限がないは、同じ 42501 で返す（ほかの会社の行の存在を探らせない）。
-- 業務の決まりで断るときは、例外ではなく {ok:false, reason} を返す（画面が日本語で理由を出せる）。
-- 状況の流れ：下書き（draft）→ 確認済み（checked）→ 提出（submitted）。確認済みから下書きへは差し戻しだけ。

-- 確認：下書きを確認済みにする（work.assign）
create function public.check_report(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.reports; v_member uuid;
begin
  select * into r from public.reports where id = p_id for update;
  if not found or r.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(r.tenant_id, 'work.assign');
  perform app.mark_rpc();
  if r.status = 'checked' then return jsonb_build_object('ok', true, 'already', true, 'status', 'checked', 'version', r.version); end if;
  if r.status = 'submitted' then return jsonb_build_object('ok', false, 'reason', 'submitted'); end if;
  select id into v_member from public.memberships
  where tenant_id = r.tenant_id and user_id = (select auth.uid()) and status = 'active' and deleted_at is null;
  update public.reports
     set status = 'checked', checked_by = v_member, checked_at = now(), version = version + 1
   where id = r.id
  returning version into r.version;
  return jsonb_build_object('ok', true, 'status', 'checked', 'version', r.version);
end $$;

-- 差し戻し：確認済みを下書きに戻す（work.assign）。提出済みは戻せない
create function public.reopen_report(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
  select * into r from public.reports where id = p_id for update;
  if not found or r.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(r.tenant_id, 'work.assign');
  perform app.mark_rpc();
  if r.status = 'draft' then return jsonb_build_object('ok', true, 'already', true, 'status', 'draft', 'version', r.version); end if;
  if r.status = 'submitted' then return jsonb_build_object('ok', false, 'reason', 'submitted'); end if;
  update public.reports
     set status = 'draft', checked_by = null, checked_at = null, version = version + 1
   where id = r.id
  returning version into r.version;
  return jsonb_build_object('ok', true, 'status', 'draft', 'version', r.version);
end $$;

-- 提出：確認済みを提出にする（work.assign）。外部の人は、提出のあとに専用ページで読める
create function public.submit_report(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.reports; v_member uuid;
begin
  select * into r from public.reports where id = p_id for update;
  if not found or r.deleted_at is not null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(r.tenant_id, 'work.assign');
  perform app.mark_rpc();
  if r.status = 'submitted' then return jsonb_build_object('ok', true, 'already', true, 'status', 'submitted', 'version', r.version); end if;
  if r.status <> 'checked' then return jsonb_build_object('ok', false, 'reason', 'not_checked'); end if;
  select id into v_member from public.memberships
  where tenant_id = r.tenant_id and user_id = (select auth.uid()) and status = 'active' and deleted_at is null;
  update public.reports
     set status = 'submitted', submitted_by = v_member, submitted_at = now(), version = version + 1
   where id = r.id
  returning version into r.version;
  return jsonb_build_object('ok', true, 'status', 'submitted', 'version', r.version);
end $$;

-- ひな形を消す：作業・契約の中身・報告書が使っていれば、消さずに「使わない」にする。使っていなければ項目も一緒に論理削除する
create function public.delete_report_template(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_deleted timestamptz; v_block jsonb := '[]'::jsonb; n bigint;
begin
  select tenant_id, deleted_at into v_tenant, v_deleted from public.report_templates where id = p_id;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'master.edit');
  if v_deleted is not null then return jsonb_build_object('ok', true, 'deleted', true, 'already', true); end if;
  perform app.mark_rpc();
  select count(*) into n from public.works where tenant_id = v_tenant and report_template_id = p_id and deleted_at is null;
  if n > 0 then v_block := v_block || jsonb_build_array(jsonb_build_object('reason', 'used_by_works', 'table', 'works', 'count', n)); end if;
  select count(*) into n from public.contract_services where tenant_id = v_tenant and report_template_id = p_id and deleted_at is null;
  if n > 0 then v_block := v_block || jsonb_build_array(jsonb_build_object('reason', 'used_by_contract_services', 'table', 'contract_services', 'count', n)); end if;
  select count(*) into n from public.reports where tenant_id = v_tenant and template_id = p_id and deleted_at is null;
  if n > 0 then v_block := v_block || jsonb_build_array(jsonb_build_object('reason', 'used_by_reports', 'table', 'reports', 'count', n)); end if;
  if jsonb_array_length(v_block) > 0 then
    update public.report_templates set active = false where id = p_id and tenant_id = v_tenant;
    return jsonb_build_object('ok', true, 'deleted', false, 'deactivated', true, 'blockers', v_block);
  end if;
  update public.template_items set deleted_at = now() where tenant_id = v_tenant and template_id = p_id and deleted_at is null;
  update public.report_templates set deleted_at = now() where id = p_id and tenant_id = v_tenant;
  return jsonb_build_object('ok', true, 'deleted', true);
end $$;

-- ひな形の項目を消す：報告書の項目に写されていれば、消さずに「使わない」にする
create function public.delete_template_item(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_deleted timestamptz; n bigint;
begin
  select tenant_id, deleted_at into v_tenant, v_deleted from public.template_items where id = p_id;
  if v_tenant is null then raise exception '権限がない' using errcode = '42501'; end if;
  perform app.require_perm(v_tenant, 'master.edit');
  if v_deleted is not null then return jsonb_build_object('ok', true, 'deleted', true, 'already', true); end if;
  perform app.mark_rpc();
  select count(*) into n from public.report_items where tenant_id = v_tenant and template_item_id = p_id and deleted_at is null;
  if n > 0 then
    update public.template_items set active = false where id = p_id and tenant_id = v_tenant;
    return jsonb_build_object('ok', true, 'deleted', false, 'deactivated', true,
      'blockers', jsonb_build_array(jsonb_build_object('reason', 'used_by_report_items', 'table', 'report_items', 'count', n)));
  end if;
  update public.template_items set deleted_at = now() where id = p_id and tenant_id = v_tenant;
  return jsonb_build_object('ok', true, 'deleted', true);
end $$;

select app.lock_functions();
grant execute on function
  public.check_report(uuid), public.reopen_report(uuid), public.submit_report(uuid),
  public.delete_report_template(uuid), public.delete_template_item(uuid)
to authenticated;
