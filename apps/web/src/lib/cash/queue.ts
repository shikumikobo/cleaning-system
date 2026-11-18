// 電波のない間の出入り・レシートのため方（R-006-10・22）。
// 出入りとレシートの「行」は、001 の送り箱（作った順に送る）にためる。レシートの「画像」は、別の入れ物（端末の IndexedDB）にためる。
// 順：レシートの行 → 出入りの行（出入りの外部キーが先に届かないように）。画像は行とは別に、電波が戻ったら置き場所に上げる。
import { openDb, reqToPromise, txDone } from "../offline/db";
import type { Outbox, OutboxItem } from "../offline";
import type { Direction } from "./entry";

export interface CashContext {
  tenantId: string;
  /** 持ち手の所属（自分の membership の id） */
  membershipId: string;
  accountId: string;
  deviceId: string;
}

export interface NewCashEntry {
  /** 端末で作った uuid。省くと作る（同じ ID は1件だけ） */
  id?: string;
  date: string;
  amount: number;
  purpose: string;
  direction: Direction;
  receiptId?: string | null;
  buildingId?: string | null;
  workId?: string | null;
}

export function enqueueCashEntry(box: Outbox, ctx: CashContext, e: NewCashEntry): Promise<OutboxItem> {
  return box.enqueue({
    id: e.id,
    kind: "insert",
    target: "cash_entries",
    tenantId: ctx.tenantId,
    membershipId: ctx.membershipId,
    payload: {
      account_id: ctx.accountId,
      holder_id: ctx.membershipId,
      entry_date: e.date,
      direction: e.direction,
      amount: e.amount,
      purpose: e.purpose,
      receipt_id: e.receiptId ?? null,
      building_id: e.buildingId ?? null,
      work_id: e.workId ?? null,
      status: "draft",
      device_id: ctx.deviceId,
      client_created_at: new Date().toISOString(),
    },
  });
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** 画像の置き場所：<会社の ID>/receipts/<レシートの ID>.<拡張子> */
export function receiptPath(tenantId: string, receiptId: string, mime: string): string {
  return `${tenantId}/receipts/${receiptId}.${EXT[mime] ?? "jpg"}`;
}

export interface QueuedReceipt {
  id: string;
  tenantId: string;
  path: string;
  bytes: ArrayBuffer;
  mime: string;
}

export interface ReceiptQueue {
  add(item: QueuedReceipt): Promise<void>;
  list(): Promise<QueuedReceipt[]>;
  remove(id: string): Promise<void>;
}

export async function openReceiptQueue(dbName = "cleaning-receipts"): Promise<ReceiptQueue> {
  const db = await openDb(dbName);
  return {
    async add(item) {
      const tx = db.transaction("items", "readwrite");
      tx.objectStore("items").put(item);
      await txDone(tx);
    },
    async list() {
      const tx = db.transaction("items", "readonly");
      return (await reqToPromise(tx.objectStore("items").getAll())) as QueuedReceipt[];
    },
    async remove(id) {
      const tx = db.transaction("items", "readwrite");
      tx.objectStore("items").delete(id);
      await txDone(tx);
    },
  };
}

/** 撮ったレシート：画像を端末にため、レシートの行を送り箱に入れる。レシートの ID を返す */
export async function enqueueReceipt(box: Outbox, rq: ReceiptQueue, ctx: CashContext, bytes: ArrayBuffer, mime: string): Promise<string> {
  const id = crypto.randomUUID();
  const path = receiptPath(ctx.tenantId, id, mime);
  await rq.add({ id, tenantId: ctx.tenantId, path, bytes, mime });
  await box.enqueue({
    id,
    kind: "insert",
    target: "receipts",
    tenantId: ctx.tenantId,
    membershipId: ctx.membershipId,
    payload: {
      holder_id: ctx.membershipId,
      storage_path: path,
      status: "pending",
      device_id: ctx.deviceId,
      client_created_at: new Date().toISOString(),
    },
  });
  return id;
}

export type UploadResult = { ok: true } | { ok: false; kind: "network" | "auth" | "server"; message: string };

export interface ReceiptUploader {
  upload(path: string, bytes: ArrayBuffer, mime: string): Promise<UploadResult>;
  /** 置き場所に上がったあとに、読み取りの Edge Function を呼ぶ。失敗しても画像は消す（読み取りは候補） */
  read(receiptId: string): Promise<void>;
}

/** 端末にためた画像を、電波が戻ったら置き場所に上げる。つながらなければ止め、断られたものは残す */
export async function uploadPendingReceipts(rq: ReceiptQueue, up: ReceiptUploader): Promise<{ uploaded: number; remaining: number; offline: boolean }> {
  let uploaded = 0;
  let offline = false;
  const items = await rq.list();
  for (const it of items) {
    let r: UploadResult;
    try {
      r = await up.upload(it.path, it.bytes, it.mime);
    } catch (e) {
      r = { ok: false, kind: e instanceof TypeError ? "network" : "server", message: String((e as Error)?.message ?? e) };
    }
    if (!r.ok) {
      if (r.kind === "network" || r.kind === "auth") {
        offline = true;
        break;
      }
      continue; // 断られた：残して、次へ
    }
    try {
      await up.read(it.id);
    } catch {
      // 読み取りは候補。失敗しても、手で入れられる
    }
    await rq.remove(it.id);
    uploaded++;
  }
  return { uploaded, remaining: (await rq.list()).length, offline };
}

export type { OutboxItem };
