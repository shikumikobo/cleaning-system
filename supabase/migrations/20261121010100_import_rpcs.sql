-- 機能 014：データの取り込みの RPC。取り込んだ人のログインの鍵で呼ぶ（security definer だが、中で必ず権限と会社を確かめる）。
-- 画面で確かめた行を受け取り、サーバーでも検査と重なりの確かめをやり直してから書く。
-- 契約は 010 の create_contract_import を呼ぶ（見積なし・元は取り込み）。

-- 名前の比べ方：全角半角・空白・大文字小文字の違いを無視（画面の lib/import/normalize.ts の importKey() と同じ決まり）
create function app.import_key(p text) returns text language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(normalize(coalesce(p, ''), NFKC)), '[[:space:]]+', ' ', 'g'))
$$;

-- p_kind：clients・buildings・rooms・contracts
-- p_excluded：画面が確かめで外した行 [{row, status(error|duplicate), messages[]}]（記録に残すだけ）
-- p_rows：取り込む行。clients：{row, kind, name, address, phone, email, closing_day, payment_terms}
--   buildings：{row, client_name, name, address, owner_name}　rooms：{row, client_name, building_name, room_no, floor}
--   contracts：{row, client_name, building_name, kind, start_date, end_date, services[]}
create function public.import_rows(p_tenant uuid, p_kind text, p_file_name text, p_total_rows int, p_excluded jsonb, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r jsonb; x jsonb; v_job uuid := gen_random_uuid();
  v_created int := 0; v_skipped int := 0; v_errors int := 0;
  v_details jsonb := '[]'::jsonb; v_row int; v_reason text; v_status text;
  v_client uuid; v_building uuid; v_owner uuid; v_n int;
  v_name text; v_kind text; v_email text; v_res jsonb;
  v_keys text[]; v_status_job text;
begin
  perform app.require_perm(p_tenant, 'master.edit');
  if p_kind = 'contracts' then perform app.require_perm(p_tenant, 'contract.edit'); end if;
  if p_kind is null or p_kind not in ('clients', 'buildings', 'rooms', 'contracts') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;
  if nullif(btrim(p_file_name), '') is null then return jsonb_build_object('ok', false, 'reason', 'invalid_file_name'); end if;
  if p_total_rows is null or p_total_rows < 0 then return jsonb_build_object('ok', false, 'reason', 'invalid_total'); end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_typeof(coalesce(p_excluded, '[]'::jsonb)) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_rows');
  end if;
  perform set_config('app.source', 'import', true);

  -- 画面が外した行（記録に残す）
  for x in select * from jsonb_array_elements(coalesce(p_excluded, '[]'::jsonb)) loop
    v_status := case when x ->> 'status' = 'duplicate' then 'duplicate' else 'error' end;
    if v_status = 'duplicate' then v_skipped := v_skipped + 1; else v_errors := v_errors + 1; end if;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'row', x -> 'row', 'status', v_status,
      'messages', case when jsonb_typeof(x -> 'messages') = 'array' then x -> 'messages' else '[]'::jsonb end, 'by', 'client'));
  end loop;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := nullif(r ->> 'row', '')::int;
    v_reason := null; v_status := null;
    begin
      if p_kind = 'clients' then
        v_name := nullif(btrim(r ->> 'name'), '');
        v_kind := coalesce(nullif(btrim(r ->> 'kind'), ''), 'management_company');
        v_email := nullif(btrim(r ->> 'email'), '');
        if v_name is null then v_reason := 'name_required';
        elsif v_kind not in ('management_company', 'owner') then v_reason := 'invalid_kind';
        elsif v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then v_reason := 'invalid_email';
        elsif nullif(btrim(r ->> 'closing_day'), '') is not null
              and (btrim(r ->> 'closing_day') !~ '^[0-9]{1,2}$' or btrim(r ->> 'closing_day')::int not between 1 and 31) then v_reason := 'invalid_closing_day';
        elsif exists (select 1 from public.clients where tenant_id = p_tenant and deleted_at is null and app.import_key(name) = app.import_key(v_name)) then
          v_status := 'duplicate';
        else
          insert into public.clients (tenant_id, kind, name, address, phone, email, closing_day, payment_terms)
          values (p_tenant, v_kind, v_name, nullif(btrim(r ->> 'address'), ''), nullif(btrim(r ->> 'phone'), ''), v_email,
                  nullif(btrim(r ->> 'closing_day'), '')::int, nullif(btrim(r ->> 'payment_terms'), ''));
        end if;

      elsif p_kind = 'buildings' then
        v_name := nullif(btrim(r ->> 'name'), '');
        select count(*), min(id::text)::uuid into v_n, v_client from public.clients
          where tenant_id = p_tenant and deleted_at is null and app.import_key(name) = app.import_key(r ->> 'client_name');
        if v_name is null then v_reason := 'name_required';
        elsif nullif(btrim(r ->> 'address'), '') is null then v_reason := 'address_required';
        elsif v_n = 0 then v_reason := 'client_not_found';
        elsif v_n > 1 then v_reason := 'client_ambiguous';
        else
          v_owner := null;
          if nullif(btrim(r ->> 'owner_name'), '') is not null then
            select count(*), min(id::text)::uuid into v_n, v_owner from public.clients
              where tenant_id = p_tenant and deleted_at is null and app.import_key(name) = app.import_key(r ->> 'owner_name');
            if v_n = 0 then v_reason := 'owner_not_found'; elsif v_n > 1 then v_reason := 'owner_ambiguous'; end if;
          end if;
          if v_reason is null then
            if exists (select 1 from public.buildings where tenant_id = p_tenant and deleted_at is null and client_id = v_client
                       and app.import_key(name) = app.import_key(v_name)) then
              v_status := 'duplicate';
            else
              insert into public.buildings (tenant_id, client_id, owner_client_id, name, address)
              values (p_tenant, v_client, v_owner, v_name, btrim(r ->> 'address'));
            end if;
          end if;
        end if;

      elsif p_kind = 'rooms' then
        select count(*), min(id::text)::uuid into v_n, v_client from public.clients
          where tenant_id = p_tenant and deleted_at is null and app.import_key(name) = app.import_key(r ->> 'client_name');
        if nullif(btrim(r ->> 'room_no'), '') is null then v_reason := 'room_no_required';
        elsif nullif(btrim(r ->> 'floor'), '') is not null and btrim(r ->> 'floor') !~ '^-?[0-9]{1,4}$' then v_reason := 'invalid_floor';
        elsif v_n = 0 then v_reason := 'client_not_found';
        elsif v_n > 1 then v_reason := 'client_ambiguous';
        else
          select count(*), min(id::text)::uuid into v_n, v_building from public.buildings
            where tenant_id = p_tenant and deleted_at is null and client_id = v_client and app.import_key(name) = app.import_key(r ->> 'building_name');
          if v_n = 0 then v_reason := 'building_not_found';
          elsif v_n > 1 then v_reason := 'building_ambiguous';
          elsif exists (select 1 from public.rooms where tenant_id = p_tenant and deleted_at is null and building_id = v_building
                        and app.import_key(room_no) = app.import_key(r ->> 'room_no')) then
            v_status := 'duplicate';
          else
            insert into public.rooms (tenant_id, building_id, room_no, floor)
            values (p_tenant, v_building, btrim(r ->> 'room_no'), nullif(btrim(r ->> 'floor'), '')::int);
          end if;
        end if;

      else -- contracts
        select count(*), min(id::text)::uuid into v_n, v_client from public.clients
          where tenant_id = p_tenant and deleted_at is null and app.import_key(name) = app.import_key(r ->> 'client_name');
        if v_n = 0 then v_reason := 'client_not_found';
        elsif v_n > 1 then v_reason := 'client_ambiguous';
        else
          select count(*), min(id::text)::uuid into v_n, v_building from public.buildings
            where tenant_id = p_tenant and deleted_at is null and client_id = v_client and app.import_key(name) = app.import_key(r ->> 'building_name');
          if v_n = 0 then v_reason := 'building_not_found';
          elsif v_n > 1 then v_reason := 'building_ambiguous';
          elsif jsonb_typeof(r -> 'services') is distinct from 'array' or jsonb_array_length(r -> 'services') = 0 then v_reason := 'no_services';
          else
            select coalesce(array_agg(k order by k), '{}') into v_keys
              from (select app.import_key(e ->> 'name') as k from jsonb_array_elements(r -> 'services') e) s;
            if exists (
              select 1 from public.contracts c
              where c.tenant_id = p_tenant and c.building_id = v_building and c.deleted_at is null
                and c.kind = r ->> 'kind' and c.start_date = (r ->> 'start_date')::date
                and (select coalesce(array_agg(app.import_key(s.name) order by app.import_key(s.name)), '{}') from public.contract_services s
                     where s.tenant_id = c.tenant_id and s.contract_id = c.id and s.deleted_at is null and s.valid_to is null) = v_keys
            ) then
              v_status := 'duplicate';
            else
              v_res := public.create_contract_import(v_client, v_building, r ->> 'kind', (r ->> 'start_date')::date,
                                                     nullif(r ->> 'end_date', '')::date, r -> 'services');
              if coalesce((v_res ->> 'ok')::boolean, false) is not true then v_reason := coalesce(v_res ->> 'reason', 'invalid'); end if;
            end if;
          end if;
        end if;
      end if;
    exception
      when sqlstate '42501' then raise;
      when unique_violation then v_status := 'duplicate'; v_reason := null;
      when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then v_reason := 'invalid_value';
      when others then v_reason := 'invalid';
    end;

    if v_reason is not null then
      v_errors := v_errors + 1;
      v_details := v_details || jsonb_build_array(jsonb_build_object('row', v_row, 'status', 'error', 'messages', jsonb_build_array(v_reason), 'by', 'server'));
    elsif v_status = 'duplicate' then
      v_skipped := v_skipped + 1;
      v_details := v_details || jsonb_build_array(jsonb_build_object('row', v_row, 'status', 'duplicate', 'messages', jsonb_build_array('duplicate'), 'by', 'server'));
    else
      v_created := v_created + 1;
    end if;
  end loop;

  perform set_config('app.source', 'import', true);
  v_status_job := case when v_errors > 0 then 'partial' else 'done' end;
  insert into public.import_jobs (id, tenant_id, kind, file_name, status, total_rows, created_count, skipped_count, error_rows, details)
  values (v_job, p_tenant, p_kind, btrim(p_file_name), v_status_job, p_total_rows, v_created, v_skipped, v_errors, v_details);
  return jsonb_build_object('ok', true, 'job_id', v_job, 'status', v_status_job, 'created', v_created, 'skipped', v_skipped,
                            'errors', v_errors, 'details', v_details);
end $$;

select app.lock_functions();
revoke execute on function app.import_key(text) from public, anon, authenticated, service_role;
grant execute on function public.import_rows(uuid, text, text, int, jsonb, jsonb) to authenticated;
