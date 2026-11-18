"use client";

// 通知の設定（R-015-26・27）：この端末の通知の許可と登録、受け取る種類ごと・手段ごとの切り替え。
import { useCallback, useEffect, useState } from "react";
import type { Setting, SettingRow, Channel } from "@/lib/notifications/kinds";
import { buildSettingRows } from "@/lib/notifications/kinds";
import { browserPushEnv, currentPushState, disablePush, enableFailureMessage, enablePush } from "@/lib/notifications/push";
import { sessionMessage } from "@/components/useSession";
import { useNotificationSession } from "@/lib/notifications/useNotificationSession";

const pushText = {
  unsupported: "この端末のブラウザは、通知に対応していません（ホーム画面に追加すると使える端末があります）。",
  denied: "通知がブロックされています。端末またはブラウザの設定で許可してください。",
  off: "この端末の通知は、まだ入っていません。",
  on: "この端末の通知は入っています。",
} as const;

export default function NotificationSettingsPage() {
  const state = useNotificationSession({ redirect: true });
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const [device, setDevice] = useState<keyof typeof pushText | "checking">("checking");
  const [message, setMessage] = useState<string | null>(null);

  const refreshDevice = useCallback(async () => setDevice(await currentPushState(browserPushEnv())), []);

  useEffect(() => {
    void refreshDevice();
  }, [refreshDevice]);

  useEffect(() => {
    if (state.status !== "ready") return;
    let alive = true;
    const { api, session } = state;
    void Promise.all([api.listKinds(), api.listSettings(session.membershipId)])
      .then(([kinds, settings]) => alive && setRows(buildSettingRows(kinds, settings as Setting[], session.perms)))
      .catch(() => alive && setMessage("設定を読み込めませんでした。"));
    return () => {
      alive = false;
    };
  }, [state]);

  if (state.status === "loading") return <p>読み込み中…</p>;
  if (state.status === "failed") return <p role="alert">{sessionMessage[state.reason]}</p>;
  const { api, session } = state;

  async function turnOn() {
    setMessage(null);
    const r = await enablePush({
      env: browserPushEnv(),
      vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      label: typeof navigator === "undefined" ? null : navigator.userAgent.slice(0, 100),
      register: (p) => api.registerPush(session.tenantId, p),
    });
    if (!r.ok) setMessage(enableFailureMessage[r.reason]);
    await refreshDevice();
  }

  async function turnOff() {
    setMessage(null);
    const r = await disablePush({ env: browserPushEnv(), remove: (e) => api.removePush(e) });
    if (!r.ok) setMessage("通知を切れませんでした。もう一度お試しください。");
    await refreshDevice();
  }

  async function toggle(code: string, channel: Channel, enabled: boolean) {
    setMessage(null);
    const before = rows;
    setRows((cur) =>
      (cur ?? []).map((r) => (r.code === code ? { ...r, [channel]: enabled, [channel === "push" ? "pushIsDefault" : "emailIsDefault"]: false } : r)),
    );
    try {
      await api.saveSetting(session.tenantId, session.membershipId, code, channel, enabled);
    } catch {
      setRows(before);
      setMessage("保存できませんでした。もう一度お試しください。");
    }
  }

  return (
    <section>
      <h1>通知の設定</h1>
      <p>
        <a href="/notifications/">お知らせの一覧へ</a>
      </p>
      {message && <p role="alert">{message}</p>}

      <h2>この端末の通知</h2>
      <p>{device === "checking" ? "確認中…" : pushText[device]}</p>
      {device === "off" && <button onClick={() => void turnOn()}>通知を入れる</button>}
      {device === "on" && <button onClick={() => void turnOff()}>この端末の通知を切る</button>}

      <h2>受け取る種類</h2>
      {rows === null ? (
        <p>読み込み中…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>種類</th>
              <th>通知</th>
              <th>メール</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td>{r.name}</td>
                <td>
                  <input type="checkbox" aria-label={`${r.name}の通知`} checked={r.push} onChange={(e) => void toggle(r.code, "push", e.target.checked)} />
                </td>
                <td>
                  <input type="checkbox" aria-label={`${r.name}のメール`} checked={r.email} onChange={(e) => void toggle(r.code, "email", e.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
