"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { ContractShell, Field, Loading, Notice, useContractCtx, type ContractCtx } from "@/components/contracts/Shell";
import { RecurrencePicker } from "@/components/quotes/RecurrencePicker";
import {
  billingLabel,
  buildChanges,
  contractActionMessage,
  contractKindLabel,
  contractStatusLabel,
  filterWorks,
  recurrenceLabel,
  serviceKindLabel,
  sortServices,
  timeRange,
  validateStart,
  workStatusLabel,
} from "@/lib/contracts/format";
import { changeContractService, endContract, getContract, listServices, listWorksOfContract, regenerateWorks } from "@/lib/contracts/repo";
import type { Contract, ContractService, Work } from "@/lib/contracts/types";
import { getBuilding, getClient } from "@/lib/masters/repo";
import { formatDateJa, formatYen, todayJst } from "@/lib/quotes/format";

function ChangeForm({ ctx, contract, service, onDone, onMessage }: { ctx: ContractCtx; contract: Contract; service: ContractService; onDone: () => void; onMessage: (m: string) => void }) {
  const [name, setName] = useState(service.name);
  const [amount, setAmount] = useState(String(service.amount));
  const [recurrence, setRecurrence] = useState(service.recurrence);
  const [effective, setEffective] = useState(todayJst());
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const built = buildChanges(service, { name, amount, recurrence });
    setProblem(built.error ?? undefined);
    if (built.error) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) return setProblem("適用日を入れてください");
    if (Object.keys(built.changes).length === 0) return setProblem(contractActionMessage("nothing_to_change"));
    if (!window.confirm(`${formatDateJa(effective)}から、この中身を変えます。それ以降の、まだ始まっていない予定は取り消して作り直します。よろしいですか？`)) return;
    setBusy(true);
    try {
      const r = await changeContractService(ctx.sb, service.id, effective, built.changes);
      if (!r.ok) return setProblem(contractActionMessage(r.reason));
      await regenerateWorks(ctx.sb, contract.id);
      onMessage(`変えました（取り消した予定：${r.cancelled ?? 0}件。新しい中身で作り直します）`);
      onDone();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label={`${service.name}を変える`} className="m-card">
      <Field label="名前">
        <input aria-label="名前" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="金額（円）">
        <input aria-label="金額" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <RecurrencePicker value={recurrence} onChange={setRecurrence} />
      <Field label="適用日（この日から変わる）" error={problem}>
        <input type="date" aria-label="適用日" value={effective} onChange={(e) => setEffective(e.target.value)} />
      </Field>
      <button className="m-btn" type="submit" disabled={busy}>
        変える
      </button>
    </form>
  );
}

function Detail() {
  const { ctx, error } = useContractCtx();
  const id = useSearchParams().get("id");
  const [contract, setContract] = useState<Contract | null>(null);
  const [client, setClient] = useState("");
  const [building, setBuilding] = useState("");
  const [services, setServices] = useState<ContractService[]>([]);
  const [works, setWorks] = useState<Work[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [endDate, setEndDate] = useState(todayJst());
  const [endProblem, setEndProblem] = useState<string | undefined>();
  const [msg, setMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!ctx || !id) return;
    try {
      const c = await getContract(ctx.sb, ctx.tenantId, id);
      setContract(c);
      if (c) {
        const [cl, b, sv] = await Promise.all([getClient(ctx.sb, ctx.tenantId, c.client_id), getBuilding(ctx.sb, ctx.tenantId, c.building_id), listServices(ctx.sb, ctx.tenantId, c.id)]);
        setClient(cl?.name ?? "");
        setBuilding(b?.name ?? "");
        setServices(sv);
        setWorks(await listWorksOfContract(ctx.sb, ctx.tenantId, sv.map((s) => s.id)));
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [ctx, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onEnd(e: FormEvent) {
    e.preventDefault();
    if (!ctx || !contract) return;
    const problem = validateStart(contract.start_date, endDate);
    setEndProblem(problem ?? undefined);
    if (problem) return;
    if (!window.confirm(`${formatDateJa(endDate)}で契約を終えます。それより後の予定は取り消します。よろしいですか？`)) return;
    try {
      const r = await endContract(ctx.sb, contract.id, endDate);
      if (!r.ok) return setEndProblem(contractActionMessage(r.reason));
      setOkMsg(`契約を終えました（取り消した予定：${r.cancelled ?? 0}件）`);
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  const ordered = sortServices(services);
  const today = todayJst();
  const upcoming = filterWorks(works, { status: "", building: "" }).filter((w) => w.scheduled_date >= today);
  const active = contract?.status === "active";

  return (
    <ContractShell title="契約の詳細" active="contracts">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      <Notice text={okMsg} kind="ok" />
      {ctx && loaded && !contract ? <p>契約が見つかりません。</p> : null}
      {ctx && contract ? (
        <div>
          <p>
            <span className={`q-status ${active ? "approved" : ""}`}>{contractStatusLabel(contract.status)}</span>
            <strong>
              {client} ／ {building}
            </strong>
          </p>
          <p className="m-sub">
            {contractKindLabel(contract.kind)} ／ {formatDateJa(contract.start_date)}〜{contract.end_date ? formatDateJa(contract.end_date) : "期限なし"}
            {contract.quote_id ? (
              <>
                {" ／ "}
                <Link href={`/quotes/edit/?id=${contract.quote_id}`}>元の見積</Link>
              </>
            ) : (
              " ／ 取り込み"
            )}
          </p>

          <h2>清掃の中身</h2>
          {ordered.length === 0 ? <p>中身がありません。</p> : null}
          {ordered.map((s) => (
            <div key={s.id} className="m-card" aria-label={`中身 ${s.name}`}>
              <strong>
                {s.valid_to ? <span className="q-status">過去の内容</span> : null}
                {serviceKindLabel(s.service_kind)}：{s.name}
              </strong>
              <span className="m-sub">
                {formatYen(s.amount)}（{billingLabel(s.billing)}） ／ {recurrenceLabel(s.recurrence)}
                {timeRange(s.start_time, s.end_time) ? ` ／ ${timeRange(s.start_time, s.end_time)}` : ""}
              </span>
              <span className="m-sub">
                {formatDateJa(s.valid_from)}から{s.valid_to ? `${formatDateJa(s.valid_to)}まで` : ""}
              </span>
              {ctx.canEdit && active && !s.valid_to ? (
                <button className="m-btn sub" type="button" onClick={() => setEditing(editing === s.id ? null : s.id)}>
                  {editing === s.id ? "変更をやめる" : "この中身を変える"}
                </button>
              ) : null}
              {editing === s.id ? (
                <ChangeForm
                  ctx={ctx}
                  contract={contract}
                  service={s}
                  onDone={() => {
                    setEditing(null);
                    void load();
                  }}
                  onMessage={setOkMsg}
                />
              ) : null}
            </div>
          ))}

          <h2>これからの予定</h2>
          {upcoming.length === 0 ? <p>これからの予定はありません。</p> : null}
          {upcoming.slice(0, 20).map((w) => (
            <div key={w.id} className="m-card">
              <strong>
                <span className="q-status">{workStatusLabel(w.status)}</span>
                {formatDateJa(w.scheduled_date)} {timeRange(w.start_time, w.end_time)}
              </strong>
              <span className="m-sub">{w.title}</span>
            </div>
          ))}
          <p>
            <Link href="/contracts/works/">予定の一覧へ</Link>
          </p>

          {ctx.canEdit && active ? (
            <form onSubmit={onEnd} aria-label="契約を終える">
              <h2>契約を終える</h2>
              <Field label="終了日" error={endProblem}>
                <input type="date" aria-label="終了日" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
              <button className="m-btn danger" type="submit">
                契約を終える
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </ContractShell>
  );
}

export default function ContractDetailPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Detail />
    </Suspense>
  );
}
