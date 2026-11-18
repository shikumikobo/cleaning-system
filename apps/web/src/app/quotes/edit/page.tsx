"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RecurrencePicker } from "@/components/quotes/RecurrencePicker";
import { Field, Loading, Notice, QuoteShell, useQuoteCtx, type QuoteCtx } from "@/components/quotes/Shell";
import { listBuildings, listClients } from "@/lib/masters/repo";
import type { Building, Client } from "@/lib/masters/types";
import { calcQuote } from "@/lib/quotes/calc";
import {
  actionMessage, formatDateJa, formatPercent, formatYen, lineKindLabel, quoteKindLabel, statusLabel, todayJst,
} from "@/lib/quotes/format";
import {
  approveQuote, createQuote, deleteLine, deleteQuote, getQuote, listItems, listLines, rejectQuote, reviseQuote, saveLine,
  submitQuote, updateQuoteHeader, type LineInput, type QuoteHeaderInput,
} from "@/lib/quotes/repo";
import { rruleToJa } from "@/lib/quotes/rrule";
import type { Item, Quote, QuoteLine } from "@/lib/quotes/types";
import { submitIssues, validateHeader, validateLine, type Errors } from "@/lib/quotes/validate";

const EMPTY_HEADER: QuoteHeaderInput = { client_id: "", building_id: "", kind: "request", tax_percent: "10", valid_until: "", note: "" };
const EMPTY_LINE: LineInput = { item_id: null, line_kind: "one_time", name: "", qty: "1", unit: "式", unit_price: "0", recurrence: "" };

function Editor({ ctx }: { ctx: QuoteCtx }) {
  const router = useRouter();
  const id = useSearchParams().get("id");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [lines, setLines] = useState<QuoteLine[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [form, setForm] = useState<QuoteHeaderInput>(EMPTY_HEADER);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setMsg(e instanceof Error ? e.message : String(e));

  const load = useCallback(async () => {
    const [cs, bs, its] = await Promise.all([listClients(ctx.sb, ctx.tenantId), listBuildings(ctx.sb, ctx.tenantId), listItems(ctx.sb, ctx.tenantId).catch(() => [] as Item[])]);
    setClients(cs);
    setBuildings(bs);
    setItems(its);
    if (!id) return;
    const q = await getQuote(ctx.sb, ctx.tenantId, id);
    if (!q) {
      setQuote(null);
      setMsg("見積が見つかりません（消されたか、見る権限がありません）");
      return;
    }
    setQuote(q);
    setForm({
      client_id: q.client_id,
      building_id: q.building_id,
      kind: q.kind,
      tax_percent: formatPercent(q.tax_rate).replace("%", ""),
      valid_until: q.valid_until ?? "",
      note: q.note ?? "",
    });
    setLines(await listLines(ctx.sb, q.id));
  }, [ctx, id]);

  useEffect(() => {
    let cancelled = false;
    void load().catch((e) => !cancelled && fail(e));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const draft = !id || quote?.status === "draft";
  const editable = ctx.canEdit && draft;
  const totals = useMemo(() => calcQuote(lines, quote?.tax_rate ?? 0.1), [lines, quote?.tax_rate]);
  const shown = quote && quote.status !== "draft" ? { subtotal: quote.subtotal, tax: quote.tax, total: quote.total } : totals;
  const clientName = (cid: string) => clients.find((c) => c.id === cid)?.name ?? "";
  const buildingName = (bid: string) => buildings.find((b) => b.id === bid)?.name ?? "";
  const buildingChoices = useMemo(() => {
    const own = buildings.filter((b) => b.client_id === form.client_id || b.owner_client_id === form.client_id);
    return own.length > 0 ? own : buildings;
  }, [buildings, form.client_id]);

  const set = (k: keyof QuoteHeaderInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSaveHeader(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setOk(null);
    const errs = validateHeader(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      if (id) {
        await updateQuoteHeader(ctx.sb, id, form);
        setOk("保存しました");
        await load();
      } else {
        const created = await createQuote(ctx.sb, ctx.tenantId, form);
        router.replace(`/quotes/edit/?id=${created.id}`);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<{ ok: boolean; reason?: string; id?: string; already?: boolean }>, done: string, after?: (r: { id?: string }) => void) {
    setMsg(null);
    setOk(null);
    setBusy(true);
    try {
      const r = await run();
      if (!r.ok) {
        setMsg(actionMessage(r.reason));
        return;
      }
      setOk(done);
      if (after) after(r);
      else await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit() {
    if (!quote) return;
    const issues = submitIssues(quote, lines, todayJst());
    if (issues.length > 0) return setMsg(issues.map(actionMessage).join("。"));
    if (!window.confirm("提出すると、番号が付き、合計が決まります。提出したあとは直せません（直すときは新しい版を作ります）。提出しますか？")) return;
    void act(() => submitQuote(ctx.sb, quote.id), "提出しました");
  }
  function onApprove() {
    if (!quote || !window.confirm("取引先から返事をもらったものとして、この見積を「承認」で記録します。よいですか？")) return;
    void act(() => approveQuote(ctx.sb, quote.id), "承認で記録しました。関係する人にお知らせを作りました");
  }
  function onReject() {
    if (!quote) return;
    const note = window.prompt("「不成立」で記録します。理由があれば入れてください（空でもよい）", "");
    if (note === null) return;
    void act(() => rejectQuote(ctx.sb, quote.id, note), "不成立で記録しました");
  }
  function onRevise() {
    if (!quote) return;
    void act(() => reviseQuote(ctx.sb, quote.id), "直した版（下書き）を作りました", (r) => r.id && router.push(`/quotes/edit/?id=${r.id}`));
  }
  async function onDelete() {
    if (!quote || !window.confirm("この下書きの見積を消しますか？")) return;
    setBusy(true);
    try {
      await deleteQuote(ctx.sb, quote.id);
      router.replace("/quotes/");
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  return (
    <>
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {quote ? (
        <p>
          <span className={`q-status ${quote.status}`}>{statusLabel(quote.status)}</span>
          {quote.number ? <strong>{quote.number}</strong> : <span className="m-sub">（番号は提出のときに付きます）</span>}
          {quote.issue_date ? <span className="m-sub"> 発行 {formatDateJa(quote.issue_date)}</span> : null}
          {quote.previous_id ? (
            <span className="m-sub">
              {" "}
              ／ <Link href={`/quotes/edit/?id=${quote.previous_id}`}>直す前の版</Link>
            </span>
          ) : null}
          {quote.status === "rejected" && quote.decision_note ? <span className="m-sub"> ／ 理由：{quote.decision_note}</span> : null}
        </p>
      ) : null}

      {editable ? (
        <form className="m-form two" onSubmit={onSaveHeader} noValidate>
          <Field label="取引先" error={errors.client_id}>
            <select value={form.client_id} onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value, building_id: "" }))}>
              <option value="">選んでください</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="建物" error={errors.building_id}>
            <select value={form.building_id} onChange={set("building_id")}>
              <option value="">選んでください</option>
              {buildingChoices.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="種類" error={errors.kind}>
            <select value={form.kind} onChange={set("kind")}>
              <option value="request">案件</option>
              <option value="recurring">定期（基本の月額とオプション）</option>
              <option value="special">特別清掃</option>
            </select>
          </Field>
          <Field label="税率（%）" error={errors.tax_percent}>
            <input value={form.tax_percent} onChange={set("tax_percent")} inputMode="decimal" />
          </Field>
          <Field label="有効期限（空なら、提出の日から 30 日）" error={errors.valid_until}>
            <input type="date" value={form.valid_until} onChange={set("valid_until")} />
          </Field>
          <Field label="備考（見積書に載ります）" wide>
            <textarea value={form.note} onChange={set("note")} />
          </Field>
          <div className="m-row wide">
            <button className="m-btn" type="submit" disabled={busy}>
              {id ? "保存する" : "下書きを作る"}
            </button>
          </div>
        </form>
      ) : quote ? (
        <div className="m-form two">
          <div className="m-field"><label>取引先</label>{clientName(quote.client_id)}</div>
          <div className="m-field"><label>建物</label>{buildingName(quote.building_id)}</div>
          <div className="m-field"><label>種類</label>{quoteKindLabel(quote.kind)}</div>
          <div className="m-field"><label>税率</label>{formatPercent(quote.tax_rate)}</div>
          <div className="m-field"><label>有効期限</label>{formatDateJa(quote.valid_until)}</div>
          {quote.note ? <div className="m-field wide"><label>備考</label>{quote.note}</div> : null}
        </div>
      ) : null}

      {quote ? (
        <div className="m-section">
          <h2>明細</h2>
          <Lines ctx={ctx} quote={quote} lines={lines} items={items} editable={editable} reload={load} onError={setMsg} />
          <div className="q-total" aria-label="合計">
            <div><span>小計</span><span className="num">{formatYen(shown.subtotal)}</span></div>
            <div><span>消費税（{formatPercent(quote.tax_rate)}）</span><span className="num">{formatYen(shown.tax)}</span></div>
            <div className="grand"><span>合計</span><span className="num">{formatYen(shown.total)}</span></div>
            {draft ? <span className="m-sub">下書きの合計は、画面で計算しています。提出すると確定します。</span> : null}
          </div>

          <div className="q-actions">
            {ctx.canEdit && quote.status === "draft" ? (
              <>
                <button className="m-btn" type="button" disabled={busy} onClick={onSubmit}>提出する</button>
                <button className="m-btn danger" type="button" disabled={busy} onClick={onDelete}>この下書きを消す</button>
              </>
            ) : null}
            {ctx.canEdit && quote.status === "submitted" ? (
              <>
                <button className="m-btn" type="button" disabled={busy} onClick={onApprove}>承認で記録する</button>
                <button className="m-btn danger" type="button" disabled={busy} onClick={onReject}>不成立で記録する</button>
              </>
            ) : null}
            {ctx.canEdit && (quote.status === "submitted" || quote.status === "rejected") ? (
              <button className="m-btn sub" type="button" disabled={busy} onClick={onRevise}>直した版を作る</button>
            ) : null}
            {ctx.canEdit && quote.status === "approved" ? (
              <Link className="m-btn" href={`/contracts/new/?quote=${quote.id}`} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                契約を作る
              </Link>
            ) : null}
            <Link className="m-btn sub" href={`/quotes/print/?id=${quote.id}`} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              印刷（見積書）
            </Link>
          </div>
        </div>
      ) : (
        <p className="m-sub">取引先と建物を選んで下書きを作ると、明細を入れられます。案件がなくても作れます。</p>
      )}
    </>
  );
}

function Lines({
  ctx, quote, lines, items, editable, reload, onError,
}: {
  ctx: QuoteCtx;
  quote: Quote;
  lines: QuoteLine[];
  items: Item[];
  editable: boolean;
  reload: () => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null); // 直している明細の id（"" は新規）
  const [form, setForm] = useState<LineInput>(EMPTY_LINE);
  const [errors, setErrors] = useState<Errors>({});
  const recurring = quote.kind === "recurring";

  function start(l: QuoteLine | null) {
    setEditing(l?.id ?? "");
    setErrors({});
    onError(null);
    setForm(
      l
        ? { item_id: l.item_id, line_kind: l.line_kind, name: l.name, qty: String(l.qty), unit: l.unit, unit_price: String(l.unit_price), recurrence: l.recurrence ?? "" }
        : { ...EMPTY_LINE, line_kind: recurring ? "base" : "one_time", recurrence: recurring ? "FREQ=MONTHLY" : "" },
    );
  }
  function pickItem(itemId: string) {
    const it = items.find((x) => x.id === itemId);
    if (!it) return setForm((f) => ({ ...f, item_id: null }));
    // 品名・単位・単価・種類は写して持つ（あとで候補を直しても、この明細は変わらない）
    setForm((f) => ({
      ...f,
      item_id: it.id,
      name: it.name,
      unit: it.unit,
      unit_price: String(it.unit_price),
      line_kind: it.kind,
      recurrence: recurring && it.kind !== "one_time" ? f.recurrence || "FREQ=MONTHLY" : "",
    }));
  }
  function setKind(kind: string) {
    setForm((f) => ({ ...f, line_kind: kind, recurrence: recurring && kind !== "one_time" ? f.recurrence || "FREQ=MONTHLY" : "" }));
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const errs = validateLine(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    try {
      await saveLine(ctx.sb, ctx.tenantId, quote.id, editing || null, { ...form, sort: (lines.at(-1)?.sort ?? 0) + 1 });
      setEditing(null);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }
  async function onDelete(l: QuoteLine) {
    if (!window.confirm(`明細「${l.name}」を消しますか？`)) return;
    try {
      await deleteLine(ctx.sb, l.id);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  const live = items.filter((it) => !it.deleted_at);
  return (
    <>
      {lines.length === 0 ? <p className="m-sub">明細はまだありません。</p> : null}
      {lines.length > 0 ? (
        <table className="q-lines">
          <thead>
            <tr>
              <th>種類</th><th>品名</th><th className="num">数量</th><th>単位</th><th className="num">単価</th><th className="num">金額</th><th>頻度</th><th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>{lineKindLabel(l.line_kind)}</td>
                <td>{l.name}</td>
                <td className="num">{Number(l.qty)}</td>
                <td>{l.unit}</td>
                <td className="num">{formatYen(l.unit_price)}</td>
                <td className="num">{formatYen(quote.status === "draft" ? calcQuote([l], 0).subtotal : l.amount)}</td>
                <td className="q-freq">{l.recurrence ? rruleToJa(l.recurrence) : ""}</td>
                <td>
                  {editable ? (
                    <span className="m-row">
                      <button className="m-btn sub" type="button" onClick={() => start(l)}>直す</button>
                      <button className="m-btn danger" type="button" onClick={() => onDelete(l)}>消す</button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {editable && editing === null ? (
        <p>
          <button className="m-btn sub" type="button" onClick={() => start(null)}>明細を追加</button>
        </p>
      ) : null}

      {editable && editing !== null ? (
        <form className="m-form two" onSubmit={onSave} noValidate>
          <Field label="品名の候補から選ぶ（なくてもよい）" wide>
            <select value={form.item_id ?? ""} onChange={(e) => pickItem(e.target.value)}>
              <option value="">（候補を使わず、自分で入れる）</option>
              {live.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}（{formatYen(it.unit_price)} / {it.unit}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="種類" error={errors.line_kind}>
            <select value={form.line_kind} onChange={(e) => setKind(e.target.value)}>
              <option value="base">基本</option>
              <option value="option">オプション</option>
              <option value="one_time">単発</option>
            </select>
          </Field>
          <Field label="品名" error={errors.name}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="数量" error={errors.qty}>
            <input value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="単位" error={errors.unit}>
            <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          </Field>
          <Field label="単価（円）" error={errors.unit_price}>
            <input value={form.unit_price} onChange={(e) => setForm({ ...form, unit_price: e.target.value })} inputMode="numeric" />
          </Field>
          {recurring && form.line_kind !== "one_time" ? (
            <div className="wide">
              <RecurrencePicker value={form.recurrence} onChange={(rule) => setForm((f) => ({ ...f, recurrence: rule }))} />
              {errors.recurrence ? <span className="m-err">{errors.recurrence}</span> : null}
            </div>
          ) : null}
          <div className="m-row wide">
            <button className="m-btn" type="submit">保存する</button>
            <button className="m-btn sub" type="button" onClick={() => setEditing(null)}>やめる</button>
          </div>
        </form>
      ) : null}
    </>
  );
}

function Inner() {
  const { ctx, error } = useQuoteCtx();
  const id = useSearchParams().get("id");
  return (
    <QuoteShell title={id ? "見積" : "見積を作る"} active="quotes">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      {ctx ? <Editor key={id ?? "new"} ctx={ctx} /> : null}
    </QuoteShell>
  );
}

export default function QuoteEditPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Inner />
    </Suspense>
  );
}
