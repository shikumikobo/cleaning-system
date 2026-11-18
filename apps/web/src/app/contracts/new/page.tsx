"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { ContractShell, Field, Loading, Notice, useContractCtx } from "@/components/contracts/Shell";
import { contractActionMessage, validateStart } from "@/lib/contracts/format";
import { createContractFromQuote, listApprovedQuotes, listContracts, regenerateWorks, type ApprovedQuote } from "@/lib/contracts/repo";
import { listBuildings, listClients } from "@/lib/masters/repo";
import { formatYen, quoteKindLabel, todayJst } from "@/lib/quotes/format";

function NewContract() {
  const { ctx, error } = useContractCtx();
  const router = useRouter();
  const presetQuote = useSearchParams().get("quote") ?? "";
  const [quotes, setQuotes] = useState<ApprovedQuote[]>([]);
  const [clients, setClients] = useState<Record<string, string>>({});
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [quoteId, setQuoteId] = useState(presetQuote);
  const [start, setStart] = useState(todayJst());
  const [end, setEnd] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void Promise.all([listApprovedQuotes(ctx.sb, ctx.tenantId), listContracts(ctx.sb, ctx.tenantId), listClients(ctx.sb, ctx.tenantId), listBuildings(ctx.sb, ctx.tenantId)])
      .then(([qs, cs, cl, bs]) => {
        if (cancelled) return;
        const used = new Set(cs.map((c) => c.quote_id));
        setQuotes(qs.filter((x) => !used.has(x.id)));
        setClients(Object.fromEntries(cl.map((c) => [c.id, c.name])));
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
      })
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setMsg(null);
    if (!quoteId) return setMsg("見積を選んでください");
    const problem = validateStart(start, end);
    setFieldError(problem ?? undefined);
    if (problem) return;
    setBusy(true);
    try {
      const r = await createContractFromQuote(ctx.sb, quoteId, start, end || null);
      if (!r.ok || !r.id) return setMsg(contractActionMessage(r.reason));
      await regenerateWorks(ctx.sb, r.id); // 失敗しても、次の定時の処理が予定を作る
      router.push(`/contracts/detail/?id=${r.id}`);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ContractShell title="見積から契約を作る" active="contracts">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx && !ctx.canEdit ? <p>契約を作る権限がありません。</p> : null}
      {ctx && ctx.canEdit ? (
        <form onSubmit={onSubmit}>
          <Field label="承認された見積">
            <select aria-label="承認された見積" value={quoteId} onChange={(e) => setQuoteId(e.target.value)}>
              <option value="">選んでください</option>
              {quotes.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.number ?? ""} {clients[x.client_id] ?? ""} ／ {buildings[x.building_id] ?? ""} ／ {quoteKindLabel(x.kind)} ／ {formatYen(x.total)}
                </option>
              ))}
            </select>
          </Field>
          {quotes.length === 0 ? <p className="m-sub">契約にしていない、承認された見積はありません。</p> : null}
          <Field label="開始日" error={fieldError}>
            <input type="date" aria-label="開始日" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="終了日（決まっていれば）">
            <input type="date" aria-label="終了日" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <p className="m-sub">見積の明細が清掃の中身になります（基本は毎月、オプションと単発は行った回ごとに請求）。作ると、今日から2か月先までの予定が作られます。</p>
          <button className="m-btn" type="submit" disabled={busy}>
            契約を作る
          </button>
        </form>
      ) : null}
    </ContractShell>
  );
}

export default function NewContractPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <NewContract />
    </Suspense>
  );
}
