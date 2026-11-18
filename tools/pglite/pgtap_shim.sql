-- pgTAP の代わりの最小の版（PGlite の仮の検証用）。使うのは plan・no_plan・ok・is・isnt・pass・fail・finish だけ。
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create function extensions._tap_next() returns int language plpgsql as $$
declare n int := coalesce(nullif(current_setting('tap.n', true), '')::int, 0) + 1;
begin perform set_config('tap.n', n::text, false); return n; end $$;
create function extensions._tap_fail() returns void language plpgsql as $$
begin perform set_config('tap.failed', (coalesce(nullif(current_setting('tap.failed', true), '')::int, 0) + 1)::text, false); end $$;

create function extensions.no_plan() returns setof boolean language plpgsql as $$
begin perform set_config('tap.n', '0', false); perform set_config('tap.failed', '0', false); return next true; end $$;
create function extensions.plan(int) returns text language plpgsql as $$
begin perform set_config('tap.n', '0', false); perform set_config('tap.failed', '0', false); return '1..' || $1; end $$;

create function extensions.ok(boolean, text default '') returns text language plpgsql as $$
declare n int := extensions._tap_next();
begin
  if $1 is true then return 'ok ' || n || ' - ' || $2; end if;
  perform extensions._tap_fail();
  return 'not ok ' || n || ' - ' || $2;
end $$;
create function extensions.pass(text default '') returns text language sql as $$ select extensions.ok(true, $1) $$;
create function extensions.fail(text default '') returns text language sql as $$ select extensions.ok(false, $1) $$;

create function extensions.is(anyelement, anyelement, text default '') returns text language plpgsql as $$
declare n int := extensions._tap_next();
begin
  if $1 is not distinct from $2 then return 'ok ' || n || ' - ' || $3; end if;
  perform extensions._tap_fail();
  return 'not ok ' || n || ' - ' || $3 || E'\n#   got: ' || coalesce($1::text, 'NULL') || E'\n#   expected: ' || coalesce($2::text, 'NULL');
end $$;
create function extensions.isnt(anyelement, anyelement, text default '') returns text language plpgsql as $$
declare n int := extensions._tap_next();
begin
  if $1 is distinct from $2 then return 'ok ' || n || ' - ' || $3; end if;
  perform extensions._tap_fail();
  return 'not ok ' || n || ' - ' || $3 || E'\n#   got: ' || coalesce($1::text, 'NULL') || E'\n#   expected anything else';
end $$;
create function extensions.finish() returns setof text language plpgsql as $$
begin return next '# finished ' || coalesce(current_setting('tap.n', true), '0') || ' tests, failed ' || coalesce(current_setting('tap.failed', true), '0'); end $$;
