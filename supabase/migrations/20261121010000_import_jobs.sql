-- 機能 014：データの取り込みの記録（型 E）。
-- data-model.md の 013・014 の章と、specs/014-import/design.md が正。
-- 読めるのは master.edit を持つ人だけ。書くのは RPC（public.import_rows）だけ。

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  kind text not null check (kind in ('clients', 'buildings', 'rooms', 'contracts')),
  file_name text not null check (length(btrim(file_name)) > 0),
  file_path text, -- ファイルそのものは保存しない（個人情報を残さない）ので、今は空。保存する形にするときの置き場
  status text not null check (status in ('done', 'partial')), -- partial：エラーの行がある
  total_rows int not null check (total_rows >= 0),
  created_count int not null default 0 check (created_count >= 0),
  skipped_count int not null default 0 check (skipped_count >= 0), -- 重なりで飛ばした数
  error_rows int not null default 0 check (error_rows >= 0),
  details jsonb not null default '[]'::jsonb, -- 取り込まなかった行：[{row, status(error|duplicate), messages[], by(client|server)}]
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  unique (tenant_id, id)
);
create index import_jobs_tenant_idx on public.import_jobs (tenant_id, created_at desc);

select app.apply_policy('public.import_jobs', 'E', '{"read_perm": "master.edit"}');
