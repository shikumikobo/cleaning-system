// 電波のない間の出入り・レシートのため方（R-006-10・22）
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { flush, openOutbox, type Outbox, type Sender } from "../offline";
import { enqueueCashEntry, enqueueReceipt, openReceiptQueue, receiptPath, uploadPendingReceipts, type ReceiptQueue } from "./queue";

let box: Outbox;
let rq: ReceiptQueue;
let n = 0;
const ctx = { tenantId: "t-a", membershipId: "m-staff", accountId: "acc-1", deviceId: "dev-1" };
const sent: Array<{ target: string; id: string; payload: Record<string, unknown> }> = [];

const okSender: Sender = {
  async send(it) {
    sent.push({ target: it.target, id: it.id, payload: it.payload });
    return { ok: true };
  },
};
const offlineSender: Sender = {
  async send() {
    return { ok: false, kind: "network", message: "Failed to fetch" };
  },
};

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  sent.length = 0;
  box = await openOutbox(`cash-outbox-${n}`);
  rq = await openReceiptQueue(`cash-receipts-${n++}`);
});

describe("出入りを端末にためる", () => {
  it("R-006-10 電波がない間は端末にたまり、件数が出て、送れるまで消えない", async () => {
    await enqueueCashEntry(box, ctx, { date: "2026-11-10", amount: 1980, purpose: "洗剤", direction: "out" });
    expect(await box.pendingCount()).toBe(1);
    const r = await flush(box, offlineSender);
    expect(r.offline).toBe(true);
    expect(await box.pendingCount()).toBe(1); // 送れるまで消さない
  });

  it("R-006-10 電波が戻ったら送られ、端末からなくなる。行は下書きで、持ち手・小口・端末の ID が入る", async () => {
    const saved = await enqueueCashEntry(box, ctx, { date: "2026-11-10", amount: 1980, purpose: "洗剤", direction: "out" });
    await flush(box, okSender);
    expect(await box.pendingCount()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ target: "cash_entries", id: saved.id });
    expect(sent[0].payload).toMatchObject({
      account_id: "acc-1",
      holder_id: "m-staff",
      entry_date: "2026-11-10",
      direction: "out",
      amount: 1980,
      purpose: "洗剤",
      status: "draft",
      device_id: "dev-1",
    });
  });

  it("R-006-10 同じ ID で二度ためても1件", async () => {
    const a = await enqueueCashEntry(box, ctx, { id: "same-id", date: "2026-11-10", amount: 100, purpose: "x", direction: "out" });
    const b = await enqueueCashEntry(box, ctx, { id: "same-id", date: "2026-11-10", amount: 999, purpose: "y", direction: "out" });
    expect(b.id).toBe(a.id);
    expect(await box.pendingCount()).toBe(1);
  });

  it("R-006-10 レシートの行は、出入りの行より先に送る（出入りの外部キーが先に届かないように）", async () => {
    const rid = await enqueueReceipt(box, rq, ctx, new Uint8Array([1, 2, 3]).buffer, "image/jpeg");
    await enqueueCashEntry(box, ctx, { date: "2026-11-10", amount: 500, purpose: "電池", direction: "out", receiptId: rid });
    await flush(box, okSender);
    expect(sent.map((s) => s.target)).toEqual(["receipts", "cash_entries"]);
    expect(sent[1].payload).toMatchObject({ receipt_id: rid });
    expect(sent[0].payload).toMatchObject({ holder_id: "m-staff", status: "pending", storage_path: receiptPath("t-a", rid, "image/jpeg") });
  });
});

describe("レシートの画像を端末にためる", () => {
  it("R-006-22 画像の置き場所は <会社の ID>/receipts/<レシートの ID>.<拡張子>", () => {
    expect(receiptPath("t-a", "r-1", "image/jpeg")).toBe("t-a/receipts/r-1.jpg");
    expect(receiptPath("t-a", "r-1", "image/png")).toBe("t-a/receipts/r-1.png");
    expect(receiptPath("t-a", "r-1", "image/webp")).toBe("t-a/receipts/r-1.webp");
  });

  it("R-006-10 電波がない間は画像が端末に残り、電波が戻ったら上げて、読み取りを呼んで、端末から消す", async () => {
    const rid = await enqueueReceipt(box, rq, ctx, new Uint8Array([9, 9]).buffer, "image/jpeg");
    expect((await rq.list()).map((x) => x.id)).toEqual([rid]);

    const calls: string[] = [];
    const down = await uploadPendingReceipts(rq, {
      upload: async () => ({ ok: false, kind: "network" as const, message: "offline" }),
      read: async (id) => {
        calls.push("read:" + id);
      },
    });
    expect(down).toEqual({ uploaded: 0, remaining: 1, offline: true });
    expect(await rq.list()).toHaveLength(1); // 送れるまで消さない

    const up = await uploadPendingReceipts(rq, {
      upload: async (path, bytes) => {
        calls.push(`upload:${path}:${bytes.byteLength}`);
        return { ok: true as const };
      },
      read: async (id) => {
        calls.push("read:" + id);
      },
    });
    expect(up).toEqual({ uploaded: 1, remaining: 0, offline: false });
    expect(calls).toEqual([`upload:t-a/receipts/${rid}.jpg:2`, `read:${rid}`]);
    expect(await rq.list()).toHaveLength(0);
  });

  it("R-006-10 読み取りの呼び出しが失敗しても、上げた画像は端末から消す（読み取りは候補なので、あとで手で入れられる）", async () => {
    await enqueueReceipt(box, rq, ctx, new Uint8Array([1]).buffer, "image/png");
    const r = await uploadPendingReceipts(rq, {
      upload: async () => ({ ok: true as const }),
      read: async () => {
        throw new Error("EF down");
      },
    });
    expect(r.uploaded).toBe(1);
    expect(await rq.list()).toHaveLength(0);
  });

  it("R-006-10 サーバーに断られた画像は、端末に残す（消さない）", async () => {
    await enqueueReceipt(box, rq, ctx, new Uint8Array([1]).buffer, "image/png");
    const r = await uploadPendingReceipts(rq, {
      upload: async () => ({ ok: false as const, kind: "server" as const, message: "403" }),
      read: async () => {},
    });
    expect(r).toEqual({ uploaded: 0, remaining: 1, offline: false });
  });
});
