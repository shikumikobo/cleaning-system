-- 機能 012：作業の予定と実績。data-model.md の 008・009・012 の章と、specs/012-schedule/design.md が正。
-- 実績（work_records。型 C1）、動かした予定の印（works.moved_from）、重なり・予実・月ごとの集計の view。
-- 作業・担当の表は 010 が作った。ここは足すだけ。守りの決まり：親は unique (tenant_id, id)、子は (tenant_id, 親の id) の組で参照する。
-- 位置の列（start_lat など）は置くだけ。位置の記録と離れたときの知らせは 013（波 6）が作る。

-- 1. 実績（型 C1）。作業の担当が、現場で開始・終了を記録する。ID は端末で作った uuid（二度送っても1件）-----
create table public.work_records (
  id uuid primary key default gen_random_uuid(), -- 端末で作った uuid
  tenant_id uuid not null references public.tenants (id),
  work_id uuid not null,
  membership_id uuid not null, -- 担当した人（所属）。型 C1 の持ち主
  started_at timestamptz not null,
  ended_at timestamptz,
  start_lat double precision check (start_lat between -90 and 90),
  start_lng double precision check (start_lng between -180 and 180),
  end_lat double precision check (end_lat between -90 and 90),
  end_lng double precision check (end_lng between -180 and 180),
  distance_m int check (distance_m >= 0),
  distance_warning boolean not null default false,
  client_created_at timestamptz not null default now(), -- 端末で作った時刻
  device_id text,
  received_at timestamptz not null default now(), -- 届いた時刻
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, work_id) references public.works (tenant_id, id),
  foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id),
  constraint work_records_period_ck check (ended_at is null or ended_at >= started_at)
);
create index work_records_work_idx on public.work_records (tenant_id, work_id);
create index work_records_member_idx on public.work_records (tenant_id, membership_id, started_at desc);
-- 同じ人の、終わっていない実績は、1つの作業に1つだけ
create unique index work_records_open_uq on public.work_records (tenant_id, work_id, membership_id) where ended_at is null and deleted_at is null;

-- 2. 動かした予定の印：定時の処理が作った作業の日を動かしたとき、元の日を持つ（定時の処理がその日を作り直さない）----
alter table public.works add column moved_from date[] not null default '{}';

-- 3. policy：読めるのは本人と work.assign。書くのは RPC だけ（画面からの直接の書き込みは受け付けない）-----
select app.apply_policy('public.work_records', 'C1');
drop policy tp_insert on public.work_records;
drop policy tp_update on public.work_records;
revoke insert, update on public.work_records from authenticated;

-- 4. view（security_invoker：読む人の権限の RLS をそのまま通す。社内の人だけ。金額は出さない）---------------

-- 重なり：同じ人・同じ日で、時刻が重なる2つの作業（各作業から見た相手）。時刻のない・取消・行わず・隣り合うだけの作業は数えない
create view public.work_overlaps with (security_invoker = true) as
select w1.tenant_id, x.membership_id, w1.id as work_id, w2.id as other_work_id, w1.scheduled_date
from public.works w1
join public.work_assignments x on x.tenant_id = w1.tenant_id and x.work_id = w1.id and x.deleted_at is null
join public.work_assignments y on y.tenant_id = x.tenant_id and y.membership_id = x.membership_id and y.deleted_at is null and y.work_id <> x.work_id
join public.works w2 on w2.tenant_id = y.tenant_id and w2.id = y.work_id and w2.scheduled_date = w1.scheduled_date
where w1.deleted_at is null and w2.deleted_at is null
  and w1.status not in ('skipped', 'cancelled') and w2.status not in ('skipped', 'cancelled')
  and w1.start_time is not null and w1.end_time is not null and w2.start_time is not null and w2.end_time is not null
  and w1.start_time < w2.end_time and w2.start_time < w1.end_time
  and app.is_internal(w1.tenant_id);

-- 予実：取消でない作業ごとに、予定と実績・報告書を並べる。日付の比べは日本時間
create view public.work_plan_actual with (security_invoker = true) as
select
  w.tenant_id, w.id as work_id, w.building_id, w.title, w.scheduled_date, w.start_time, w.end_time, w.status,
  r.first_started_at, r.last_ended_at, r.open_records, coalesce(r.actual_minutes, 0) as actual_minutes,
  case when r.first_started_at is not null and w.start_time is not null
       then round(extract(epoch from ((r.first_started_at at time zone 'Asia/Tokyo') - (w.scheduled_date + w.start_time))) / 60)::int end as start_gap_min,
  case when r.last_ended_at is not null and r.open_records = 0 and w.end_time is not null
       then round(extract(epoch from ((r.last_ended_at at time zone 'Asia/Tokyo') - (w.scheduled_date + w.end_time))) / 60)::int end as end_gap_min,
  rep.id as report_id, coalesce(rep.status, 'none') as report_status,
  coalesce(ri.total, 0)::int as items_total, coalesce(ri.skipped, 0)::int as items_skipped,
  (w.scheduled_date < (now() at time zone 'Asia/Tokyo')::date and w.status = 'scheduled') as not_done,
  (w.scheduled_date < (now() at time zone 'Asia/Tokyo')::date and w.status = 'in_progress') as unfinished,
  (w.status = 'done' and coalesce(rep.status, 'none') <> 'submitted') as report_missing
from public.works w
left join lateral (
  select min(x.started_at) as first_started_at, max(x.ended_at) as last_ended_at,
         count(*) filter (where x.ended_at is null) as open_records,
         round(sum(extract(epoch from (x.ended_at - x.started_at))) filter (where x.ended_at is not null) / 60)::int as actual_minutes
  from public.work_records x where x.tenant_id = w.tenant_id and x.work_id = w.id and x.deleted_at is null
) r on true
left join public.reports rep on rep.tenant_id = w.tenant_id and rep.work_id = w.id and rep.deleted_at is null
left join lateral (
  select count(*) as total, count(*) filter (where not i.done) as skipped
  from public.report_items i where i.tenant_id = w.tenant_id and i.report_id = rep.id and i.deleted_at is null
) ri on true
where w.deleted_at is null and w.status <> 'cancelled' and app.is_internal(w.tenant_id);

-- 月ごとの集計：月（日本時間の月の1日）・建物ごと
create view public.work_monthly with (security_invoker = true) as
select
  w.tenant_id, date_trunc('month', w.scheduled_date::timestamp)::date as month, w.building_id,
  count(*) filter (where w.status <> 'cancelled')::int as planned,
  count(*) filter (where w.status = 'done')::int as done,
  count(*) filter (where w.status = 'skipped')::int as skipped,
  count(*) filter (where w.status = 'cancelled')::int as cancelled,
  count(*) filter (where p.not_done)::int as not_done,
  count(*) filter (where p.report_missing)::int as report_missing,
  coalesce(round(sum(extract(epoch from (w.end_time - w.start_time)) / 60)
    filter (where w.status <> 'cancelled' and w.start_time is not null and w.end_time is not null)), 0)::int as planned_minutes,
  coalesce(sum(p.actual_minutes), 0)::int as actual_minutes
from public.works w
left join public.work_plan_actual p on p.tenant_id = w.tenant_id and p.work_id = w.id
where w.deleted_at is null and app.is_internal(w.tenant_id)
group by w.tenant_id, date_trunc('month', w.scheduled_date::timestamp), w.building_id;

revoke all on public.work_overlaps, public.work_plan_actual, public.work_monthly from public, anon, authenticated;
grant select on public.work_overlaps, public.work_plan_actual, public.work_monthly to authenticated;

-- 5. 使われているものは消さない -------------------------------------------------------
-- 002 の app.usage_refs の「作業（scheduled・in_progress）」は、この機能の状況の値と合っているので、行は足さない。
-- 実績は作業に付くだけで、建物・取引先を直接は指さない。
