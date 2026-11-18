-- 機能 016：売上と粗利の view。specs/016-profit/design.md が正。
-- どの view も security_invoker（見る人の権限で、請求書・明細・契約・小口・費用の RLS を通る）。
-- profit_lines：1件ごとの金額（売上・下書き・小口・外注・材料・その他）。profit_monthly：月×取引先×建物×契約の合計。

create view public.profit_lines with (security_invoker = true) as
-- 売上（発行以降）と下書き（見込み）：請求書の明細。月は請求月。建物・契約は明細の元から決める
select l.tenant_id, i.period as month, i.client_id,
       coalesce(ct.building_id, w.building_id, r.building_id) as building_id,
       ct.id as contract_id,
       case when i.status = 'draft' then 'draft' else 'revenue' end as kind,
       l.amount::bigint as amount
from public.invoice_lines l
join public.invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
left join public.works w on w.tenant_id = l.tenant_id and w.id = l.work_id
left join public.requests r on r.tenant_id = l.tenant_id and r.id = l.request_id
left join lateral (
  select s.contract_id from public.contract_services s
  where s.tenant_id = l.tenant_id and s.service_key = l.service_key
  order by s.valid_from desc limit 1) sk on true
left join public.contract_services ws on ws.tenant_id = w.tenant_id and ws.id = w.contract_service_id
left join public.contracts ct on ct.tenant_id = l.tenant_id and ct.id = coalesce(sk.contract_id, ws.contract_id)
where l.deleted_at is null and i.deleted_at is null and i.status in ('draft', 'issued', 'sent', 'partial', 'paid')
union all
-- 小口の費用：確認済み・締め済みの出金。出金の日の月。建物は、出入りの建物（なければ作業の建物）。
-- 小口の行は、持ち手の本人も読めるので、売上と粗利を見られる人（amount.read）だけに足す
select e.tenant_id, date_trunc('month', e.entry_date::timestamp)::date as month, b.client_id, b.id as building_id, ct.id as contract_id,
       'petty' as kind, e.amount::bigint as amount
from public.cash_entries e
left join public.works w on w.tenant_id = e.tenant_id and w.id = e.work_id
left join public.contract_services ws on ws.tenant_id = w.tenant_id and ws.id = w.contract_service_id
left join public.contracts ct on ct.tenant_id = e.tenant_id and ct.id = ws.contract_id
left join public.buildings b on b.tenant_id = e.tenant_id and b.id = coalesce(e.building_id, w.building_id)
where e.deleted_at is null and e.direction = 'out' and e.status in ('confirmed', 'closed')
  and public.has_perm(e.tenant_id, 'amount.read')
union all
-- 手で入れた費用（外注・材料・その他）。建物が空で契約があれば、契約の建物
select c.tenant_id, c.month, b.client_id, b.id as building_id, c.contract_id, c.kind, c.amount
from public.costs c
left join public.contracts ct on ct.tenant_id = c.tenant_id and ct.id = c.contract_id
left join public.buildings b on b.tenant_id = c.tenant_id and b.id = coalesce(c.building_id, ct.building_id)
where c.deleted_at is null;

create view public.profit_monthly with (security_invoker = true) as
select tenant_id, month, client_id, building_id, contract_id,
       coalesce(sum(amount) filter (where kind = 'revenue'), 0)::bigint as revenue,
       coalesce(sum(amount) filter (where kind = 'draft'), 0)::bigint as draft_revenue,
       coalesce(sum(amount) filter (where kind = 'petty'), 0)::bigint as petty,
       coalesce(sum(amount) filter (where kind = 'outsourcing'), 0)::bigint as outsourcing,
       coalesce(sum(amount) filter (where kind = 'material'), 0)::bigint as material,
       coalesce(sum(amount) filter (where kind = 'other'), 0)::bigint as other_cost,
       (coalesce(sum(amount) filter (where kind = 'revenue'), 0)
        - coalesce(sum(amount) filter (where kind in ('petty', 'outsourcing', 'material', 'other')), 0))::bigint as gross
from public.profit_lines
group by tenant_id, month, client_id, building_id, contract_id;

revoke all on public.profit_lines, public.profit_monthly from anon, authenticated;
grant select on public.profit_lines, public.profit_monthly to authenticated;
