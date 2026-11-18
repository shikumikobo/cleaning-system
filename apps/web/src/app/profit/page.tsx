"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Field, Loading, Notice, NO_PERMISSION, ProfitShell, useProfitCtx } from "@/components/profit/Shell";
import { contractKindLabel } from "@/lib/contracts/format";
import { listContracts } from "@/lib/contracts/repo";
import { listBuildings, listClients } from "@/lib/masters/repo";
import { compareTotals, groupRows, isMonth, marginPct, prevMonth, prevYearMonth, sumRows, type Comparison } from "@/lib/profit/calc";
import { deltaText, formatYen, monthLabel, pctText } from "@/lib/profit/format";
import { listProfit } from "@/lib/profit/repo";
import type { GroupBy, Names, ProfitRow } from "@/lib/profit/types";
import { todayJst } from "@/lib/quotes/format";

/** 前の月（日本時間）。月が終わってから見ることが多い */
function lastMonth(now: Date = new Date()): string {
  const t = todayJst(now);
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const BY: Record<GroupBy, string> = { contract: "契約ごと", building: "建物ごと", client: "取引先ごと" };

function CompareLine({ title, c }: { title: string; c: Comparison }) {
  return (
    <p className="m-sub" role="group" aria-label={title}>
      <strong>{title}</strong>：売上 {deltaText(c.revenue)} ／ 費用 {deltaText(c.cost)} ／ 粗利 {deltaText(c.gross)}
    </p>
  );
}

export default function ProfitPage() {
  const { ctx, error } = useProfitCtx();
  const [month, setMonth] = useState(lastMonth());
  const [by, setBy] = useState<GroupBy>("building");
  const [rows, setRows] = useState<ProfitRow[]>([]);
  const [names, setNames] = useState<Names>({ clients: {}, buildings: {}, contracts: {} });
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const valid = isMonth(month);
  const prev = valid ? prevMonth(month) : null;
  const prevYear = valid ? prevYearMonth(month) : null;

  // 名前（取引先・建物・契約）は月に関係ない。会社が変わったときだけ読む
  useEffect(() => {
    if (!ctx || !ctx.canRead) return;
    let cancelled = false;
    void Promise.all([listClients(ctx.sb, ctx.tenantId), listBuildings(ctx.sb, ctx.tenantId), listContracts(ctx.sb, ctx.tenantId)])
      .then(([cs, bs, cts]) => {
        if (cancelled) return;
        const buildings = Object.fromEntries(bs.map((b) => [b.id, b.name]));
        setNames({
          clients: Object.fromEntries(cs.map((c) => [c.id, c.name])),
          buildings,
          contracts: Object.fromEntries(cts.map((c) => [c.id, `${buildings[c.building_id] ?? "（建物）"} ${contractKindLabel(c.kind)}（${c.start_date}〜）`])),
        });
      })
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const load = useCallback(async () => {
    if (!ctx || !ctx.canRead || !prev || !prevYear) return;
    setRows(await listProfit(ctx.sb, ctx.tenantId, [month, prev, prevYear]));
    setLoaded(true);
  }, [ctx, month, prev, prevYear]);

  useEffect(() => {
    let cancelled = false;
    setMsg(null);
    void load().catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const inMonth = useCallback((m: string | null) => rows.filter((r) => m !== null && r.month.slice(0, 7) === m), [rows]);
  const cur = useMemo(() => sumRows(inMonth(month)), [inMonth, month]);
  const groups = useMemo(() => groupRows(inMonth(month), by, names), [inMonth, month, by, names]);
  const vsPrev = useMemo(() => compareTotals(cur, sumRows(inMonth(prev))), [cur, inMonth, prev]);
  const vsYear = useMemo(() => compareTotals(cur, sumRows(inMonth(prevYear))), [cur, inMonth, prevYear]);

  return (
    <ProfitShell title="売上と粗利" active="profit">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx && !ctx.canRead ? <Notice text={NO_PERMISSION} /> : null}
      {ctx && ctx.canRead ? (
        <>
          <div className="m-form two" role="group" aria-label="表示の条件">
            <Field label="月">
              <input type="month" aria-label="月" value={month} onChange={(e) => setMonth(e.target.value)} />
            </Field>
            <Field label="集め方">
              <select aria-label="集め方" value={by} onChange={(e) => setBy(e.target.value as GroupBy)}>
                {(Object.keys(BY) as GroupBy[]).map((k) => (
                  <option key={k} value={k}>
                    {BY[k]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {!valid ? <Notice text="月を選んでください（例：2026-10）" /> : null}
          {valid && loaded ? (
            <>
              <div className="m-card" role="group" aria-label="月の合計">
                <strong>{monthLabel(month)}の合計</strong>
                <span className="m-sub">
                  売上 {formatYen(cur.revenue)} ／ 費用 {formatYen(cur.cost)} ／ 粗利 {formatYen(cur.gross)}（粗利率 {pctText(marginPct(cur))}）
                </span>
                <span className="m-sub">
                  費用の中身：小口 {formatYen(cur.petty)} ／ 外注 {formatYen(cur.outsourcing)} ／ 材料 {formatYen(cur.material)} ／ その他 {formatYen(cur.other_cost)}
                </span>
                {cur.draft_revenue > 0 ? (
                  <span className="m-sub">請求書の下書きの分 {formatYen(cur.draft_revenue)} は、売上に入れていません（発行すると入ります）</span>
                ) : null}
              </div>
              <CompareLine title={`前の月（${monthLabel(prev!)}）との比べ`} c={vsPrev} />
              <CompareLine title={`前の年の同じ月（${monthLabel(prevYear!)}）との比べ`} c={vsYear} />

              <h2>{BY[by]}</h2>
              {groups.length === 0 ? <p>この月の売上と費用はありません。</p> : null}
              {groups.map((g) => (
                <div key={g.key ?? "none"} className="m-card" role="group" aria-label={g.label}>
                  <strong>{g.label}</strong>
                  <span className="m-sub">
                    売上 {formatYen(g.totals.revenue)} ／ 費用 {formatYen(g.totals.cost)} ／ 粗利 {formatYen(g.totals.gross)}（{pctText(marginPct(g.totals))}）
                  </span>
                  <span className="m-sub">
                    小口 {formatYen(g.totals.petty)} ／ 外注 {formatYen(g.totals.outsourcing)} ／ 材料 {formatYen(g.totals.material)} ／ その他 {formatYen(g.totals.other_cost)}
                    {g.totals.draft_revenue > 0 ? ` ／ 下書き ${formatYen(g.totals.draft_revenue)}` : ""}
                  </span>
                </div>
              ))}
              <p className="m-sub">売上は、発行した請求書の明細（税抜）。費用は、小口の確認済みの出金と、「費用」で入れたもの。</p>
            </>
          ) : null}
        </>
      ) : null}
    </ProfitShell>
  );
}
