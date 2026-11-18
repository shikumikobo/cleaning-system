"use client";

// 作業を足す（R-012-32）：案件か契約の中身のどちらか1つを選び、日付・時刻・担当を入れて作る。
// 選んでいない・日付がない・終了が開始より前なら、RPC を呼ばずに理由を出す。作れたら、その作業の画面へ移る。
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Field, Loading, Notice, ScheduleShell, useScheduleCtx } from "@/components/schedule/Shell";
import { describeError } from "@/lib/errors";
import { listBuildings } from "@/lib/masters/repo";
import { todayJst } from "@/lib/quotes/format";
import { validateNewWork, workActionMessage } from "@/lib/schedule/format";
import { createWork, listOpenRequests, listServiceChoices, listStaff, type RequestChoice, type ServiceChoice } from "@/lib/schedule/repo";
import type { StaffRow } from "@/lib/schedule/types";

export default function NewWorkPage() {
  const { ctx, error } = useScheduleCtx();
  const router = useRouter();
  const [source, setSource] = useState<"service" | "request">("service");
  const [services, setServices] = useState<ServiceChoice[]>([]);
  const [requests, setRequests] = useState<RequestChoice[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [buildings, setBuildings] = useState<Record<string, string>>({});
  const [serviceId, setServiceId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [date, setDate] = useState(todayJst());
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // この画面で作る作業の uuid（二度押しても1件）
  const workId = useRef<string>(typeof crypto !== "undefined" ? crypto.randomUUID() : "");

  useEffect(() => {
    if (ctx && !ctx.manage) router.replace("/schedule/mine/");
  }, [ctx, router]);

  useEffect(() => {
    if (!ctx || !ctx.manage) return;
    let cancelled = false;
    void Promise.all([listServiceChoices(ctx.sb, ctx.tenantId), listOpenRequests(ctx.sb, ctx.tenantId), listStaff(ctx.sb, ctx.tenantId), listBuildings(ctx.sb, ctx.tenantId)])
      .then(([sv, rq, st, bs]) => {
        if (cancelled) return;
        setServices(sv);
        setRequests(rq);
        setStaff(st);
        setBuildings(Object.fromEntries(bs.map((b) => [b.id, b.name])));
      })
      .catch((e) => !cancelled && setMsg(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const toggle = (m: string) => setMembers((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setMsg(null);
    const p = validateNewWork({ source, serviceId, requestId, date, start, end });
    setProblem(p ?? undefined);
    if (p) return;
    setBusy(true);
    try {
      const r = await createWork(ctx.sb, {
        id: workId.current,
        date,
        start,
        end,
        serviceId: source === "service" ? serviceId : "",
        requestId: source === "request" ? requestId : "",
        title,
        members,
      });
      if (!r.ok) return setMsg(workActionMessage(r.reason));
      router.push(`/schedule/work/?id=${r.id ?? workId.current}`);
    } catch (err) {
      setMsg(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScheduleShell title="作業を足す" active="new" manage={ctx?.manage ?? false}>
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      <Notice text={msg} />
      {ctx?.manage ? (
        <form className="m-form" onSubmit={onSubmit} aria-label="作業を足す">
          <Field label="何を元にするか" error={problem}>
            <select aria-label="元" value={source} onChange={(e) => setSource(e.target.value as "service" | "request")}>
              <option value="service">契約の中身</option>
              <option value="request">案件</option>
            </select>
          </Field>
          {source === "service" ? (
            <Field label="契約の中身">
              <select aria-label="契約の中身" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                <option value="">選んでください</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {buildings[s.building_id] ?? ""} ／ {s.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="案件">
              <select aria-label="案件" value={requestId} onChange={(e) => setRequestId(e.target.value)}>
                <option value="">選んでください</option>
                {requests.map((r) => (
                  <option key={r.id} value={r.id}>
                    {buildings[r.building_id] ?? ""} ／ {r.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="日付">
            <input type="date" aria-label="日付" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="開始の時刻（空なら、契約の中身の時刻）">
            <input type="time" aria-label="開始の時刻" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="終了の時刻">
            <input type="time" aria-label="終了の時刻" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="名前（空なら、元の名前）">
            <input aria-label="名前" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="担当">
            {staff.map((s) => (
              <label key={s.membership_id} className="m-row">
                <input type="checkbox" checked={members.includes(s.membership_id)} onChange={() => toggle(s.membership_id)} aria-label={`担当：${s.display_name}`} />
                {s.display_name}
              </label>
            ))}
          </Field>
          <div>
            <button type="submit" className="m-btn" disabled={busy}>
              作業を足す
            </button>
          </div>
        </form>
      ) : null}
    </ScheduleShell>
  );
}
