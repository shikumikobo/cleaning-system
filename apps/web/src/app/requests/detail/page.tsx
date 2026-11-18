"use client";

// 案件の詳細：状況の変更（RPC。許された切り替えだけ出す）、中身の編集（request.edit）、金額（amount.read の人だけ）
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Field, Loading, Notice, RequestsShell, useRequestsSession } from "@/components/requests/Shell";
import { describeError } from "@/lib/errors";
import { selectableCandidates, sortRooms } from "@/lib/masters/format";
import { listBuildings, listClients, listRooms } from "@/lib/masters/repo";
import type { Building, Client, Room } from "@/lib/masters/types";
import { dueLabel, dueState, todayJst } from "@/lib/requests/due";
import {
  CATEGORY_LABEL,
  CATEGORY_OPTIONS,
  SOURCE_LABEL,
  STATUS_LABEL,
  canSeeAmount,
  nextStatuses,
  statusMessage,
} from "@/lib/requests/format";
import { deleteCharge, getCharge, getRequest, listAssignees, saveCharge, saveRequest, setRequestStatus, type RequestInput } from "@/lib/requests/repo";
import type { Assignee, RequestCharge, RequestRow } from "@/lib/requests/types";
import { validateCharge, validateRequest, type Errors } from "@/lib/requests/validate";

function toInput(r: RequestRow): RequestInput {
  return {
    building_id: r.building_id,
    client_id: r.client_id,
    room_id: r.room_id ?? "",
    source: r.source,
    category: r.category,
    title: r.title,
    detail: r.detail ?? "",
    due_date: r.due_date ?? "",
    assignee_id: r.assignee_id ?? "",
  };
}

function Detail({ id }: { id: string }) {
  const { session, error, editor } = useRequestsSession();
  const [req, setReq] = useState<RequestRow | null>(null);
  const [form, setForm] = useState<RequestInput | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [charge, setCharge] = useState<RequestCharge | null>(null);
  const [amount, setAmount] = useState("");
  const [billable, setBillable] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const showAmount = session ? canSeeAmount(session.perms) : false;

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const r = await getRequest(session.client, session.tenantId, id);
      if (!r) {
        setReq(null);
        setMsg("案件が見つかりません（消されたか、見る権限がありません）");
        return;
      }
      const [bs, cs, as, ch, rs] = await Promise.all([
        listBuildings(session.client, session.tenantId),
        editor ? listClients(session.client, session.tenantId) : Promise.resolve([] as Client[]),
        editor ? listAssignees(session.client, session.tenantId) : Promise.resolve([] as Assignee[]),
        canSeeAmount(session.perms) ? getCharge(session.client, session.tenantId, id) : Promise.resolve(null),
        listRooms(session.client, r.building_id),
      ]);
      setReq(r);
      setForm(toInput(r));
      setBuildings(bs);
      setClients(cs);
      setAssignees(as);
      setCharge(ch);
      setAmount(ch ? String(ch.amount) : "");
      setBillable(ch ? ch.billable : true);
      setRooms(sortRooms(rs));
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [session, editor, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<string | void>) {
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      const m = await fn();
      if (m) setOk(m);
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const onStatus = (to: string) =>
    act(async () => {
      if (!session) return;
      const r = await setRequestStatus(session.client, id, to);
      if (!r.ok) {
        setMsg(statusMessage(r));
        return;
      }
      await load();
      return statusMessage(r);
    });

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    if (!session || !form) return;
    const errs = validateRequest(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    void act(async () => {
      await saveRequest(session.client, session.tenantId, id, form);
      await load();
      return "保存しました";
    });
  };

  const onSaveCharge = (e: FormEvent) => {
    e.preventDefault();
    if (!session) return;
    const errs = validateCharge({ amount });
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    void act(async () => {
      await saveCharge(session.client, session.tenantId, id, charge, { amount, billable });
      await load();
      return "金額を保存しました";
    });
  };

  const onDeleteCharge = () => {
    if (!session || !charge || !window.confirm("この案件の金額を消しますか？")) return;
    void act(async () => {
      await deleteCharge(session.client, charge.id);
      await load();
      return "金額を消しました";
    });
  };

  const today = todayJst();
  const isAssignee = !!session && !!req && req.assignee_id === session.membershipId;
  const canField = !!session && session.perms.includes("field.record");
  const next = req ? nextStatuses(req.status, { editor, assignee: isAssignee && canField }) : [];
  const set = (k: keyof RequestInput) => (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
  const buildingName = (bid: string) => buildings.find((b) => b.id === bid)?.name ?? "";
  const st = req ? dueState(req, today) : "none";

  return (
    <RequestsShell title={req?.title ?? "案件"} active="list">
      <Loading error={error} session={session} />
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {req && form && session ? (
        <>
          <p>
            <span className={`r-badge status-${req.status}`}>{STATUS_LABEL[req.status]}</span>
            {st === "overdue" || st === "soon" ? <span className={`r-badge ${st}`}>{dueLabel(req, today)}</span> : null}
            <span className="r-badge">{CATEGORY_LABEL[req.category]}</span>
            <span className="r-badge">{SOURCE_LABEL[req.source]}</span>
          </p>
          <p className="m-sub">
            {buildingName(req.building_id)}&emsp;期限：{dueLabel(req, today)}
          </p>
          {next.length > 0 ? (
            <div className="r-status-row" role="group" aria-label="状況を変える">
              {next.map((s) => (
                <button key={s} className={`m-btn${s === "cancelled" ? " danger" : s === "done" ? "" : " sub"}`} disabled={busy} onClick={() => void onStatus(s)}>
                  {STATUS_LABEL[s]}にする
                </button>
              ))}
            </div>
          ) : null}

          {editor ? (
            <form className="m-form two" onSubmit={onSave} noValidate>
              <Field label="題名" error={errors.title} wide>
                <input value={form.title} onChange={set("title")} autoComplete="off" maxLength={100} />
              </Field>
              <Field label="内容" error={errors.detail} wide>
                <textarea value={form.detail} onChange={set("detail")} />
              </Field>
              <Field label="期限" error={errors.due_date}>
                <input type="date" value={form.due_date} onChange={set("due_date")} />
              </Field>
              <Field label="担当">
                <select value={form.assignee_id} onChange={set("assignee_id")}>
                  <option value="">決めない</option>
                  {assignees.map((a) => (
                    <option key={a.membership_id} value={a.membership_id}>
                      {a.display_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="分類" error={errors.category}>
                <select value={form.category} onChange={set("category")}>
                  {CATEGORY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="部屋">
                <select value={form.room_id} onChange={set("room_id")}>
                  <option value="">なし</option>
                  {selectableCandidates(rooms)
                    .concat(rooms.filter((r) => !r.active && r.id === req.room_id))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.room_no}
                        {r.active ? "" : "（使わない）"}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="建物" error={errors.building_id}>
                <select value={form.building_id} onChange={set("building_id")}>
                  {buildings.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="依頼元（取引先）" error={errors.client_id}>
                <select value={form.client_id} onChange={set("client_id")}>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="m-row wide">
                <button className="m-btn" type="submit" disabled={busy}>
                  保存する
                </button>
              </div>
            </form>
          ) : (
            <div>
              <p style={{ whiteSpace: "pre-wrap" }}>{req.detail ?? "（内容なし）"}</p>
            </div>
          )}

          {showAmount ? (
            <div className="m-section">
              <h2>金額</h2>
              <form className="m-form two" onSubmit={onSaveCharge} noValidate>
                <Field label="金額（円）" error={errors.amount}>
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" aria-label="金額（円）" />
                </Field>
                <Field label="請求するか">
                  <select value={billable ? "1" : "0"} onChange={(e) => setBillable(e.target.value === "1")}>
                    <option value="1">請求する</option>
                    <option value="0">請求しない</option>
                  </select>
                </Field>
                <div className="m-row wide">
                  <button className="m-btn" type="submit" disabled={busy || !editor}>
                    金額を保存する
                  </button>
                  {charge ? (
                    <button className="m-btn danger" type="button" disabled={busy || !editor} onClick={onDeleteCharge}>
                      金額を消す
                    </button>
                  ) : null}
                </div>
              </form>
              <p className="m-sub">請求書に載った金額は、直せず、消せません（その場合は、保存しようとしても断られます）。</p>
            </div>
          ) : null}
        </>
      ) : null}
    </RequestsShell>
  );
}

function Inner() {
  const id = useSearchParams().get("id");
  if (!id) return <RequestsShell title="案件" active="list"><p>案件が選ばれていません。</p></RequestsShell>;
  return <Detail key={id} id={id} />;
}

export default function RequestDetailPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Inner />
    </Suspense>
  );
}
