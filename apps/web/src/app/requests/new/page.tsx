"use client";

// 案件の登録。管理者・社員（request.edit）は全項目の登録、スタッフ（field.record）は現場の気づきから短く作る。
// 気づきは、電波がなければ端末にため、戻ったら送る（R-003-14・15・29）。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Field, Loading, Notice, RequestsShell, useRequestsSession } from "@/components/requests/Shell";
import { useOutbox } from "@/components/SyncProvider";
import { describeError } from "@/lib/errors";
import { listBuildings, listClients, listRooms } from "@/lib/masters/repo";
import { selectableCandidates, sortRooms } from "@/lib/masters/format";
import type { Building, Client, Room } from "@/lib/masters/types";
import { createSupabaseSender, flush, getDeviceId, type SupabaseLike } from "@/lib/offline";
import { CATEGORY_OPTIONS, SOURCE_OPTIONS, canSeeAmount } from "@/lib/requests/format";
import { enqueueObservation } from "@/lib/requests/observation";
import { listAssignees, saveCharge, saveRequest, type RequestInput } from "@/lib/requests/repo";
import type { Assignee } from "@/lib/requests/types";
import { validateCharge, validateObservation, validateRequest, type Errors } from "@/lib/requests/validate";

const EMPTY: RequestInput & { amount: string; billable: boolean } = {
  building_id: "",
  client_id: "",
  room_id: "",
  source: "phone",
  category: "other",
  title: "",
  detail: "",
  due_date: "",
  assignee_id: "",
  amount: "",
  billable: true,
};

export default function NewRequestPage() {
  const { session, error, editor } = useRequestsSession();
  const box = useOutbox();
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const showAmount = session ? canSeeAmount(session.perms) : false;

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      try {
        const [bs, cs, as] = await Promise.all([
          listBuildings(session.client, session.tenantId),
          editor ? listClients(session.client, session.tenantId) : Promise.resolve([] as Client[]),
          editor ? listAssignees(session.client, session.tenantId) : Promise.resolve([] as Assignee[]),
        ]);
        if (cancelled) return;
        setBuildings(bs);
        setClients(cs);
        setAssignees(as);
      } catch (e) {
        if (!cancelled) setMsg(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, editor]);

  // 建物を選んだら、依頼元を建物の依頼元にし、その建物の部屋（使うもの）を出す
  useEffect(() => {
    if (!session || !form.building_id) {
      setRooms([]);
      return;
    }
    let cancelled = false;
    void listRooms(session.client, form.building_id)
      .then((rs) => !cancelled && setRooms(sortRooms(selectableCandidates(rs))))
      .catch(() => !cancelled && setRooms([]));
    return () => {
      cancelled = true;
    };
  }, [session, form.building_id]);

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const pickBuilding = (e: { target: { value: string } }) => {
    const b = buildings.find((x) => x.id === e.target.value);
    setForm((f) => ({ ...f, building_id: e.target.value, room_id: "", client_id: editor && b ? b.client_id : f.client_id }));
  };

  async function onSaveFull(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    setMsg(null);
    setOk(null);
    const errs: Errors = { ...validateRequest(form), ...(showAmount && form.amount.trim() ? validateCharge(form) : {}) };
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const saved = await saveRequest(session.client, session.tenantId, null, form);
      if (showAmount && form.amount.trim()) {
        try {
          await saveCharge(session.client, session.tenantId, saved.id, null, { amount: form.amount, billable: form.billable });
        } catch (err) {
          setMsg(`案件は登録しましたが、金額は保存できませんでした：${describeError(err)}`);
        }
      }
      router.replace(`/requests/detail/?id=${saved.id}`);
    } catch (err) {
      setMsg(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveObservation(e: FormEvent) {
    e.preventDefault();
    if (!session || !box) return;
    setMsg(null);
    setOk(null);
    const errs = validateObservation(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      // 先に端末にためる（電波がなくても失われない）。そのあと送ってみる
      await enqueueObservation(box, { tenantId: session.tenantId, membershipId: session.membershipId }, {
        building_id: form.building_id,
        title: form.title,
        detail: form.detail,
        room_id: form.room_id,
        category: form.category,
      });
      const r = await flush(box, createSupabaseSender(session.client as unknown as SupabaseLike), { deviceId: await getDeviceId(), appVersion: "0.0.0" });
      setOk(r.offline ? "電波がないので、端末にためました。電波が戻ると自動で送ります" : "案件を作りました");
      setForm({ ...EMPTY, building_id: form.building_id });
    } catch (err) {
      setMsg(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const buildingField = (
    <Field label="建物" error={errors.building_id}>
      <select value={form.building_id} onChange={pickBuilding}>
        <option value="">選んでください</option>
        {buildings.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <RequestsShell title={editor ? "案件の登録" : "気づきから案件を作る"} active="new">
      <Loading error={error} session={session} />
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      {session && editor ? (
        <form className="m-form two" onSubmit={onSaveFull} noValidate>
          {buildingField}
          <Field label="依頼元（取引先）" error={errors.client_id}>
            <select value={form.client_id} onChange={set("client_id")}>
              <option value="">選んでください</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
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
          <Field label="受けた方法">
            <select value={form.source} onChange={set("source")}>
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="部屋（なくてもよい）">
            <select value={form.room_id} onChange={set("room_id")} disabled={!form.building_id}>
              <option value="">なし</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.room_no}
                </option>
              ))}
            </select>
          </Field>
          {showAmount ? (
            <>
              <Field label="金額（円。あとからでもよい）" error={errors.amount}>
                <input value={form.amount} onChange={set("amount")} inputMode="numeric" />
              </Field>
              <Field label="請求するか">
                <select value={form.billable ? "1" : "0"} onChange={(e) => setForm((f) => ({ ...f, billable: e.target.value === "1" }))}>
                  <option value="1">請求する</option>
                  <option value="0">請求しない</option>
                </select>
              </Field>
            </>
          ) : null}
          <div className="m-row wide">
            <button className="m-btn" type="submit" disabled={busy}>
              登録する
            </button>
          </div>
        </form>
      ) : null}
      {session && !editor ? (
        <form className="m-form" onSubmit={onSaveObservation} noValidate>
          {buildingField}
          <Field label="気づいたこと（題名）" error={errors.title}>
            <input value={form.title} onChange={set("title")} autoComplete="off" maxLength={100} />
          </Field>
          <Field label="くわしく（なくてもよい）" error={errors.detail}>
            <textarea value={form.detail} onChange={set("detail")} />
          </Field>
          <Field label="部屋（なくてもよい）">
            <select value={form.room_id} onChange={set("room_id")} disabled={!form.building_id}>
              <option value="">なし</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.room_no}
                </option>
              ))}
            </select>
          </Field>
          <Field label="分類">
            <select value={form.category} onChange={set("category")}>
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="m-sub">写真は、<Link href="/photos/new/">写真を撮る画面</Link>から撮れます（気づきは、そこから案件にもできます）。</p>
          <div className="m-row">
            <button className="m-btn" type="submit" disabled={busy || !box}>
              案件にする
            </button>
          </div>
        </form>
      ) : null}
    </RequestsShell>
  );
}
