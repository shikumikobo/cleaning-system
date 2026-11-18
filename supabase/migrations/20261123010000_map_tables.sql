-- 機能 013：地図。data-model.md の 002・012 の章と、specs/013-map/design.md が正。
-- 新しい表は作らない。建物に「位置を求めるのに失敗した印」の列を足し、住所を変えたときの位置の扱い（trigger）、
-- 2点の距離の関数、お知らせの種類 work_far を足す。

-- 1. 建物：位置を求めるのに失敗した印 ------------------------------------------------------
-- 失敗した建物は 7 日は求め直さない（求められない住所が、毎回、先頭の 50 件を占めないため）。画面からは書かない（列の権限に入れない）
alter table public.buildings add column geocode_failed_at timestamptz;
create index buildings_geocode_idx on public.buildings (tenant_id, created_at)
  where lat is null and location_fixed = false and deleted_at is null;

-- 2. 位置の扱い（更新の前）----------------------------------------------------------------
-- ・人（ログインした利用者）が位置を変えたら、地図で直した印（location_fixed）を付ける。位置を空にするのは「求め直し」なので、印は人が決める
-- ・住所だけが変わったとき、直していない建物は位置を空に戻す（求め直しの対象になる）。直した建物は、位置を残す
create function app.buildings_location_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.lat is distinct from old.lat or new.lng is distinct from old.lng then
    if new.lat is not null and (select auth.uid()) is not null then
      new.location_fixed := true;
    end if;
    new.geocode_failed_at := null;
  elsif new.address is distinct from old.address and not new.location_fixed then
    new.lat := null;
    new.lng := null;
    new.geocode_failed_at := null;
  end if;
  return new;
end $$;
create trigger buildings_location_guard before update on public.buildings
  for each row execute function app.buildings_location_guard();

-- 3. 2点の距離（m。四捨五入）。ハーバーサイン。地球の半径 6371008.8 m -----------------------
create function app.distance_m(p_lat1 double precision, p_lng1 double precision, p_lat2 double precision, p_lng2 double precision)
returns int
language sql immutable parallel safe set search_path = '' as $$
  select case when p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then null
    else round(2 * 6371008.8 * asin(least(1.0, sqrt(
      pow(sin(radians(p_lat2 - p_lat1) / 2), 2)
      + cos(radians(p_lat1)) * cos(radians(p_lat2)) * pow(sin(radians(p_lng2 - p_lng1) / 2), 2)
    ))))::int end
$$;

-- 建物から離れているとみなす距離（m）。決めたこと：design.md
create function app.map_far_threshold_m() returns int language sql immutable set search_path = '' as $$ select 300 $$;

-- 4. お知らせの種類：建物から離れた場所での開始・終了（work.assign の人が受け取る）--------------
insert into public.notification_kinds (code, name, default_push, default_email, required_perm, sort)
values ('work_far', '作業の場所のずれ', true, false, 'work.assign', 70);
