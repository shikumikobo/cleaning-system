"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ContractShell, Loading, Notice, useContractCtx } from "@/components/contracts/Shell";
import { contractKindLabel, contractStatusLabel, filterContracts } from "@/lib/contracts/format";
import { listContracts } from "@/lib/contracts/repo";
import type { Contract } from "@/lib/contracts/types";
import { listBuildings, listClients } from "@/lib/masters/repo";
import { formatDateJa } from "@/lib/quotes/format";

export default function ContractsPage() {
  const { ctx, error } = useContractCtx();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [clients, setClients] = useState<Record<string, string>>({});
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void Promise.all([listContracts(ctx.sb, ctx.tenantId), listClients(ctx.sb, ctx.tenantId), listBuildings(ctx.sb, ctx.tenantId)])
      .then(([cs, cl, bs]) => {
        if (cancelled) return;
        setContracts(cs);
        setClients(Object.fromEntries(cl.map((c) => [c.id, c.name])));
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
      })
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const names = useMemo(() => ({ clients, buildings }), [clients, buildings]);
  const shown = filterContracts(contracts, names, { q, status });

  return (
    <ContractShell title="契約" active="contracts">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx ? (
        <>
          <div className="m-bar">
            <input type="search" placeholder="取引先・建物で探す" aria-label="取引先・建物で探す" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="状況" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
              <option value="">すべての状況</option>
              <option value="active">有効</option>
              <option value="ended">終了</option>
            </select>
            {ctx.canEdit ? (
              <Link className="m-btn" href="/contracts/new/" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                見積から契約を作る
              </Link>
            ) : null}
          </div>
          {shown.length === 0 ? <p>該当する契約はありません。</p> : null}
          {shown.map((c) => (
            <Link key={c.id} className="m-card" href={`/contracts/detail/?id=${c.id}`}>
              <strong>
                <span className={`q-status ${c.status === "active" ? "approved" : ""}`}>{contractStatusLabel(c.status)}</span>
                {clients[c.client_id] ?? ""} ／ {buildings[c.building_id] ?? ""}
              </strong>
              <span className="m-sub">
                {contractKindLabel(c.kind)} ／ {formatDateJa(c.start_date)}〜{c.end_date ? formatDateJa(c.end_date) : "期限なし"}
              </span>
            </Link>
          ))}
        </>
      ) : null}
    </ContractShell>
  );
}
