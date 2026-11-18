// 電波のない間の送り直し（R-001-30〜33）
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openOutbox, type Outbox } from "./outbox";
import { getDeviceId } from "./device";
import { flush, startAutoSync, type SendResult, type Sender } from "./sync";
import { createSupabaseSender, type SupabaseLike } from "./supabaseSender";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let box: Outbox;
let dbName: string;
let n = 0;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  dbName = `outbox-test-${n++}`;
  box = await openOutbox(dbName);
});

function item(over: Partial<Parameters<Outbox["enqueue"]>[0]> = {}) {
  return { kind: "insert" as const, target: "photos", tenantId: "t-a", payload: { note: "x" }, ...over };
}

const okSender = (log: string[] = []): Sender => ({
  async send(it) {
    log.push(it.id);
    return { ok: true } satisfies SendResult;
  },
});

describe("端末の ID", () => {
  it("R-001-31 端末の ID は uuid で、何度呼んでも同じ", async () => {
    const a = await getDeviceId(dbName);
    const b = await getDeviceId(dbName);
    expect(a).toMatch(UUID);
    expect(b).toBe(a);
  });

  it("R-001-31 端末が違えば ID も違う（別の端末の保存先）", async () => {
    const a = await getDeviceId(dbName);
    globalThis.indexedDB = new IDBFactory();
    const b = await getDeviceId(dbName);
    expect(b).not.toBe(a);
  });
});

describe("端末にためる", () => {
  it("R-001-30 電波のない間に作った記録は、端末にためる（IndexedDB）", async () => {
    const saved = await box.enqueue(item());
    expect(saved.id).toMatch(UUID);
    expect(saved.clientCreatedAt).toBeTruthy();
    expect(await box.pendingCount()).toBe(1);
    // 画面を開き直しても（別の接続でも）残っている
    const again = await openOutbox(dbName);
    expect(await again.pendingCount()).toBe(1);
    expect((await again.list())[0].payload).toEqual({ note: "x" });
  });

  it("R-001-30 記録ごとに、端末で uuid を作る（指定すればそれを使う）", async () => {
    const a = await box.enqueue(item());
    const b = await box.enqueue(item());
    expect(a.id).not.toBe(b.id);
    const c = await box.enqueue(item({ id: "11111111-1111-4111-8111-111111111111" }));
    expect(c.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("R-001-30 RPC の呼び出しも、引数ごとにためる", async () => {
    const saved = await box.enqueue({ kind: "rpc", target: "start_work", tenantId: "t-a", payload: { p_id: "x" } });
    expect(saved.kind).toBe("rpc");
    expect((await box.list())[0].target).toBe("start_work");
  });

  it("R-001-31 同じ ID を二度ためても、端末には1件だけ", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await box.enqueue(item({ id, payload: { v: 1 } }));
    await box.enqueue(item({ id, payload: { v: 2 } }));
    expect(await box.pendingCount()).toBe(1);
    expect((await box.list())[0].payload).toEqual({ v: 1 }); // 先にためた中身を残す
  });
});

describe("電波が戻ったら送る", () => {
  it("R-001-30 送れたものは端末から消える", async () => {
    await box.enqueue(item());
    await box.enqueue(item());
    const log: string[] = [];
    const r = await flush(box, okSender(log));
    expect(r).toMatchObject({ sent: 2, failed: 0, remaining: 0 });
    expect(log).toHaveLength(2);
    expect(await box.pendingCount()).toBe(0);
  });

  it("R-001-30 ためた順（作った順）に送る", async () => {
    const a = await box.enqueue(item());
    const b = await box.enqueue(item());
    const c = await box.enqueue(item());
    const log: string[] = [];
    await flush(box, okSender(log));
    expect(log).toEqual([a.id, b.id, c.id]);
  });

  it("R-001-30 電波がないとき（つながらない）は、そこで止めて、残す", async () => {
    await box.enqueue(item());
    await box.enqueue(item());
    const send = vi.fn(async (): Promise<SendResult> => ({ ok: false, kind: "network", message: "offline" }));
    const r = await flush(box, { send });
    expect(send).toHaveBeenCalledTimes(1); // 1件目でつながらなければ、あとは試さない
    expect(r).toMatchObject({ sent: 0, remaining: 2, offline: true });
    expect(await box.pendingCount()).toBe(2);
  });

  it("R-001-30 電波が戻ったら、残っていたものを送る", async () => {
    await box.enqueue(item());
    await flush(box, { send: async () => ({ ok: false, kind: "network", message: "offline" }) });
    expect(await box.pendingCount()).toBe(1);
    const r = await flush(box, okSender());
    expect(r.sent).toBe(1);
    expect(await box.pendingCount()).toBe(0);
  });

  it("R-001-30 同時に2回 flush しても、1件を二度は送らない", async () => {
    await box.enqueue(item());
    const log: string[] = [];
    const slow: Sender = { send: async (it) => { await new Promise((r) => setTimeout(r, 20)); log.push(it.id); return { ok: true }; } };
    await Promise.all([flush(box, slow), flush(box, slow)]);
    expect(log).toHaveLength(1);
  });

  it("R-001-30 電波が戻った（online）ときに、自動で送る", async () => {
    await box.enqueue(item());
    const target = new EventTarget();
    const log: string[] = [];
    const stop = startAutoSync(box, okSender(log), { target, intervalMs: 0 });
    target.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(log).toHaveLength(1));
    stop();
    await box.enqueue(item());
    target.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toHaveLength(1); // 止めたあとは送らない
  });
});

describe("二度目は何もしない", () => {
  it("R-001-31 「もう届いている」（重複）の答えは、送れたものとして端末から消す", async () => {
    await box.enqueue(item());
    const r = await flush(box, { send: async () => ({ ok: true, duplicate: true }) });
    expect(r).toMatchObject({ sent: 1, duplicates: 1, remaining: 0 });
    expect(await box.pendingCount()).toBe(0);
  });

  it("R-001-31 insert は、端末の ID で upsert（重複は無視）する。二度送っても同じ呼び方", async () => {
    const calls: Array<{ table: string; row: unknown; opts: unknown }> = [];
    const client: SupabaseLike = {
      from: (table) => ({
        upsert: async (row, opts) => { calls.push({ table, row, opts }); return { error: null }; },
        insert: async () => ({ error: null }),
      }),
      rpc: async () => ({ data: null, error: null }),
    };
    const sender = createSupabaseSender(client);
    const saved = await box.enqueue(item({ target: "client_error_logs", payload: { message: "m" } }));
    await sender.send(saved);
    await sender.send(saved);
    expect(calls).toHaveLength(2);
    expect(calls[0].table).toBe("client_error_logs");
    expect(calls[0].row).toMatchObject({ id: saved.id, tenant_id: "t-a", message: "m" });
    expect(calls[1].row).toEqual(calls[0].row);
    expect(calls[0].opts).toMatchObject({ onConflict: "id", ignoreDuplicates: true });
  });

  it("R-001-31 RPC は、端末の uuid を引数（p_id）で渡す。二度呼んでも同じ引数", async () => {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const client: SupabaseLike = {
      from: () => ({ upsert: async () => ({ error: null }), insert: async () => ({ error: null }) }),
      rpc: async (fn, args) => { calls.push({ fn, args }); return { data: { ok: 1 }, error: null }; },
    };
    const sender = createSupabaseSender(client);
    const saved = await box.enqueue({ kind: "rpc", target: "start_work", tenantId: "t-a", payload: { p_work: "w1" } });
    await sender.send(saved);
    await sender.send(saved);
    expect(calls[0]).toEqual({ fn: "start_work", args: { p_work: "w1", p_id: saved.id } });
    expect(calls[1]).toEqual(calls[0]);
  });

  it("R-001-31 重複の印（23505）は、送れた扱いにする", async () => {
    const client: SupabaseLike = {
      from: () => ({ upsert: async () => ({ error: { code: "23505", message: "duplicate key" } }), insert: async () => ({ error: null }) }),
      rpc: async () => ({ data: null, error: null }),
    };
    const saved = await box.enqueue(item());
    expect(await createSupabaseSender(client).send(saved)).toMatchObject({ ok: true, duplicate: true });
  });
});

describe("送れていない件数", () => {
  it("R-001-32 送れていない記録がある間、件数を出す", async () => {
    const seen: number[] = [];
    const off = box.subscribe(() => { void box.pendingCount().then((c) => seen.push(c)); });
    await box.enqueue(item());
    await box.enqueue(item());
    await vi.waitFor(() => expect(seen.at(-1)).toBe(2));
    await flush(box, okSender());
    await vi.waitFor(() => expect(seen.at(-1)).toBe(0));
    off();
  });

  it("R-001-32 件数は、会社ごとにも数えられる", async () => {
    await box.enqueue(item({ tenantId: "t-a" }));
    await box.enqueue(item({ tenantId: "t-b" }));
    expect(await box.pendingCount()).toBe(2);
    expect(await box.pendingCount("t-a")).toBe(1);
  });

  it("R-001-32 送れるまで端末から消さない（エラーで返っても残る）", async () => {
    await box.enqueue(item());
    await flush(box, { send: async () => ({ ok: false, kind: "server", message: "boom", code: "XX000" }) });
    expect(await box.pendingCount()).toBe(1);
    const left = (await box.list())[0];
    expect(left.attempts).toBe(1);
    expect(left.lastError).toBe("boom");
  });

  it("R-001-32 送れる途中で例外が出ても、残す", async () => {
    await box.enqueue(item());
    await flush(box, { send: async () => { throw new Error("crash"); } });
    expect(await box.pendingCount()).toBe(1);
    expect((await box.list())[0].lastError).toContain("crash");
  });

  it("R-001-32 端末が落ちても（接続を開き直しても）残っている", async () => {
    await box.enqueue(item());
    await flush(box, { send: async () => ({ ok: false, kind: "network", message: "offline" }) });
    const reopened = await openOutbox(dbName);
    expect(await reopened.pendingCount()).toBe(1);
  });
});

describe("送れなかったときの記録", () => {
  it("R-001-33 サーバーに断られたとき、端末のエラー（端末・時刻・中身）を、同じ送り箱に入れる", async () => {
    const deviceId = await getDeviceId(dbName);
    const saved = await box.enqueue(item({ id: "33333333-3333-4333-8333-333333333333", membershipId: "m-1" }));
    await flush(box, { send: async (it) => it.target === "client_error_logs" ? { ok: false, kind: "network", message: "offline" } : { ok: false, kind: "server", message: "denied", code: "42501" } }, { deviceId, appVersion: "1.2.3" });
    const all = await box.list();
    const err = all.find((x) => x.target === "client_error_logs");
    expect(err).toBeTruthy();
    expect(err!.kind).toBe("insert");
    expect(err!.tenantId).toBe("t-a");
    expect(err!.payload).toMatchObject({
      membership_id: "m-1",
      device_id: deviceId,
      app_version: "1.2.3",
      kind: "sync_failed",
      message: "denied",
    });
    const ctx = (err!.payload as { context: Record<string, unknown> }).context;
    expect(ctx).toMatchObject({ item_id: saved.id, target: "photos", code: "42501", attempts: 1 });
    expect(typeof (err!.payload as { at: string }).at).toBe("string");
  });

  it("R-001-33 電波がないだけ（つながらない）のときは、エラーを記録しない", async () => {
    await box.enqueue(item({ membershipId: "m-1" }));
    await flush(box, { send: async () => ({ ok: false, kind: "network", message: "offline" }) }, { deviceId: "d", appVersion: "1" });
    expect((await box.list()).filter((x) => x.target === "client_error_logs")).toHaveLength(0);
  });

  it("R-001-33 同じエラーを、試すたびに何度も記録しない", async () => {
    await box.enqueue(item({ membershipId: "m-1" }));
    const sender: Sender = { send: async (it) => it.target === "client_error_logs" ? { ok: false, kind: "network", message: "offline" } : { ok: false, kind: "server", message: "denied", code: "42501" } };
    for (let i = 0; i < 3; i++) await flush(box, sender, { deviceId: "d", appVersion: "1" });
    expect((await box.list()).filter((x) => x.target === "client_error_logs")).toHaveLength(1);
  });

  it("R-001-33 エラーの記録そのものが断られても、さらにエラーを作らない（くり返さない）", async () => {
    await box.enqueue(item({ target: "client_error_logs", membershipId: "m-1", payload: { message: "m" } }));
    for (let i = 0; i < 2; i++) {
      await flush(box, { send: async () => ({ ok: false, kind: "server", message: "denied", code: "42501" }) }, { deviceId: "d", appVersion: "1" });
    }
    expect((await box.list())).toHaveLength(1);
  });

  it("R-001-33 エラーの記録が送れたら、端末から消える", async () => {
    await box.enqueue(item({ membershipId: "m-1" }));
    await flush(box, { send: async (it) => it.target === "client_error_logs" ? { ok: false, kind: "network", message: "offline" } : { ok: false, kind: "server", message: "denied" } }, { deviceId: "d", appVersion: "1" });
    expect(await box.pendingCount()).toBe(2);
    await flush(box, okSender(), { deviceId: "d", appVersion: "1" });
    // 元の記録（まだ断られる想定ではなく、ここでは送れた）とエラーの記録の両方が消える
    expect(await box.pendingCount()).toBe(0);
  });
});
