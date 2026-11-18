// 送り直し：電波が戻ったら、ためたものを作った順に送る。
// つながらないときは、そこで止めて残す。サーバーに断られたときは、端末のエラーを記録する（R-001-33）。
import type { Outbox, OutboxItem } from "./outbox";

export type SendResult =
  | { ok: true; duplicate?: boolean }
  | { ok: false; kind: "network" | "auth" | "server"; message: string; code?: string };

export interface Sender {
  send(item: OutboxItem): Promise<SendResult>;
}

export interface FlushContext {
  deviceId: string;
  appVersion: string;
}

export interface FlushResult {
  sent: number;
  duplicates: number;
  failed: number;
  remaining: number;
  /** つながらなくて止めた */
  offline: boolean;
}

const running = new WeakMap<Outbox, Promise<FlushResult>>();

/** 同時に2回呼んでも、1つだけ動く（同じ記録を二度送らない） */
export function flush(box: Outbox, sender: Sender, ctx?: FlushContext): Promise<FlushResult> {
  const current = running.get(box);
  if (current) return current;
  const p = doFlush(box, sender, ctx).finally(() => running.delete(box));
  running.set(box, p);
  return p;
}

function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || /fetch|network|offline/i.test(String((e as Error)?.message ?? e));
}

async function doFlush(box: Outbox, sender: Sender, ctx?: FlushContext): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, duplicates: 0, failed: 0, remaining: 0, offline: false };
  const items = await box.list();
  for (const item of items) {
    let r: SendResult;
    try {
      r = await sender.send(item);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      r = { ok: false, kind: isNetworkError(e) ? "network" : "server", message };
    }

    if (r.ok) {
      await box.remove(item.id);
      result.sent++;
      if (r.duplicate) result.duplicates++;
      continue;
    }

    if (r.kind === "network" || r.kind === "auth") {
      // 電波がない・ログインが切れている：エラーにはしない。残して、あとで送る
      await box.update(item.id, { lastError: r.message, lastCode: r.code });
      result.offline = true;
      break;
    }

    // サーバーに断られた：残す（消さない）。回数と中身を残し、端末のエラーとして記録する
    result.failed++;
    const attempts = item.attempts + 1;
    const patch: Partial<OutboxItem> = { attempts, lastError: r.message, lastCode: r.code };
    const canLog =
      ctx && item.target !== "client_error_logs" && item.membershipId && item.loggedError !== r.message;
    if (canLog) {
      await box.enqueue({
        kind: "insert",
        target: "client_error_logs",
        tenantId: item.tenantId,
        membershipId: item.membershipId,
        payload: {
          membership_id: item.membershipId,
          device_id: ctx.deviceId,
          app_version: ctx.appVersion,
          kind: "sync_failed",
          message: r.message,
          context: { item_id: item.id, target: item.target, kind: item.kind, code: r.code ?? null, attempts },
          at: new Date().toISOString(),
        },
      });
      patch.loggedError = r.message;
    }
    await box.update(item.id, patch);
  }
  result.remaining = await box.pendingCount();
  return result;
}

export interface AutoSyncOptions {
  /** online・visibilitychange を受ける相手（既定は window） */
  target?: EventTarget;
  /** 一定の間隔でも試す（ミリ秒。0 なら試さない） */
  intervalMs?: number;
  /** 始めてすぐに1回送る */
  immediate?: boolean;
  ctx?: FlushContext;
}

/** 電波が戻ったとき（online）・画面が戻ったとき・一定の間隔で、自動で送る。止める関数を返す */
export function startAutoSync(box: Outbox, sender: Sender, opts: AutoSyncOptions = {}): () => void {
  const target: EventTarget | undefined = opts.target ?? (typeof window !== "undefined" ? window : undefined);
  const run = () => void flush(box, sender, opts.ctx);
  target?.addEventListener("online", run);
  target?.addEventListener("visibilitychange", run);
  const timer = opts.intervalMs && opts.intervalMs > 0 ? setInterval(run, opts.intervalMs) : undefined;
  if (opts.immediate) run();
  return () => {
    target?.removeEventListener("online", run);
    target?.removeEventListener("visibilitychange", run);
    if (timer) clearInterval(timer);
  };
}
