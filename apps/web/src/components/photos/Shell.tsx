"use client";

// 写真の画面に共通の枠（見出し・行き来）と、送れていない写真の表示（機能 008。R-008-37）
import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@/components/masters/Shell";
import { describeError } from "@/lib/errors";
import type { PhotoQueue, QueuedPhoto } from "@/lib/photos/queue";
import "@/components/masters/masters.css";
import "./photos.css";

export { Field, Notice } from "@/components/masters/Shell";

export function PhotosShell({ title, active, children }: { title: string; active: "list" | "new" | "other"; children: ReactNode }) {
  return (
    <section>
      <nav className="m-nav" aria-label="写真">
        <Link href="/photos/" aria-current={active === "list" ? "page" : undefined}>
          写真の一覧
        </Link>
        <Link href="/photos/new/" aria-current={active === "new" ? "page" : undefined}>
          撮る
        </Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </section>
  );
}

/** 端末にたまっていて、まだ送れていない写真の件数。断られたものは、理由を出し、あきらめて消せる */
export function PendingPhotos({ pending, queue, onSync }: { pending: QueuedPhoto[]; queue: PhotoQueue | null; onSync?: () => void }) {
  if (pending.length === 0) return null;
  const stuck = pending.filter((p) => p.attempts > 0);
  return (
    <div className="p-pending" role="status" data-testid="pending-photos">
      <strong>送れていない写真：{pending.length} 件</strong>
      <span className="m-sub">電波が戻ると、自動で送ります。送れるまで、この端末から消えません。</span>
      {onSync ? (
        <button type="button" className="m-btn sub" onClick={onSync}>
          今すぐ送る
        </button>
      ) : null}
      {stuck.map((p) => (
        <p key={p.id} className="m-sub" data-testid="stuck-photo">
          サーバーに断られました（{describeError({ code: p.lastCode, message: p.lastError })}）
          {queue ? (
            <button
              type="button"
              className="m-btn danger"
              onClick={() => {
                if (window.confirm("この写真を端末から消しますか？ サーバーには届いていないので、元に戻せません")) void queue.remove(p.id);
              }}
            >
              あきらめて消す
            </button>
          ) : null}
        </p>
      ))}
    </div>
  );
}

export function Msg({ error, ok }: { error: string | null; ok: string | null }) {
  return (
    <>
      <Notice text={error} />
      <Notice text={ok} kind="ok" />
    </>
  );
}
