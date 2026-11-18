"use client";

// 写真の画面の共通の準備：ログイン中の所属・送り箱（案件の気づき）・写真の入れ物・自動で送る・送れていない件数
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { useOutbox } from "@/components/SyncProvider";
import { sessionMessage, useSession, type Session } from "@/components/useSession";
import { createSupabaseSender, flush, getDeviceId, type Outbox, type SupabaseLike } from "../offline";
import { createPhotoSender } from "./repo";
import { flushPhotos, openPhotoQueue, type PhotoQueue, type QueuedPhoto } from "./queue";

export interface PhotoEnv {
  client: SupabaseClient;
  session: Session;
  box: Outbox;
  queue: PhotoQueue;
  /** ためたものを送る（案件の気づき → 写真の順。電波がなければ何もしない） */
  sync: () => Promise<void>;
}

export function usePhotoEnv(onSynced?: () => void, beforePhotos?: (client: SupabaseClient) => Promise<void>): { env: PhotoEnv | null; error: string | null; pending: QueuedPhoto[] } {
  const box = useOutbox();
  const state = useSession({ redirect: true });
  const [env, setEnv] = useState<PhotoEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<QueuedPhoto[]>([]);
  const synced = useRef(onSynced);
  synced.current = onSynced;
  const before = useRef(beforePhotos);
  before.current = beforePhotos;

  useEffect(() => {
    if (!box) return;
    if (state.status === "loading") return;
    if (state.status === "failed") {
      setError(sessionMessage[state.reason]);
      return;
    }
    const { client } = state.session;
    setError(null);
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let onOnline: (() => void) | undefined;
    let unsub: (() => void) | undefined;
    void (async () => {
      try {
        const queue = await openPhotoQueue();
        const deviceId = await getDeviceId();
        const refresh = async () => {
          if (!cancelled) setPending(await queue.list());
        };
        const sync = async () => {
          // 案件の気づきを先に送る（気づきの写真の行が、その案件を指すため）
          await flush(box, createSupabaseSender(client as unknown as SupabaseLike), { deviceId, appVersion: "0.0.0" });
          await before.current?.(client); // 報告書（009）の項目の行を、写真より先に送る
          await flushPhotos(queue, createPhotoSender(client));
          await refresh();
          synced.current?.();
        };
        if (cancelled) return;
        unsub = queue.subscribe(() => void refresh());
        setEnv({ client, session: state.session, box, queue, sync });
        await refresh();
        void sync();
        onOnline = () => void sync();
        window.addEventListener("online", onOnline);
        timer = setInterval(() => void sync(), 30_000);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (onOnline) window.removeEventListener("online", onOnline);
      unsub?.();
    };
  }, [box, state]);

  return { env, error, pending };
}
