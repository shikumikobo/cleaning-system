-- 波 2 の取り込み：003（案件）・004（見積）・005（ファイル）の間の外部キー。
-- 作った時点では相手の表がなかったので、列だけを置いていた。会社をまたがないよう、(tenant_id, id) の組で指す。
-- request_id・quote_id は空でもよい（空のときは確かめない）。索引は各機能のマイグレーションに既にある。
alter table public.quotes
  add constraint quotes_request_fk foreign key (tenant_id, request_id) references public.requests (tenant_id, id);
alter table public.files
  add constraint files_request_fk foreign key (tenant_id, request_id) references public.requests (tenant_id, id);
alter table public.files
  add constraint files_quote_fk foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id);
