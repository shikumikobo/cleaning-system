"use client";

// 小口の画面の共通の準備：ログイン中の所属・送り箱・画像の入れ物・自動で送る
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { useOutbox } from "@/components/SyncProvider";
import { sessionMessage, useSession } from "@/components/useSession";
import { createSupabaseSender, flush, getDeviceId, type Outbox, type SupabaseLike } from "../offline";
import { callReadReceipt, uploadReceiptImage, type CashSession } from "./api";
import { openReceiptQueue, uploadPendingReceipts, type ReceiptQueue } from "./queue";

export interface CashEnv {
  client: SupabaseClient;
  session: CashSession;
  box: Outbox;
  rq: ReceiptQueue;
  deviceId: string;
  /** ためたものを送る（電波がなければ何もしない） */
  sync: () => Promise<void>;
}

export function useCash(onSynced?: () => void): { env: CashEnv | null; error: string | null; loading: boolean } {
  const box = useOutbox();
  const state = useSession({ redirect: true });
  const [env, setEnv] = useState<CashEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const synced = useRef(onSynced);
  synced.current = onSynced;

  useEffect(() => {
    if (!box) return;
    if (state.status === "loading") return;
    if (state.status === "failed") {
      setError(sessionMessage[state.reason]);
      setLoading(false);
      return;
    }
    const { client, ...session } = state.session; // 今の会社は、ヘッダーで選んでいる会社（001 の AuthProvider）
    setError(null);
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let onOnline: (() => void) | undefined;
    void (async () => {
      try {
        const rq = await openReceiptQueue();
        const deviceId = await getDeviceId();
        const sync = async () => {
          await flush(box, createSupabaseSender(client as unknown as SupabaseLike), { deviceId, appVersion: "0.0.0" });
          await uploadPendingReceipts(rq, {
            upload: (path, bytes, mime) => uploadReceiptImage(client, path, bytes, mime),
            read: (id) => callReadReceipt(client, id),
          });
          synced.current?.();
        };
        if (cancelled) return;
        setEnv({ client, session, box, rq, deviceId, sync });
        void sync();
        onOnline = () => void sync();
        window.addEventListener("online", onOnline);
        timer = setInterval(() => void sync(), 30_000);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (onOnline) window.removeEventListener("online", onOnline);
    };
  }, [box, state]);

  return { env, error, loading };
}

/** 今日の日付（日本時間、YYYY-MM-DD） */
export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 撮った写真を、長辺 1600px 以下の JPEG に縮める（端末の中。送る量を減らす） */
export async function shrinkImage(file: File, maxSide = 1600): Promise<{ bytes: ArrayBuffer; mime: string }> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.8));
    if (blob) return { bytes: await blob.arrayBuffer(), mime: "image/jpeg" };
  } catch {
    // 縮められないときは、そのまま使う
  }
  return { bytes: await file.arrayBuffer(), mime: file.type === "image/png" || file.type === "image/webp" ? file.type : "image/jpeg" };
}
