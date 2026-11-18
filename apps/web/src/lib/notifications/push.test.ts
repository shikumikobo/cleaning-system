// 通知の許可と端末の登録（R-015-5・7・26）。ブラウザは偽物に差し替える
import { describe, expect, it } from "vitest";
import { currentPushState, disablePush, enablePush, enableFailureMessage, urlBase64ToUint8Array, type PushEnv, type RegisterPayload } from "./push";

function makeEnv(over: {
  permission?: NotificationPermission;
  request?: NotificationPermission | Error;
  existing?: boolean;
  supported?: boolean;
  noSw?: boolean;
  noNotification?: boolean;
  keys?: { p256dh?: string; auth?: string };
}) {
  const log = { requested: 0, subscribed: [] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array }[], unsubscribed: 0 };
  const sub = {
    endpoint: "https://push.example.test/dev1",
    toJSON: () => ({ endpoint: "https://push.example.test/dev1", keys: over.keys ?? { p256dh: "P", auth: "A" } }),
    unsubscribe: async () => {
      log.unsubscribed++;
      return true;
    },
  };
  const env: PushEnv = {
    pushSupported: over.supported ?? true,
    notification: over.noNotification
      ? undefined
      : {
          permission: over.permission ?? "default",
          requestPermission: async () => {
            log.requested++;
            if (over.request instanceof Error) throw over.request;
            return over.request ?? "granted";
          },
        },
    serviceWorker: over.noSw
      ? undefined
      : {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: async () => (over.existing ? sub : null),
              subscribe: async (o) => {
                log.subscribed.push(o);
                return sub;
              },
            },
          }),
        },
  };
  return { env, log };
}

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

describe("通知の許可と端末の登録", () => {
  it("R-015-26 許可されたら、端末を登録する（送り先・鍵・端末の名前）", async () => {
    const { env, log } = makeEnv({ permission: "default", request: "granted" });
    const registered: RegisterPayload[] = [];
    const r = await enablePush({ env, vapidPublicKey: KEY, register: async (p) => void registered.push(p), label: "Pixel" });
    expect(r).toEqual({ ok: true, endpoint: "https://push.example.test/dev1" });
    expect(log.requested).toBe(1);
    expect(log.subscribed).toHaveLength(1);
    expect(log.subscribed[0].userVisibleOnly).toBe(true);
    expect(log.subscribed[0].applicationServerKey).toHaveLength(65); // 公開鍵は 65 バイト
    expect(registered).toEqual([{ endpoint: "https://push.example.test/dev1", p256dh: "P", auth: "A", label: "Pixel" }]);
  });

  it("R-015-26 すでに許可されていれば、許可を求め直さず、今の購読を使う", async () => {
    const { env, log } = makeEnv({ permission: "granted", existing: true });
    const registered: RegisterPayload[] = [];
    const r = await enablePush({ env, vapidPublicKey: KEY, register: async (p) => void registered.push(p) });
    expect(r.ok).toBe(true);
    expect(log.requested).toBe(0);
    expect(log.subscribed).toHaveLength(0);
    expect(registered).toHaveLength(1);
  });

  it("R-015-26 許可されなければ登録せず、理由を返す（拒否・保留・すでにブロック）", async () => {
    for (const [permission, request, reason] of [
      ["default", "denied", "denied"],
      ["default", "default", "dismissed"],
      ["denied", undefined, "denied"],
    ] as const) {
      const { env, log } = makeEnv({ permission, request });
      let registered = 0;
      const r = await enablePush({ env, vapidPublicKey: KEY, register: async () => void registered++ });
      expect(r).toEqual({ ok: false, reason });
      expect(registered).toBe(0);
      expect(log.subscribed).toHaveLength(0);
      if (permission === "denied") expect(log.requested).toBe(0); // すでにブロックなら、許可を求めない
      expect(enableFailureMessage[reason].length).toBeGreaterThan(10); // 画面に出す文がある
    }
  });

  it("R-015-26 対応していない端末・鍵がない・許可の画面が出せないときは、登録せず理由を返す", async () => {
    const reg = async () => {
      throw new Error("must not register");
    };
    expect(await enablePush({ env: makeEnv({ supported: false }).env, vapidPublicKey: KEY, register: reg })).toEqual({ ok: false, reason: "unsupported" });
    expect(await enablePush({ env: makeEnv({ noSw: true }).env, vapidPublicKey: KEY, register: reg })).toEqual({ ok: false, reason: "unsupported" });
    expect(await enablePush({ env: makeEnv({ noNotification: true }).env, vapidPublicKey: KEY, register: reg })).toEqual({ ok: false, reason: "unsupported" });
    expect(await enablePush({ env: makeEnv({}).env, vapidPublicKey: undefined, register: reg })).toEqual({ ok: false, reason: "no_key" });
    expect(await enablePush({ env: makeEnv({ request: new Error("x") }).env, vapidPublicKey: KEY, register: reg })).toEqual({ ok: false, reason: "failed" });
  });

  it("R-015-26 購読の鍵が取れない・登録が失敗したときは、失敗にする", async () => {
    expect(await enablePush({ env: makeEnv({ permission: "granted", keys: {} }).env, vapidPublicKey: KEY, register: async () => {} })).toEqual({ ok: false, reason: "failed" });
    const r = await enablePush({
      env: makeEnv({ permission: "granted" }).env,
      vapidPublicKey: KEY,
      register: async () => {
        throw new Error("rpc failed");
      },
    });
    expect(r).toEqual({ ok: false, reason: "failed" });
  });

  it("R-015-7 外すとき、端末の登録を外してから購読を解く。購読がなければ何もしない", async () => {
    const { env, log } = makeEnv({ existing: true });
    const removed: string[] = [];
    expect(await disablePush({ env, remove: async (e) => void removed.push(e) })).toEqual({ ok: true });
    expect(removed).toEqual(["https://push.example.test/dev1"]);
    expect(log.unsubscribed).toBe(1);
    const none = makeEnv({ existing: false });
    expect(await disablePush({ env: none.env, remove: async () => void removed.push("x") })).toEqual({ ok: true });
    expect(removed).toHaveLength(1);
    // 登録を外せなかったときは、購読を解かない（片方だけ残らないよう、失敗で返す）
    const fail = makeEnv({ existing: true });
    expect(await disablePush({ env: fail.env, remove: async () => { throw new Error("x"); } })).toEqual({ ok: false });
    expect(fail.log.unsubscribed).toBe(0);
  });

  it("R-015-26 今の端末の様子（対応なし・ブロック・オフ・オン）を出せる", async () => {
    expect(await currentPushState(makeEnv({ supported: false }).env)).toBe("unsupported");
    expect(await currentPushState(makeEnv({ permission: "denied" }).env)).toBe("denied");
    expect(await currentPushState(makeEnv({ permission: "default" }).env)).toBe("off");
    expect(await currentPushState(makeEnv({ permission: "granted", existing: false }).env)).toBe("off");
    expect(await currentPushState(makeEnv({ permission: "granted", existing: true }).env)).toBe("on");
  });

  it("R-015-26 VAPID の公開鍵（URL で使える base64）を、バイト列にできる", () => {
    const bytes = urlBase64ToUint8Array(KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4); // 圧縮していない公開鍵の印
    expect(urlBase64ToUint8Array("-_8")).toEqual(Uint8Array.from([251, 255]));
  });
});
