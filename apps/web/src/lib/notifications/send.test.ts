// 送る処理の判断（R-015-18〜25）。DB・Web Push・メールはすべて偽物に差し替える
import { describe, expect, it } from "vitest";
import {
  createMailSender,
  createPushSender,
  runPurge,
  runSend,
  sanitizeError,
  unavailablePush,
  type Deps,
  type MailSender,
  type NotificationStore,
  type OutboxRow,
  type PushResult,
  type PushSender,
  type RunKind,
  type Subscription,
} from "../../../../../supabase/functions/_shared/notifications";

interface Call {
  fn: string;
  args: unknown[];
}

function row(over: Partial<OutboxRow> & { id: string }): OutboxRow {
  return {
    tenant_id: "tA",
    membership_id: "mA",
    user_id: "uA",
    kind: "work_tomorrow",
    channel: "push",
    title: "明日の作業",
    body: "10:00 に A ビル",
    link: "/works/1",
    ...over,
  };
}

function makeStore(opts: {
  outbox?: Record<string, OutboxRow[]>;
  subs?: Record<string, Subscription[]>;
  busy?: string[];
  outboxError?: Record<string, Error>;
  emails?: Record<string, string | null>;
  allTenants?: string[];
  purge?: Record<string, number | Error>;
  finishError?: boolean;
}) {
  const calls: Call[] = [];
  const log = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  let runSeq = 0;
  const store: NotificationStore = {
    async tenantsPending() {
      return Object.keys(opts.outbox ?? {});
    },
    async allTenants() {
      return opts.allTenants ?? [];
    },
    async startRun(tenant, kind: RunKind) {
      log("startRun", tenant, kind);
      if (opts.busy?.includes(tenant)) return null;
      return `run-${tenant}-${++runSeq}`;
    },
    async finishRun(tenant, run, status, counts, error) {
      log("finishRun", tenant, run, status, counts, error);
      if (opts.finishError) throw new Error("finish failed");
    },
    async outbox(tenant, limit) {
      log("outbox", tenant, limit);
      const err = opts.outboxError?.[tenant];
      if (err) throw err;
      return opts.outbox?.[tenant] ?? [];
    },
    async subscriptions(tenant, membership) {
      log("subscriptions", tenant, membership);
      return opts.subs?.[`${tenant}/${membership}`] ?? [];
    },
    async mark(tenant, id, status, error) {
      log("mark", tenant, id, status, error);
    },
    async dropSubscription(tenant, id) {
      log("drop", tenant, id);
    },
    async purge(tenant) {
      log("purge", tenant);
      const v = opts.purge?.[tenant] ?? 0;
      if (v instanceof Error) throw v;
      return v;
    },
    async emailOf(userId) {
      return opts.emails && userId in opts.emails ? opts.emails[userId] : `${userId}@example.test`;
    },
  };
  return { store, calls, of: (fn: string) => calls.filter((c) => c.fn === fn) };
}

function fakePush(results: (sub: Subscription) => PushResult | Error): PushSender & { sent: { sub: Subscription; payload: string }[] } {
  const sent: { sub: Subscription; payload: string }[] = [];
  return {
    sent,
    async send(sub, payload) {
      sent.push({ sub, payload });
      const r = results(sub);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function fakeMail(result: { ok: true } | { ok: false; error: string } | Error = { ok: true }): MailSender & { sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const sub = (id: string, endpoint = `https://push.example.test/${id}`): Subscription => ({ id, endpoint, p256dh: "k", auth: "a" });
const ok: PushResult = { ok: true };

function deps(store: NotificationStore, push: PushSender, mail: MailSender, extra: Partial<Deps> = {}): Deps {
  return { store, push, mail, ...extra };
}

describe("送る処理：会社ごとに分けて回す", () => {
  it("R-015-18 会社ごとに記録を始め、その会社の行だけを取り、会社ごとに記録を閉じる", async () => {
    const s = makeStore({
      outbox: { tA: [row({ id: "n1" })], tB: [row({ id: "n2", tenant_id: "tB", membership_id: "mB", user_id: "uB" })] },
      subs: { "tA/mA": [sub("s1")], "tB/mB": [sub("s2")] },
    });
    const r = await runSend(deps(s.store, fakePush(() => ok), fakeMail()));
    expect(s.of("startRun").map((c) => c.args)).toEqual([["tA", "send_notifications"], ["tB", "send_notifications"]]);
    expect(s.of("outbox").map((c) => c.args[0])).toEqual(["tA", "tB"]);
    const finishes = s.of("finishRun");
    expect(finishes).toHaveLength(2);
    expect(finishes[0].args.slice(0, 3)).toEqual(["tA", "run-tA-1", "success"]);
    expect(finishes[0].args[3]).toEqual({ sent: 1, failed: 0, subscriptionsRemoved: 0 });
    expect(finishes[1].args[0]).toBe("tB");
    expect(r).toMatchObject({ tenants: 2, sent: 2, failed: 0, failedTenants: 0 });
  });

  it("R-015-18 書く行の会社は、行の会社（tenant_id）。別の会社の行は触らない", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1", tenant_id: "tB" }), row({ id: "n2" })] }, subs: { "tA/mA": [sub("s1")], "tB/mA": [sub("s0")] } });
    await runSend(deps(s.store, fakePush(() => ok), fakeMail()));
    expect(s.of("mark").map((c) => c.args)).toEqual([["tA", "n2", "sent", null]]);
  });

  it("R-015-18 1回に取る行の上限が、会社ごとに渡される（既定 100。指定できる）", async () => {
    const s = makeStore({ outbox: { tA: [] } });
    await runSend(deps(s.store, fakePush(() => ok), fakeMail()));
    await runSend(deps(s.store, fakePush(() => ok), fakeMail(), { batchLimit: 5 }));
    expect(s.of("outbox").map((c) => c.args[1])).toEqual([100, 5]);
  });

  it("R-015-18 送る前の行がなければ、何も送らず、記録も作らない", async () => {
    const s = makeStore({ outbox: {} });
    const r = await runSend(deps(s.store, fakePush(() => ok), fakeMail()));
    expect(s.calls).toHaveLength(0);
    expect(r.tenants).toBe(0);
  });
});

describe("送る処理：通知とメール", () => {
  it("R-015-19 送れたら送ったにする。通知は、題名・本文・リンクを送り手に渡す", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1" })] }, subs: { "tA/mA": [sub("s1")] } });
    const push = fakePush(() => ok);
    await runSend(deps(s.store, push, fakeMail()));
    expect(s.of("mark")[0].args).toEqual(["tA", "n1", "sent", null]);
    expect(JSON.parse(push.sent[0].payload)).toEqual({ id: "n1", title: "明日の作業", body: "10:00 に A ビル", link: "/works/1" });
    expect(push.sent[0].sub.endpoint).toBe("https://push.example.test/s1");
  });

  it("R-015-19 端末が2つあれば両方に送り、1つでも届けば送ったにする", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1" })] }, subs: { "tA/mA": [sub("s1"), sub("s2")] } });
    const push = fakePush((x) => (x.id === "s1" ? { ok: false, gone: false, error: "push_http_500" } : ok));
    await runSend(deps(s.store, push, fakeMail()));
    expect(push.sent).toHaveLength(2);
    expect(s.of("mark")[0].args[2]).toBe("sent");
  });

  it("R-015-19 メールは、本人のアドレスに、題名・本文・リンクの先（アプリの URL つき）で送る", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1", channel: "email" })] }, emails: { uA: "a@example.test" } });
    const mail = fakeMail();
    await runSend(deps(s.store, fakePush(() => ok), mail, { appBaseUrl: "https://app.example.test/" }));
    expect(mail.sent).toEqual([{ to: "a@example.test", subject: "明日の作業", text: "10:00 に A ビル\n\nhttps://app.example.test/works/1" }]);
    expect(s.of("mark")[0].args[2]).toBe("sent");
  });

  it("R-015-19 アプリの URL がなければ、メールにリンクを入れない", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1", channel: "email" })] } });
    const mail = fakeMail();
    await runSend(deps(s.store, fakePush(() => ok), mail));
    expect(mail.sent[0].text).toBe("10:00 に A ビル");
  });

  it("R-015-20 送れなかったら失敗にして理由を入れ、ほかの行の送りを続ける", async () => {
    const s = makeStore({
      outbox: { tA: [row({ id: "n1" }), row({ id: "n2", channel: "email" }), row({ id: "n3" })] },
      subs: { "tA/mA": [sub("s1")] },
    });
    let calls = 0;
    const push = fakePush(() => (++calls === 1 ? { ok: false, gone: false, error: "push_http_500" } : ok));
    const mail = fakeMail({ ok: false, error: "smtp_down" });
    const r = await runSend(deps(s.store, push, mail));
    expect(s.of("mark").map((c) => c.args)).toEqual([
      ["tA", "n1", "failed", "push_http_500"],
      ["tA", "n2", "failed", "smtp_down"],
      ["tA", "n3", "sent", null],
    ]);
    expect(r).toMatchObject({ sent: 1, failed: 2, failedTenants: 0 });
    expect(s.of("finishRun")[0].args[2]).toBe("success"); // 行の失敗では、処理の記録は失敗にしない
  });

  it("R-015-20 送り手が例外を投げても、その行だけ失敗にして続ける", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1", channel: "email" }), row({ id: "n2" })] }, subs: { "tA/mA": [sub("s1")] } });
    const mail = fakeMail(new Error("boom"));
    await runSend(deps(s.store, fakePush(() => ok), mail));
    expect(s.of("mark").map((c) => c.args)).toEqual([["tA", "n1", "failed", "boom"], ["tA", "n2", "sent", null]]);
  });

  it("R-015-20 端末がない・メールがない・所属が止められているときは、理由つきで失敗にする", async () => {
    const s = makeStore({
      outbox: { tA: [row({ id: "n1" }), row({ id: "n2", channel: "email" }), row({ id: "n3", user_id: null })] },
      emails: { uA: null },
    });
    await runSend(deps(s.store, fakePush(() => ok), fakeMail()));
    expect(s.of("mark").map((c) => [c.args[1], c.args[2], c.args[3]])).toEqual([
      ["n1", "failed", "no_subscription"],
      ["n2", "failed", "no_email"],
      ["n3", "failed", "membership_inactive"],
    ]);
  });
});

describe("送る処理：届かない端末", () => {
  it("R-015-21 端末が消えた（gone）と分かったら、その端末の登録を消す。ほかの端末で届けば送ったにする", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1" })] }, subs: { "tA/mA": [sub("s1"), sub("s2")] } });
    const push = fakePush((x) => (x.id === "s1" ? { ok: false, gone: true, error: "push_http_410" } : ok));
    const r = await runSend(deps(s.store, push, fakeMail()));
    expect(s.of("drop").map((c) => c.args)).toEqual([["tA", "s1"]]);
    expect(s.of("mark")[0].args[2]).toBe("sent");
    expect(r.subscriptionsRemoved).toBe(1);
    expect(s.of("finishRun")[0].args[3]).toEqual({ sent: 1, failed: 0, subscriptionsRemoved: 1 });
  });

  it("R-015-21 全部の端末が消えていたら、失敗（subscription_gone）にする。一時的な失敗では登録を消さない", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1" }), row({ id: "n2" })] }, subs: { "tA/mA": [sub("s1")] } });
    let n = 0;
    const push = fakePush(() => (++n === 1 ? { ok: false, gone: true, error: "push_http_410" } : { ok: false, gone: false, error: "push_http_503" }));
    await runSend(deps(s.store, push, fakeMail()));
    expect(s.of("mark").map((c) => [c.args[1], c.args[2], c.args[3]])).toEqual([
      ["n1", "failed", "subscription_gone"],
      ["n2", "failed", "push_http_503"],
    ]);
    expect(s.of("drop")).toHaveLength(1);
  });

  it("R-015-21 web-push の 404・410 は端末が消えた印、ほかは一時的な失敗", async () => {
    const mk = (status?: number) => {
      const err = Object.assign(new Error("x"), status ? { statusCode: status } : {});
      return createPushSender(
        { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:ops@example.test" },
        { setVapidDetails() {}, sendNotification: async () => { throw err; } },
      );
    };
    expect(await mk(410).send(sub("s"), "{}")).toEqual({ ok: false, gone: true, error: "push_http_410" });
    expect(await mk(404).send(sub("s"), "{}")).toMatchObject({ gone: true });
    expect(await mk(500).send(sub("s"), "{}")).toMatchObject({ gone: false, error: "push_http_500" });
  });
});

describe("送る処理：会社の失敗と二重の実行", () => {
  it("R-015-22 1つの会社の送りが失敗しても、ほかの会社を送り、失敗した会社の記録に理由を残す", async () => {
    const s = makeStore({
      outbox: { tA: [row({ id: "n1" })], tB: [row({ id: "n2", tenant_id: "tB", membership_id: "mB", user_id: "uB" })] },
      subs: { "tB/mB": [sub("s2")] },
      outboxError: { tA: new Error("db_down") },
    });
    const r = await runSend(deps(s.store, fakePush(() => ok), fakeMail()));
    const fa = s.of("finishRun").find((c) => c.args[0] === "tA");
    expect(fa?.args[2]).toBe("failure");
    expect(fa?.args[4]).toBe("db_down");
    expect(s.of("mark").map((c) => c.args)).toEqual([["tB", "n2", "sent", null]]);
    expect(r).toMatchObject({ tenants: 2, failedTenants: 1, sent: 1 });
  });

  it("R-015-22 記録を閉じるのも失敗しても、次の会社へ進む", async () => {
    const s = makeStore({
      outbox: { tA: [row({ id: "n1" })], tB: [row({ id: "n2", tenant_id: "tB", membership_id: "mB", user_id: "uB" })] },
      subs: { "tA/mA": [sub("s1")], "tB/mB": [sub("s2")] },
      outboxError: { tA: new Error("db_down") },
      finishError: true,
    });
    const r = await runSend(deps(s.store, fakePush(() => ok), fakeMail()));
    expect(s.of("mark").map((c) => c.args[1])).toEqual(["n2"]);
    expect(r.failedTenants).toBe(2); // A は送りの失敗、B は記録を閉じる失敗（送りは済んでいる）
  });

  it("R-015-22 印を付けられなかったときは、その会社の記録を失敗にし、次の会社へ進む", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1" })], tB: [] }, subs: { "tA/mA": [sub("s1")] } });
    s.store.mark = async () => {
      throw new Error("mark down");
    };
    const r = await runSend(deps(s.store, fakePush(() => ok), fakeMail()));
    expect(s.of("finishRun")[0].args[2]).toBe("failure");
    expect(String(s.of("finishRun")[0].args[4])).toContain("mark_failed");
    expect(r.failedTenants).toBe(1);
  });

  it("R-015-23 すでに同じ会社の送りが動いている（記録を始められない）ときは、その会社を送らない", async () => {
    const s = makeStore({
      outbox: { tA: [row({ id: "n1" })], tB: [row({ id: "n2", tenant_id: "tB", membership_id: "mB", user_id: "uB" })] },
      subs: { "tB/mB": [sub("s2")] },
      busy: ["tA"],
    });
    const push = fakePush(() => ok);
    const r = await runSend(deps(s.store, push, fakeMail()));
    expect(s.of("outbox").map((c) => c.args[0])).toEqual(["tB"]);
    expect(push.sent).toHaveLength(1);
    expect(s.of("finishRun").map((c) => c.args[0])).toEqual(["tB"]);
    expect(r).toMatchObject({ skipped: 1, sent: 1 });
  });
});

describe("送り手の差し替えと鍵", () => {
  it("R-015-24 VAPID の鍵がなければ、通知は失敗（vapid_not_configured）にして、鍵の値を出さない", async () => {
    const webpush = { setVapidDetails() { throw new Error("must not be called"); }, sendNotification: async () => ({}) };
    const push = createPushSender({ VAPID_PUBLIC_KEY: "pub-only" }, webpush);
    const s = makeStore({ outbox: { tA: [row({ id: "n1" })] }, subs: { "tA/mA": [sub("s1")] } });
    await runSend(deps(s.store, push, fakeMail()));
    expect(s.of("mark")[0].args).toEqual(["tA", "n1", "failed", "vapid_not_configured"]);
  });

  it("R-015-24 鍵が3つそろっていれば、その鍵で送り手を作る。鍵が不正なら vapid_invalid", async () => {
    const calls: unknown[][] = [];
    const env = { VAPID_PUBLIC_KEY: "PUB", VAPID_PRIVATE_KEY: "PRIV", VAPID_SUBJECT: "mailto:ops@example.test" };
    const sender = createPushSender(env, { setVapidDetails: (...a) => void calls.push(a), sendNotification: async () => ({}) });
    expect(calls).toEqual([["mailto:ops@example.test", "PUB", "PRIV"]]);
    expect(await sender.send(sub("s"), "{}")).toEqual({ ok: true });
    const bad = createPushSender(env, { setVapidDetails() { throw new Error("bad key PRIV"); }, sendNotification: async () => ({}) });
    expect(await bad.send(sub("s"), "{}")).toEqual({ ok: false, gone: false, error: "vapid_invalid" });
  });

  it("R-015-24 メールの送り手は MAIL_PROVIDER で選ぶ。なければ失敗にし、知らない名前も失敗にする", async () => {
    const msg = { to: "a@example.test", subject: "s", text: "t" };
    expect(await createMailSender({}, {}).send(msg)).toEqual({ ok: false, error: "mail_sender_not_configured" });
    expect(await createMailSender({ MAIL_PROVIDER: "nope" }, {}).send(msg)).toEqual({ ok: false, error: "mail_provider_unknown" });
    const used: unknown[] = [];
    const sender = createMailSender({ MAIL_PROVIDER: "fake", MAIL_API_KEY: "k" }, { fake: (env) => ({ send: async (m) => (used.push([env.MAIL_API_KEY, m.to]), { ok: true }) }) });
    expect(await sender.send(msg)).toEqual({ ok: true });
    expect(used).toEqual([["k", "a@example.test"]]);
  });

  it("R-015-24 メールの送り手がないとき、お知らせは失敗（mail_sender_not_configured）として残る", async () => {
    const s = makeStore({ outbox: { tA: [row({ id: "n1", channel: "email" })] } });
    await runSend(deps(s.store, unavailablePush("x"), createMailSender({}, {})));
    expect(s.of("mark")[0].args).toEqual(["tA", "n1", "failed", "mail_sender_not_configured"]);
  });

  it("R-015-24 エラーに含まれる長い鍵のような文字列は、記録に出さない", async () => {
    const secret = "sk_live_" + "A1b2C3d4".repeat(6);
    expect(sanitizeError(new Error(`auth failed with ${secret} for user`))).toBe("auth failed with *** for user");
    const s = makeStore({ outbox: { tA: [row({ id: "n1", channel: "email" }), row({ id: "n2" })] }, subs: { "tA/mA": [sub("s1")] } });
    const push = fakePush(() => new Error(`token=${secret}`));
    const mail = fakeMail(new Error(`key ${secret}`));
    await runSend(deps(s.store, push, mail));
    for (const c of s.of("mark")) expect(String(c.args[3])).not.toContain(secret);
    expect(s.of("mark").map((c) => c.args[2])).toEqual(["failed", "failed"]);
    s.store.outbox = async () => {
      throw new Error(`db ${secret}`);
    };
    await runSend(deps(s.store, push, mail));
    const fin = s.of("finishRun").at(-1);
    expect(String(fin?.args[4])).not.toContain(secret);
    expect(sanitizeError("a".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe("掃除", () => {
  it("R-015-25 会社ごとに記録を始めて掃除し、消した数を記録に残す。失敗した会社があっても次へ進む", async () => {
    const s = makeStore({ allTenants: ["tA", "tB", "tC"], purge: { tA: 3, tB: new Error("db_down"), tC: 0 } });
    const r = await runPurge({ store: s.store });
    expect(s.of("startRun").map((c) => c.args)).toEqual([["tA", "purge_notifications"], ["tB", "purge_notifications"], ["tC", "purge_notifications"]]);
    expect(s.of("purge").map((c) => c.args[0])).toEqual(["tA", "tB", "tC"]);
    const fin = s.of("finishRun");
    expect(fin[0].args.slice(2, 4)).toEqual(["success", { deleted: 3 }]);
    expect(fin[1].args.slice(2)).toEqual(["failure", {}, "db_down"]);
    expect(fin[2].args.slice(2, 4)).toEqual(["success", { deleted: 0 }]);
    expect(r).toMatchObject({ tenants: 3, deleted: 3, failedTenants: 1 });
  });

  it("R-015-25 すでに掃除が動いている会社は、掃除しない", async () => {
    const s = makeStore({ allTenants: ["tA"], busy: ["tA"] });
    const r = await runPurge({ store: s.store });
    expect(s.of("purge")).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });
});
