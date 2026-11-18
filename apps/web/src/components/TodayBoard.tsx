"use client";

// ホームの「今日の作業」：その日の作業の一覧と、期限の迫った案件の数。見るだけ（リンクは付けない）。
import { useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";

interface WorkLine {
  id: string;
  title: string;
  start_time: string | null;
  end_time: string | null;
  status: string;
  buildings: { name: string } | null;
}

const STATUS: Record<string, string> = {
  scheduled: "予定",
  in_progress: "作業中",
  done: "完了",
  skipped: "行かなかった",
  cancelled: "取消",
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const hm = (t: string | null) => (t ? t.slice(0, 5) : "");

export function TodayBoard() {
  const { client, current } = useAuth();
  const [works, setWorks] = useState<WorkLine[] | null>(null);
  const [overdue, setOverdue] = useState<number | null>(null);

  useEffect(() => {
    if (!client || !current) return;
    let alive = true;
    const day = today();
    void (async () => {
      try {
        const w = await client
          .from("works")
          .select("id,title,start_time,end_time,status,buildings(name)")
          .eq("tenant_id", current.tenantId)
          .eq("scheduled_date", day)
          .is("deleted_at", null)
          .order("start_time");
        const r = await client
          .from("requests")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", current.tenantId)
          .in("status", ["new", "in_progress"])
          .lt("due_date", day)
          .is("deleted_at", null);
        if (!alive) return;
        setWorks(w.error ? [] : ((w.data ?? []) as unknown as WorkLine[]));
        setOverdue(r.error ? null : (r.count ?? 0));
      } catch {
        if (alive) setWorks([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, current]);

  if (works === null) return null;
  const d = new Date();
  const label = `${d.getMonth() + 1}月${d.getDate()}日（${"日月火水木金土"[d.getDay()]}）`;
  return (
    <section className="today" aria-label="今日の作業">
      <div className="today-head">
        <h2 className="today-title">今日の作業</h2>
        <span className="today-date">{label}</span>
        {overdue ? <span className="r-badge overdue">期限切れの案件 {overdue} 件</span> : null}
      </div>
      {works.length === 0 ? (
        <p className="hint">今日の作業の予定はありません。</p>
      ) : (
        <ol className="today-list">
          {works.map((w) => (
            <li key={w.id} className={`today-row ${w.status}`}>
              <span className="today-time num">
                {hm(w.start_time)}
                {w.end_time ? `–${hm(w.end_time)}` : ""}
              </span>
              <span className="today-name">{w.buildings?.name ?? w.title}</span>
              <span className={`s-status ${w.status}`}>{STATUS[w.status] ?? w.status}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
