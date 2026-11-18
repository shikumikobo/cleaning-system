// 送り箱：電波のない間の「書く行」と「呼ぶ RPC」を、端末（IndexedDB）にためる。
// 送れるまで消さない。同じ ID は1件だけ（二度ためても増えない）。
import { DEFAULT_DB, openDb, reqToPromise, txDone } from "./db";

export type OutboxKind = "insert" | "rpc";

export interface OutboxItem {
  /** 端末で作った uuid。insert は行の id、rpc は引数 p_id になる（二度目は何もしない） */
  id: string;
  kind: OutboxKind;
  /** insert なら表の名前、rpc なら関数の名前 */
  target: string;
  tenantId: string;
  /** 端末のエラーの記録（R-001-33）を書くときの持ち主 */
  membershipId?: string;
  payload: Record<string, unknown>;
  clientCreatedAt: string;
  seq: number;
  attempts: number;
  lastError?: string;
  lastCode?: string;
  /** すでに端末のエラーとして記録した中身（同じエラーを何度も記録しない） */
  loggedError?: string;
}

export type NewItem = Omit<OutboxItem, "id" | "clientCreatedAt" | "seq" | "attempts"> & { id?: string };

export interface Outbox {
  enqueue(item: NewItem): Promise<OutboxItem>;
  list(): Promise<OutboxItem[]>;
  pendingCount(tenantId?: string): Promise<number>;
  update(id: string, patch: Partial<OutboxItem>): Promise<void>;
  remove(id: string): Promise<void>;
  /** 件数が変わったときに呼ばれる（画面の件数の表示用）。解除する関数を返す */
  subscribe(listener: () => void): () => void;
}

let lastSeq = 0;
function nextSeq(): number {
  lastSeq = Math.max(Date.now() * 1000, lastSeq + 1);
  return lastSeq;
}

export async function openOutbox(dbName: string = DEFAULT_DB): Promise<Outbox> {
  const db = await openDb(dbName);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  async function all(): Promise<OutboxItem[]> {
    const tx = db.transaction("items", "readonly");
    const rows = (await reqToPromise(tx.objectStore("items").getAll())) as OutboxItem[];
    return rows.sort((a, b) => a.seq - b.seq);
  }

  return {
    async enqueue(item) {
      const id = item.id ?? crypto.randomUUID();
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const existing = (await reqToPromise(store.get(id))) as OutboxItem | undefined;
      if (existing) {
        await txDone(tx);
        return existing; // 同じ ID は1件だけ。先にためた中身を残す
      }
      const saved: OutboxItem = {
        ...item,
        id,
        clientCreatedAt: new Date().toISOString(),
        seq: nextSeq(),
        attempts: 0,
      };
      store.add(saved);
      await txDone(tx);
      notify();
      return saved;
    },
    list: all,
    async pendingCount(tenantId) {
      const rows = await all();
      return tenantId ? rows.filter((r) => r.tenantId === tenantId).length : rows.length;
    },
    async update(id, patch) {
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const cur = (await reqToPromise(store.get(id))) as OutboxItem | undefined;
      if (cur) store.put({ ...cur, ...patch, id });
      await txDone(tx);
      notify();
    },
    async remove(id) {
      const tx = db.transaction("items", "readwrite");
      tx.objectStore("items").delete(id);
      await txDone(tx);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
