"use client";

// お知らせの一覧（R-015-16）。新しい順、未読の印、読んだら既読、すべて既読。
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { announceNotificationsChanged, type NotificationItem } from "@/lib/notifications/api";
import { sessionMessage } from "@/components/useSession";
import { useNotificationSession } from "@/lib/notifications/useNotificationSession";

const when = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function NotificationsPage() {
  const state = useNotificationSession({ redirect: true });
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (state.status !== "ready") return;
    try {
      setItems(await state.api.listNotifications(state.session.membershipId));
      setError(null);
    } catch {
      setError("お知らせを読み込めませんでした。");
    }
  }, [state]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (state.status === "loading") return <p>読み込み中…</p>;
  if (state.status === "failed") return <p role="alert">{sessionMessage[state.reason]}</p>;

  const unread = (items ?? []).filter((i) => !i.read_at).length;

  async function readOne(id: string) {
    if (state.status !== "ready") return;
    try {
      await state.api.markRead([id]);
      setItems((cur) => (cur ?? []).map((i) => (i.id === id && !i.read_at ? { ...i, read_at: new Date().toISOString() } : i)));
      announceNotificationsChanged();
    } catch {
      setError("既読にできませんでした。");
    }
  }

  // リンクの先へ移る前に、既読を送り終える（移ったあとだと、送りかけの通信が切れる）
  async function openLink(i: NotificationItem) {
    if (!i.read_at) await readOne(i.id);
    if (i.link) router.push(i.link);
  }

  async function readAll() {
    if (state.status !== "ready") return;
    try {
      await state.api.markAllRead(state.session.membershipId);
      await reload();
      announceNotificationsChanged();
    } catch {
      setError("既読にできませんでした。");
    }
  }

  return (
    <section>
      <h1>お知らせ</h1>
      <p>
        <a href="/settings/notifications/">受け取る種類の設定</a>
      </p>
      {error && <p role="alert">{error}</p>}
      {items === null ? (
        <p>読み込み中…</p>
      ) : items.length === 0 ? (
        <p>お知らせはまだありません。</p>
      ) : (
        <>
          <p>
            未読 {unread} 件 {unread > 0 && <button onClick={() => void readAll()}>すべて既読にする</button>}
          </p>
          <ul className="notification-list">
            {items.map((i) => (
              <li key={i.id} className={i.read_at ? "notification read" : "notification unread"}>
                <div>
                  {!i.read_at && <span aria-label="未読">● </span>}
                  <strong>{i.title}</strong> <small>{when.format(new Date(i.created_at))}</small>
                </div>
                {i.body && <div>{i.body}</div>}
                <div>
                  {i.link && (
                    <a
                      href={i.link}
                      onClick={(e) => {
                        e.preventDefault();
                        void openLink(i);
                      }}
                    >
                      開く
                    </a>
                  )}{" "}
                  {!i.read_at && <button onClick={() => void readOne(i.id)}>既読にする</button>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
