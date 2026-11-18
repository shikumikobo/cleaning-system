// 通知の許可と端末の登録（機能 015）。ブラウザの口は引数で受ける（テストでは偽物を渡す）。

export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}

export interface PushRegistrationLike {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
  };
}

export interface PushEnv {
  /** 対応していない端末では undefined */
  notification?: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> };
  serviceWorker?: { ready: Promise<PushRegistrationLike> };
  /** window.PushManager があるか */
  pushSupported: boolean;
}

export type EnableResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: "unsupported" | "no_key" | "denied" | "dismissed" | "failed" };

/** 理由を画面に出す文（R-015-26） */
export const enableFailureMessage: Record<Extract<EnableResult, { ok: false }>["reason"], string> = {
  unsupported: "この端末のブラウザは、通知に対応していません。ホーム画面に追加してから、もう一度お試しください。",
  no_key: "通知の設定が済んでいません。管理者にお問い合わせください。",
  denied: "通知がブロックされています。端末またはブラウザの設定で、このアプリの通知を許可してください。",
  dismissed: "通知の許可が選ばれませんでした。もう一度、許可してください。",
  failed: "通知の登録に失敗しました。時間をおいて、もう一度お試しください。",
};

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export interface RegisterPayload {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
}

/**
 * 通知の許可を求め、許可されたら端末（Web Push の購読）を作って登録する。
 * 許可されない・対応していないときは登録せず、理由を返す（R-015-26）。
 */
export async function enablePush(args: {
  env: PushEnv;
  vapidPublicKey: string | undefined;
  register(payload: RegisterPayload): Promise<void>;
  label?: string | null;
}): Promise<EnableResult> {
  const { env } = args;
  if (!env.notification || !env.serviceWorker || !env.pushSupported) return { ok: false, reason: "unsupported" };
  if (!args.vapidPublicKey) return { ok: false, reason: "no_key" };

  let permission = env.notification.permission;
  if (permission === "denied") return { ok: false, reason: "denied" };
  if (permission === "default") {
    try {
      permission = await env.notification.requestPermission();
    } catch {
      return { ok: false, reason: "failed" };
    }
  }
  if (permission === "denied") return { ok: false, reason: "denied" };
  if (permission !== "granted") return { ok: false, reason: "dismissed" };

  try {
    const reg = await env.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(args.vapidPublicKey) }));
    const json = sub.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!sub.endpoint || !p256dh || !auth) return { ok: false, reason: "failed" };
    await args.register({ endpoint: sub.endpoint, p256dh, auth, label: args.label ?? null });
    return { ok: true, endpoint: sub.endpoint };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** この端末の購読を解いて、登録を外す（R-015-7）。購読がなければ、登録だけ外す */
export async function disablePush(args: {
  env: PushEnv;
  remove(endpoint: string): Promise<void>;
}): Promise<{ ok: boolean }> {
  try {
    const reg = args.env.serviceWorker ? await args.env.serviceWorker.ready : null;
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return { ok: true };
    const endpoint = sub.endpoint;
    await args.remove(endpoint);
    await sub.unsubscribe();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** 今の端末の様子（画面の出し分け用）。許可されていて、購読があるか */
export async function currentPushState(env: PushEnv): Promise<"unsupported" | "denied" | "off" | "on"> {
  if (!env.notification || !env.serviceWorker || !env.pushSupported) return "unsupported";
  if (env.notification.permission === "denied") return "denied";
  if (env.notification.permission !== "granted") return "off";
  try {
    const reg = await env.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

/** ブラウザの本物の口を集める（画面から呼ぶ。サーバー側の書き出しでは undefined になる） */
export function browserPushEnv(): PushEnv {
  if (typeof window === "undefined") return { pushSupported: false };
  return {
    notification: "Notification" in window ? (Notification as unknown as PushEnv["notification"]) : undefined,
    serviceWorker: "serviceWorker" in navigator ? (navigator.serviceWorker as unknown as PushEnv["serviceWorker"]) : undefined,
    pushSupported: "PushManager" in window,
  };
}
