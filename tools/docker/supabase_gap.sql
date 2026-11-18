-- supabase/postgres のイメージに無いものだけを補う（本物の Supabase では、ログイン（gotrue）と Storage の別のコンテナが作る分）。
-- 役割（anon・authenticated・service_role）、拡張（pgtap・pgcrypto・pg_trgm）、auth.uid()・auth.role() はイメージにある。
create extension if not exists pgtap with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- auth.uid()・auth.role()・auth.email()：イメージのものは古い形（request.jwt.claim.sub だけを読む）。
-- 本物は gotrue のマイグレーションが、request.jwt.claims（JSON）も読む形に差し替える。同じ形にする
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text $$;

-- auth.jwt()（本物は gotrue のマイグレーションが作る）
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;

-- auth.users：イメージの表は古い形なので、本物にある列を足す
alter table auth.users add column if not exists email_confirmed_at timestamptz;

-- Storage（本物は storage-api のマイグレーションが作る。ここは policy の確かめに要る最小の形）
create table if not exists storage.buckets (id text primary key, name text not null unique, public boolean default false);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
