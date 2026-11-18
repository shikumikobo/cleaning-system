"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { QuoteShell, Loading, Notice, useQuoteCtx } from "@/components/quotes/Shell";
import { listBuildings, listClients } from "@/lib/masters/repo";
import { filterQuotes, formatDateJa, formatYen, quoteKindLabel, statusLabel } from "@/lib/quotes/format";
import { listQuotes } from "@/lib/quotes/repo";
import type { Quote } from "@/lib/quotes/types";

export default function QuotesPage() {
  const { ctx, error } = useQuoteCtx();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [clients, setClients] = useState<Record<string, string>>({});
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void Promise.all([listQuotes(ctx.sb, ctx.tenantId), listClients(ctx.sb, ctx.tenantId), listBuildings(ctx.sb, ctx.tenantId)])
      .then(([qs, cs, bs]) => {
        if (cancelled) return;
        setQuotes(qs);
        setClients(Object.fromEntries(cs.map((c) => [c.id, c.name])));
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
      })
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const names = useMemo(() => ({ clients, buildings }), [clients, buildings]);
  const shown = filterQuotes(quotes, names, { q, status });

  return (
    <QuoteShell title="見積" active="quotes">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx ? (
        <>
          <div className="m-bar">
            <input type="search" placeholder="番号・取引先・建物で探す" aria-label="番号・取引先・建物で探す" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="状況" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
              <option value="">すべての状況</option>
              <option value="draft">下書き</option>
              <option value="submitted">提出</option>
              <option value="approved">承認</option>
              <option value="rejected">不成立</option>
            </select>
            {ctx.canEdit ? (
              <Link className="m-btn" href="/quotes/edit/" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                見積を作る
              </Link>
            ) : null}
          </div>
          {shown.length === 0 ? <p>該当する見積はありません。</p> : null}
          {shown.map((x) => (
            <Link key={x.id} className="m-card" href={`/quotes/edit/?id=${x.id}`}>
              <strong>
                <span className={`q-status ${x.status}`}>{statusLabel(x.status)}</span>
                {x.number ?? "（番号なし）"} {clients[x.client_id] ?? ""}
              </strong>
              <span className="m-sub">
                {buildings[x.building_id] ?? ""} ／ {quoteKindLabel(x.kind)}
                {x.issue_date ? ` ／ 発行 ${formatDateJa(x.issue_date)}` : ""}
                {x.status === "draft" ? "" : ` ／ 合計 ${formatYen(x.total)}`}
              </span>
            </Link>
          ))}
        </>
      ) : null}
    </QuoteShell>
  );
}
