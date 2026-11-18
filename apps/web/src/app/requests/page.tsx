"use client";

// 案件の一覧：状況・期限・建物・担当で絞り込み、期限切れ・近いものを先に出す（R-003-23・27・29）
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Loading, Notice, RequestsShell, useRequestsSession } from "@/components/requests/Shell";
import { describeError } from "@/lib/errors";
import { listBuildings } from "@/lib/masters/repo";
import type { Building } from "@/lib/masters/types";
import { dueLabel, dueState, todayJst } from "@/lib/requests/due";
import { CATEGORY_LABEL, canSeeAmount, filterRequests, sortRequests, STATUS_LABEL, type RequestFilters } from "@/lib/requests/format";
import { listAssignees, listCharges, listRequests } from "@/lib/requests/repo";
import type { Assignee, RequestCharge, RequestRow } from "@/lib/requests/types";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

export default function RequestsPage() {
  const { session, error, editor } = useRequestsSession();
  const [items, setItems] = useState<RequestRow[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [charges, setCharges] = useState<RequestCharge[]>([]);
  const [filters, setFilters] = useState<RequestFilters>({ status: "", due: "", building_id: "", assignee_id: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const showAmount = session ? canSeeAmount(session.perms) : false;

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      try {
        const [rs, bs, as, cs] = await Promise.all([
          listRequests(session.client, session.tenantId),
          listBuildings(session.client, session.tenantId),
          editor ? listAssignees(session.client, session.tenantId) : Promise.resolve([] as Assignee[]),
          canSeeAmount(session.perms) ? listCharges(session.client, session.tenantId) : Promise.resolve([] as RequestCharge[]),
        ]);
        if (cancelled) return;
        setItems(rs);
        setBuildings(bs);
        setAssignees(as);
        setCharges(cs);
      } catch (e) {
        if (!cancelled) setMsg(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, editor]);

  const today = todayJst();
  const shown = useMemo(() => sortRequests(filterRequests(items, filters, today), today), [items, filters, today]);
  const open = useMemo(() => filterRequests(items, {}, today), [items, today]);
  const overdue = open.filter((r) => dueState(r, today) === "overdue").length;
  const soon = open.filter((r) => dueState(r, today) === "soon").length;
  const buildingName = (id: string) => buildings.find((b) => b.id === id)?.name ?? "";
  const assigneeName = (id: string | null) =>
    id === null ? "担当なし" : id === session?.membershipId ? "自分" : (assignees.find((a) => a.membership_id === id)?.display_name ?? "担当あり");
  const chargeOf = (id: string) => charges.find((c) => c.request_id === id);
  const set = (k: keyof RequestFilters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [k]: e.target.value }) as RequestFilters);

  return (
    <RequestsShell title="案件" active="list">
      <Loading error={error} session={session} />
      <Notice text={msg} />
      {session ? (
        <>
          {overdue + soon > 0 ? (
            <p className="r-warn" role="status">
              {overdue > 0 ? `期限切れが ${overdue} 件` : ""}
              {overdue > 0 && soon > 0 ? "、" : ""}
              {soon > 0 ? `期限が近いものが ${soon} 件` : ""}あります
            </p>
          ) : null}
          <div className="r-filters">
            <select aria-label="状況" value={filters.status ?? ""} onChange={set("status")}>
              <option value="">終わっていない（受付・対応中）</option>
              <option value="all">すべて</option>
              <option value="new">受付</option>
              <option value="in_progress">対応中</option>
              <option value="done">完了</option>
              <option value="cancelled">取消</option>
            </select>
            <select aria-label="期限" value={filters.due ?? ""} onChange={set("due")}>
              <option value="">期限：すべて</option>
              <option value="overdue">期限切れ</option>
              <option value="soon">期限が近い</option>
              <option value="week">今週（7日以内）</option>
              <option value="none">期限なし</option>
            </select>
            <select aria-label="建物" value={filters.building_id ?? ""} onChange={set("building_id")}>
              <option value="">建物：すべて</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            {editor ? (
              <select aria-label="担当" value={filters.assignee_id ?? ""} onChange={set("assignee_id")}>
                <option value="">担当：すべて</option>
                <option value="none">担当なし</option>
                {assignees.map((a) => (
                  <option key={a.membership_id} value={a.membership_id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="m-bar">
            <Link className="m-btn" href="/requests/new/" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              {editor ? "案件を登録" : "気づきから案件を作る"}
            </Link>
          </div>
          {shown.length === 0 ? <p>該当する案件はありません。</p> : null}
          {shown.map((r) => {
            const st = dueState(r, today);
            const c = chargeOf(r.id);
            return (
              <Link key={r.id} className="m-card" href={`/requests/detail/?id=${r.id}`}>
                <strong>{r.title}</strong>
                <span>
                  <span className={`r-badge status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                  {st === "overdue" || st === "soon" ? <span className={`r-badge ${st}`}>{dueLabel(r, today)}</span> : null}
                  <span className="r-badge">{CATEGORY_LABEL[r.category]}</span>
                </span>
                <span className="m-sub">{buildingName(r.building_id)}</span>
                <span className="m-sub">
                  {st === "overdue" || st === "soon" ? null : <>期限：{dueLabel(r, today)}&emsp;</>}担当：{assigneeName(r.assignee_id)}
                  {showAmount && c ? <span className="r-amount">&emsp;{yen(c.amount)}{c.billable ? "" : "（請求しない）"}</span> : null}
                </span>
              </Link>
            );
          })}
        </>
      ) : null}
    </RequestsShell>
  );
}
