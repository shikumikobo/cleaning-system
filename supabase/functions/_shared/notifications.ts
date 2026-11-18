// お知らせを送る処理の判断（機能 015）。外への口（DB・Web Push・メール）はすべて引数で受ける。
// Deno にも Node にも依存しない（単体のテストは Vitest で、偽の口を渡して確かめる）。
// 設計は specs/015-notifications/design.md の3章。
//
// 守ること
// - 会社ごとに分けて回し、会社ごと・1回ごとに処理の記録（job_runs）を残す（R-015-18）
// - 書く行の tenant_id は、元の行（outbox の行）から取る。呼び出し側から会社を渡さない
// - 1つの会社・1通の失敗が、ほかを止めない（R-015-20・22）
// - 鍵や環境変数の値を、記録・エラー・戻り値に出さない（R-015-24）

export type Channel = "push" | "email";

export interface OutboxRow {
  id: string;
  tenant_id: string;
  membership_id: string;
  /** 有効な所属でなければ null */
  user_id: string | null;
  kind: string;
  channel: Channel;
  title: string;
  body: string | null;
  link: string | null;
}

export interface Subscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** DB への口（service_role。supabase/migrations の notification_* 関数と、端末の登録の読み出し） */
export interface NotificationStore {
  tenantsPending(): Promise<string[]>;
  allTenants(): Promise<string[]>;
  startRun(tenant: string, kind: RunKind): Promise<string | null>;
  finishRun(tenant: string, run: string, status: "success" | "failure", counts: Record<string, number>, error: string | null): Promise<void>;
  outbox(tenant: string, limit: number): Promise<OutboxRow[]>;
  subscriptions(tenant: string, membership: string): Promise<Subscription[]>;
  mark(tenant: string, id: string, status: "sent" | "failed", error: string | null): Promise<void>;
  dropSubscription(tenant: string, id: string): Promise<void>;
  purge(tenant: string): Promise<number>;
  /** ログインの ID からメールアドレス（Auth の管理 API） */
  emailOf(userId: string): Promise<string | null>;
}

export type RunKind = "send_notifications" | "purge_notifications";

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };
export interface PushSender {
  send(sub: Subscription, payload: string): Promise<PushResult>;
}

export type MailResult = { ok: true } | { ok: false; error: string };
export interface MailSender {
  send(msg: { to: string; subject: string; text: string }): Promise<MailResult>;
}

export interface Deps {
  store: NotificationStore;
  push: PushSender;
  mail: MailSender;
  /** メールの本文に入れるアプリの URL（例 https://app.example.test）。なければリンクを入れない */
  appBaseUrl?: string;
  /** 1回の呼び出しで、会社ごとに送る行の上限。既定 100 */
  batchLimit?: number;
}

export interface RunSummary {
  tenants: number;
  skipped: number;
  failedTenants: number;
  sent: number;
  failed: number;
  subscriptionsRemoved: number;
  deleted: number;
}

const DEFAULT_BATCH = 100;

/** 鍵や長い文字列を伏せ、200 字までにする。記録・エラーには必ずこれを通す（R-015-24） */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "error";
  return raw.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "***").slice(0, 200);
}

function emptySummary(): RunSummary {
  return { tenants: 0, skipped: 0, failedTenants: 0, sent: 0, failed: 0, subscriptionsRemoved: 0, deleted: 0 };
}

// --- 送る（R-015-18〜24）------------------------------------------------------

export async function runSend(deps: Deps): Promise<RunSummary> {
  const summary = emptySummary();
  const tenants = await deps.store.tenantsPending();
  for (const tenant of tenants) {
    summary.tenants++;
    await sendForTenant(deps, tenant, summary);
  }
  return summary;
}

async function sendForTenant(deps: Deps, tenant: string, summary: RunSummary): Promise<void> {
  const { store } = deps;
  let run: string | null = null;
  const counts = { sent: 0, failed: 0, subscriptionsRemoved: 0 };
  try {
    run = await store.startRun(tenant, "send_notifications");
    if (!run) {
      summary.skipped++; // すでに同じ会社の送りが動いている（R-015-23）
      return;
    }
    const rows = await store.outbox(tenant, deps.batchLimit ?? DEFAULT_BATCH);
    for (const row of rows) {
      // 書く先の会社は、必ず行の会社。取り違えた行は触らない
      if (row.tenant_id !== tenant) continue;
      const result = await deliver(deps, row);
      counts.subscriptionsRemoved += result.removed;
      try {
        if (result.ok) {
          await store.mark(row.tenant_id, row.id, "sent", null);
          counts.sent++;
        } else {
          await store.mark(row.tenant_id, row.id, "failed", result.error);
          counts.failed++;
        }
      } catch (e) {
        // 印を付けられなかった行は、「送る前」のまま残る（次の回でもう一度試す）
        throw new Error("mark_failed: " + sanitizeError(e));
      }
    }
    await store.finishRun(tenant, run, "success", counts, null);
  } catch (e) {
    summary.failedTenants++;
    if (run) {
      try {
        await store.finishRun(tenant, run, "failure", counts, sanitizeError(e));
      } catch {
        // 記録そのものが書けないときは、次の会社へ進む（30 分で古い記録は閉じられる）
      }
    }
  } finally {
    summary.sent += counts.sent;
    summary.failed += counts.failed;
    summary.subscriptionsRemoved += counts.subscriptionsRemoved;
  }
}

interface Delivery {
  ok: boolean;
  error: string;
  removed: number;
}

async function deliver(deps: Deps, row: OutboxRow): Promise<Delivery> {
  if (!row.user_id) return { ok: false, error: "membership_inactive", removed: 0 };
  try {
    return row.channel === "push" ? await deliverPush(deps, row) : await deliverMail(deps, row);
  } catch (e) {
    return { ok: false, error: sanitizeError(e), removed: 0 };
  }
}

async function deliverPush(deps: Deps, row: OutboxRow): Promise<Delivery> {
  const subs = await deps.store.subscriptions(row.tenant_id, row.membership_id);
  if (subs.length === 0) return { ok: false, error: "no_subscription", removed: 0 };
  const payload = JSON.stringify({ id: row.id, title: row.title, body: row.body ?? "", link: row.link });
  let okCount = 0;
  let removed = 0;
  let firstError = "";
  for (const sub of subs) {
    let r: PushResult;
    try {
      r = await deps.push.send(sub, payload);
    } catch (e) {
      r = { ok: false, gone: false, error: sanitizeError(e) };
    }
    if (r.ok) {
      okCount++;
      continue;
    }
    if (r.gone) {
      await deps.store.dropSubscription(row.tenant_id, sub.id); // 届かない端末の登録を消す（R-015-21）
      removed++;
      if (!firstError) firstError = "subscription_gone";
    } else if (!firstError) {
      firstError = sanitizeError(r.error);
    }
  }
  return okCount > 0 ? { ok: true, error: "", removed } : { ok: false, error: firstError || "push_failed", removed };
}

async function deliverMail(deps: Deps, row: OutboxRow): Promise<Delivery> {
  const to = await deps.store.emailOf(row.user_id as string);
  if (!to) return { ok: false, error: "no_email", removed: 0 };
  const link = row.link && deps.appBaseUrl ? `\n\n${deps.appBaseUrl.replace(/\/+$/, "")}${row.link}` : "";
  const r = await deps.mail.send({ to, subject: row.title, text: `${row.body ?? ""}${link}`.trim() });
  return r.ok ? { ok: true, error: "", removed: 0 } : { ok: false, error: sanitizeError(r.error), removed: 0 };
}

// --- 掃除（R-015-25）---------------------------------------------------------

export async function runPurge(deps: Pick<Deps, "store">): Promise<RunSummary> {
  const summary = emptySummary();
  const { store } = deps;
  for (const tenant of await store.allTenants()) {
    summary.tenants++;
    let run: string | null = null;
    try {
      run = await store.startRun(tenant, "purge_notifications");
      if (!run) {
        summary.skipped++;
        continue;
      }
      const deleted = await store.purge(tenant);
      summary.deleted += deleted;
      await store.finishRun(tenant, run, "success", { deleted }, null);
    } catch (e) {
      summary.failedTenants++;
      if (run) {
        try {
          await store.finishRun(tenant, run, "failure", {}, sanitizeError(e));
        } catch {
          // 次の会社へ進む
        }
      }
    }
  }
  return summary;
}

// --- 送り手の選び方（差し替えの口。R-015-24）------------------------------------

export type Env = Record<string, string | undefined>;

/** 使えない送り手。送るたびに理由を返す（理由は固定の文字。鍵や設定の値は入れない） */
export function unavailablePush(reason: string): PushSender {
  return { send: async () => ({ ok: false, gone: false, error: reason }) };
}

export function unavailableMail(reason: string): MailSender {
  return { send: async () => ({ ok: false, error: reason }) };
}

/** MAIL_PROVIDER の名前から、メールの送り手を選ぶ。registry に足すだけで差し替えられる。なければ送らず失敗にする */
export function createMailSender(env: Env, registry: Record<string, (env: Env) => MailSender>): MailSender {
  const name = (env.MAIL_PROVIDER ?? "").trim();
  if (!name) return unavailableMail("mail_sender_not_configured");
  const make = registry[name];
  if (!make) return unavailableMail("mail_provider_unknown");
  return make(env);
}

/** web-push のライブラリのうち、使う部分だけ */
export interface WebPushLike {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    opts?: { TTL?: number },
  ): Promise<unknown>;
}

/** VAPID の鍵（環境変数）で Web Push の送り手を作る。鍵がなければ使えない送り手 */
export function createPushSender(env: Env, webpush: WebPushLike): PushSender {
  const pub = env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) return unavailablePush("vapid_not_configured");
  try {
    webpush.setVapidDetails(subject, pub, priv);
  } catch {
    return unavailablePush("vapid_invalid");
  }
  return {
    async send(sub, payload) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 });
        return { ok: true };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // 404・410 は、端末が登録を消した（もう届かない）
        return { ok: false, gone: status === 404 || status === 410, error: status ? `push_http_${status}` : sanitizeError(e) };
      }
    },
  };
}
