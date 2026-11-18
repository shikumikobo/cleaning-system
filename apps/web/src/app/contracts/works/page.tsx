"use client";

import { useEffect, useMemo, useState } from "react";
import { ContractShell, Loading, Notice, useContractCtx } from "@/components/contracts/Shell";
import { filterWorks, timeRange, workStatusLabel } from "@/lib/contracts/format";
import { listWorks } from "@/lib/contracts/repo";
import type { Work } from "@/lib/contracts/types";
import { listBuildings } from "@/lib/masters/repo";
import { formatDateJa, todayJst } from "@/lib/quotes/format";

/** 予定の一覧（簡単なもの。予定表・割り当ては 012） */
export default function WorksPage() {
  const { ctx, error } = useContractCtx();
  const [works, setWorks] = useState<Work[]>([]);
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [building, setBuilding] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void Promise.all([listWorks(ctx.sb, ctx.tenantId, todayJst()), listBuildings(ctx.sb, ctx.tenantId)])
      .then(([ws, bs]) => {
        if (cancelled) return;
        setWorks(ws);
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
      })
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const shown = useMemo(() => filterWorks(works, { status, building }), [works, status, building]);

  return (
    <ContractShell title="予定" active="works">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx ? (
        <>
          <div className="m-bar">
            <select aria-label="建物" value={building} onChange={(e) => setBuilding(e.target.value)} style={{ width: "auto" }}>
              <option value="">すべての建物</option>
              {Object.entries(buildings).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select aria-label="状況" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
              <option value="">取消を除くすべて</option>
              <option value="scheduled">予定</option>
              <option value="in_progress">作業中</option>
              <option value="done">完了</option>
              <option value="skipped">行わず</option>
              <option value="cancelled">取消</option>
            </select>
          </div>
          <p className="m-sub">今日以降の予定です。毎朝の定時の処理が、2か月先まで作ります。</p>
          {shown.length === 0 ? <p>該当する予定はありません。</p> : null}
          {shown.map((w) => (
            <div key={w.id} className="m-card">
              <strong>
                <span className="q-status">{workStatusLabel(w.status)}</span>
                {formatDateJa(w.scheduled_date)} {timeRange(w.start_time, w.end_time)}
              </strong>
              <span className="m-sub">
                {buildings[w.building_id] ?? ""} ／ {w.title}
              </span>
            </div>
          ))}
        </>
      ) : null}
    </ContractShell>
  );
}
