"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loading, Notice, Shell, useMasters } from "@/components/masters/Shell";
import { filterByName } from "@/lib/masters/format";
import { listBuildings, listClients } from "@/lib/masters/repo";
import type { Building, Client } from "@/lib/masters/types";

export default function BuildingsPage() {
  const { ctx, error } = useMasters();
  const [items, setItems] = useState<Building[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void Promise.all([listBuildings(ctx.sb, ctx.tenantId), listClients(ctx.sb, ctx.tenantId)])
      .then(([b, c]) => {
        if (cancelled) return;
        setItems(b);
        setClients(c);
      })
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const clientName = (id: string | null) => clients.find((c) => c.id === id)?.name ?? "";
  const shown = filterByName(items, q).filter((b) => !clientId || b.client_id === clientId);

  return (
    <Shell title="建物" active="buildings">
      <Loading error={error} ctx={ctx} />
      <Notice text={msg} />
      {ctx ? (
        <>
          <div className="m-bar">
            <input type="search" placeholder="名前で探す" aria-label="名前で探す" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="依頼元" value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ width: "auto" }}>
              <option value="">すべての依頼元</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Link className="m-btn" href="/buildings/edit/" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              新規登録
            </Link>
          </div>
          {shown.length === 0 ? <p>該当する建物はありません。</p> : null}
          {shown.map((b) => (
            <Link key={b.id} className="m-card" href={`/buildings/edit/?id=${b.id}`}>
              <strong>{b.name}</strong>
              <span className="m-sub">{b.address}</span>
              <span className="m-sub">依頼元：{clientName(b.client_id)}</span>
            </Link>
          ))}
        </>
      ) : null}
    </Shell>
  );
}
