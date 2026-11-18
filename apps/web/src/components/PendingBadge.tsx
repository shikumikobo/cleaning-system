"use client";

// 送れていない記録の件数（R-001-32）。0 件のときは何も出さない。
import { useEffect, useState } from "react";
import { useOutbox } from "./SyncProvider";

export function PendingBadge() {
  const box = useOutbox();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!box) return;
    let alive = true;
    const refresh = () => void box.pendingCount().then((c) => alive && setCount(c));
    refresh();
    const off = box.subscribe(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [box]);

  if (count === 0) return null;
  return (
    <span className="pending-badge" role="status">
      送れていない記録：{count} 件
    </span>
  );
}
