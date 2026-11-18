"use client";

// 送り箱を1つ持ち、サービスワーカーを登録し、電波が戻ったら自動で送る。
// 送る先（Supabase のクライアント）は、ログインの機能（001 の波 1）ができたら sender を渡す。
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getDeviceId, openOutbox, startAutoSync, type Outbox, type Sender } from "@/lib/offline";

const OutboxContext = createContext<Outbox | null>(null);

export function useOutbox(): Outbox | null {
  return useContext(OutboxContext);
}

export function SyncProvider({ children, sender }: { children: ReactNode; sender?: Sender }) {
  const [box, setBox] = useState<Outbox | null>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    let stop: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const b = await openOutbox();
      if (cancelled) return;
      setBox(b);
      if (sender) {
        const deviceId = await getDeviceId();
        stop = startAutoSync(b, sender, { intervalMs: 30_000, immediate: true, ctx: { deviceId, appVersion: "0.0.0" } });
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [sender]);

  return <OutboxContext.Provider value={box}>{children}</OutboxContext.Provider>;
}
