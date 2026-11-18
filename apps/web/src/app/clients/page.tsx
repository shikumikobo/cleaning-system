"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loading, Notice, Shell, useMasters } from "@/components/masters/Shell";
import { closingDayLabel, filterByName, kindLabel } from "@/lib/masters/format";
import { listClients } from "@/lib/masters/repo";
import type { Client } from "@/lib/masters/types";

export default function ClientsPage() {
  const { ctx, error } = useMasters();
  const [items, setItems] = useState<Client[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void listClients(ctx.sb, ctx.tenantId)
      .then((r) => !cancelled && setItems(r))
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const shown = filterByName(items, q).filter((c) => !kind || c.kind === kind);

  return (
    <Shell title="取引先" active="clients">
      <Loading error={error} ctx={ctx} />
      <Notice text={msg} />
      {ctx ? (
        <>
          <div className="m-bar">
            <input type="search" placeholder="名前で探す" aria-label="名前で探す" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="種類" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto" }}>
              <option value="">すべての種類</option>
              <option value="management_company">管理会社</option>
              <option value="owner">オーナー</option>
            </select>
            <Link className="m-btn" href="/clients/edit/" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              新規登録
            </Link>
          </div>
          {shown.length === 0 ? <p>該当する取引先はありません。</p> : null}
          {shown.map((c) => (
            <Link key={c.id} className="m-card" href={`/clients/edit/?id=${c.id}`}>
              <strong>{c.name}</strong>
              <span className="m-sub">
                <span className="m-badge">{kindLabel(c.kind)}</span>
                {c.closing_day ? `締め ${closingDayLabel(c.closing_day)}` : ""} {c.phone ?? ""}
              </span>
            </Link>
          ))}
        </>
      ) : null}
    </Shell>
  );
}
