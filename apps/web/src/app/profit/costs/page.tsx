"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Field, Loading, Notice, NO_PERMISSION, ProfitShell, useProfitCtx } from "@/components/profit/Shell";
import { contractKindLabel } from "@/lib/contracts/format";
import { listContracts } from "@/lib/contracts/repo";
import type { Contract } from "@/lib/contracts/types";
import { listBuildings } from "@/lib/masters/repo";
import { isMonth } from "@/lib/profit/calc";
import { COST_KINDS, costErrorMessage, costKindLabel, formatYen, monthLabel } from "@/lib/profit/format";
import { createCost, deleteCost, listCosts, updateCost } from "@/lib/profit/repo";
import type { Cost } from "@/lib/profit/types";
import { validateCost, type CostInput, type Errors } from "@/lib/profit/validate";
import { todayJst } from "@/lib/quotes/format";

function lastMonth(now: Date = new Date()): string {
  const t = todayJst(now);
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const blank = (month: string): CostInput => ({ month, kind: "outsourcing", amount: "", building_id: "", contract_id: "", note: "" });

export default function CostsPage() {
  const { ctx, error } = useProfitCtx();
  const [month, setMonth] = useState(lastMonth());
  const [costs, setCosts] = useState<Cost[]>([]);
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [form, setForm] = useState<CostInput>(blank(lastMonth()));
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ctx || !ctx.canRead) return;
    let cancelled = false;
    void Promise.all([listBuildings(ctx.sb, ctx.tenantId), listContracts(ctx.sb, ctx.tenantId)])
      .then(([bs, cts]) => {
        if (cancelled) return;
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
        setContracts(cts);
      })
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const load = useCallback(async () => {
    if (!ctx || !ctx.canRead || !isMonth(month)) return;
    setCosts(await listCosts(ctx.sb, ctx.tenantId, month));
  }, [ctx, month]);

  useEffect(() => {
    let cancelled = false;
    void load().catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const contractName = useCallback((c: Contract) => `${buildings[c.building_id] ?? "（建物）"} ${contractKindLabel(c.kind)}（${c.start_date}〜）`, [buildings]);
  const contractBuilding = useMemo(() => Object.fromEntries(contracts.map((c) => [c.id, c.building_id])), [contracts]);
  // 建物を選んだら、その建物の契約だけを出す（建物なしなら、全部の契約）
  const shownContracts = useMemo(() => contracts.filter((c) => !form.building_id || c.building_id === form.building_id), [contracts, form.building_id]);

  function pickMonth(m: string) {
    setMonth(m);
    if (!editing) setForm((f) => ({ ...f, month: m }));
  }

  function startEdit(c: Cost) {
    setOk(null);
    setMsg(null);
    setErrors({});
    setEditing(c.id);
    setForm({ month: c.month.slice(0, 7), kind: c.kind, amount: String(c.amount), building_id: c.building_id ?? "", contract_id: c.contract_id ?? "", note: c.note ?? "" });
  }
  function cancelEdit() {
    setEditing(null);
    setErrors({});
    setForm(blank(month));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setMsg(null);
    setOk(null);
    const errs = validateCost(form, contractBuilding);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      if (editing) await updateCost(ctx.sb, editing, form);
      else await createCost(ctx.sb, ctx.tenantId, form);
      setOk(editing ? "費用を直しました" : "費用を入れました");
      setEditing(null);
      setMonth(form.month);
      setForm(blank(form.month));
      await load();
    } catch (err) {
      setMsg(costErrorMessage(err as { code?: string; message?: string }));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!ctx) return;
    setMsg(null);
    setOk(null);
    setBusy(true);
    try {
      await deleteCost(ctx.sb, id);
      setConfirmId(null);
      if (editing === id) cancelEdit();
      setOk("費用を消しました");
      await load();
    } catch (err) {
      setMsg(costErrorMessage(err as { code?: string; message?: string }));
    } finally {
      setBusy(false);
    }
  }

  const total = costs.reduce((a, c) => a + c.amount, 0);

  return (
    <ProfitShell title="費用" active="costs">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {ctx && !ctx.canRead ? <Notice text={NO_PERMISSION} /> : null}
      {ctx && ctx.canRead ? (
        <>
          {ctx.canEdit ? (
            <form className="m-form two" onSubmit={onSubmit} noValidate aria-label={editing ? "費用を直す" : "費用を入れる"}>
              <Field label="月" error={errors.month}>
                <input type="month" aria-label="費用の月" value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} />
              </Field>
              <Field label="種類" error={errors.kind}>
                <select aria-label="種類" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {COST_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {costKindLabel(k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="金額（円）" error={errors.amount}>
                <input type="text" inputMode="numeric" aria-label="金額" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </Field>
              <Field label="建物（空なら、契約の建物。どちらも空なら共通の費用）" error={errors.building_id}>
                <select aria-label="建物" value={form.building_id} onChange={(e) => setForm({ ...form, building_id: e.target.value, contract_id: "" })}>
                  <option value="">（建物を決めない）</option>
                  {Object.entries(buildings).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="契約（空でもよい）" error={errors.contract_id}>
                <select aria-label="契約" value={form.contract_id} onChange={(e) => setForm({ ...form, contract_id: e.target.value })}>
                  <option value="">（契約を決めない）</option>
                  {shownContracts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {contractName(c)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="メモ">
                <input type="text" aria-label="メモ" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </Field>
              <div className="m-row wide">
                <button className="m-btn" type="submit" disabled={busy}>
                  {editing ? "直す" : "費用を入れる"}
                </button>
                {editing ? (
                  <button className="m-btn sub" type="button" onClick={cancelEdit}>
                    やめる
                  </button>
                ) : null}
                <span className="m-sub">小口で払った分は、確認済みになると自動で入ります。ここには、外注・材料など、小口以外の費用を入れます。</span>
              </div>
            </form>
          ) : null}

          <div className="m-bar">
            <input type="month" aria-label="見る月" value={month} onChange={(e) => pickMonth(e.target.value)} style={{ width: "auto" }} />
            <span className="m-sub">
              {monthLabel(month)}の費用 {costs.length} 件・合計 {formatYen(total)}
            </span>
          </div>
          {costs.length === 0 ? <p>この月に入れた費用はありません。</p> : null}
          {costs.map((c) => (
            <div key={c.id} className="m-card" role="group" aria-label={`費用 ${costKindLabel(c.kind)} ${formatYen(c.amount)}`}>
              <strong>
                <span className="m-badge">{costKindLabel(c.kind)}</span>
                {formatYen(c.amount)}
              </strong>
              <span className="m-sub">
                {c.building_id ? (buildings[c.building_id] ?? "（建物）") : "建物を決めない"}
                {c.contract_id ? ` ／ ${contracts.find((x) => x.id === c.contract_id) ? contractName(contracts.find((x) => x.id === c.contract_id)!) : "（契約）"}` : ""}
                {c.note ? ` ／ ${c.note}` : ""}
              </span>
              {ctx.canEdit ? (
                <span className="m-row">
                  <button className="m-btn sub" type="button" aria-label={`直す ${costKindLabel(c.kind)} ${formatYen(c.amount)}`} onClick={() => startEdit(c)}>
                    直す
                  </button>
                  {confirmId === c.id ? (
                    <>
                      <button className="m-btn danger" type="button" disabled={busy} onClick={() => void onDelete(c.id)}>
                        消す（この費用を一覧から外します）
                      </button>
                      <button className="m-btn sub" type="button" onClick={() => setConfirmId(null)}>
                        やめる
                      </button>
                    </>
                  ) : (
                    <button className="m-btn danger" type="button" aria-label={`消す ${costKindLabel(c.kind)} ${formatYen(c.amount)}`} onClick={() => setConfirmId(c.id)}>
                      消す
                    </button>
                  )}
                </span>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </ProfitShell>
  );
}
