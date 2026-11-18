// 電波のない間の写真のため方と、送り直し（機能 008。波 0 の送り直しの土台の上）。
// 撮ったら、元の画像・小さな画像・行の中身を、端末の入れ物（IndexedDB）にためる。電波が戻ったら、
// 元の画像 → 小さな画像 → 行の順に送る（行だけが先に出来ない）。送れるまで端末から消さない。
// 端末で作った uuid が写真の id・置き場所の名前になるので、二度送っても1件。
import { openDb, reqToPromise, txDone } from "../offline/db";
import { buildPhotoPaths } from "./format";
import type { ProcessedPhoto } from "./process";
import type { NewPhotoRow, PhotoKind } from "./types";

export interface QueuedPhoto {
  id: string;
  tenantId: string;
  row: NewPhotoRow;
  photo: ArrayBuffer;
  thumb: ArrayBuffer;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  lastCode?: string;
}

export interface PhotoQueue {
  /** 同じ id がすでにあれば、先にためた中身を残して、それを返す */
  add(item: QueuedPhoto): Promise<QueuedPhoto>;
  list(): Promise<QueuedPhoto[]>;
  update(id: string, patch: Partial<QueuedPhoto>): Promise<void>;
  remove(id: string): Promise<void>;
  count(): Promise<number>;
  subscribe(listener: () => void): () => void;
}

export async function openPhotoQueue(dbName = "cleaning-photos"): Promise<PhotoQueue> {
  const db = await openDb(dbName);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const all = async () => {
    const tx = db.transaction("items", "readonly");
    const rows = (await reqToPromise(tx.objectStore("items").getAll())) as QueuedPhoto[];
    return rows.sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));
  };
  return {
    async add(item) {
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const existing = (await reqToPromise(store.get(item.id))) as QueuedPhoto | undefined;
      if (existing) {
        await txDone(tx);
        return existing;
      }
      store.add(item);
      await txDone(tx);
      notify();
      return item;
    },
    list: all,
    async update(id, patch) {
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const cur = (await reqToPromise(store.get(id))) as QueuedPhoto | undefined;
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
    async count() {
      return (await all()).length;
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export interface CaptureInput {
  /** 端末で作った uuid。省くと作る */
  id?: string;
  building_id: string;
  area_id?: string | null;
  room_id?: string | null;
  kind: PhotoKind;
  taken_at: string;
  /** 気づきから案件を作るとき、端末で作った案件の uuid（その案件が先に届いてから、この写真の行を送る） */
  request_id?: string | null;
  /** 報告書（009）の写真：作業と、報告書の項目（項目の行が先に届いてから、この写真の行を送る） */
  work_id?: string | null;
  report_item_id?: string | null;
  processed: ProcessedPhoto;
}

/** 撮った写真を端末にためる（R-008-24・25）。ためた中身を返す */
export function capturePhoto(q: PhotoQueue, ctx: { tenantId: string; membershipId: string }, i: CaptureInput): Promise<QueuedPhoto> {
  const id = i.id ?? crypto.randomUUID();
  const paths = buildPhotoPaths(ctx.tenantId, id);
  return q.add({
    id,
    tenantId: ctx.tenantId,
    row: {
      id,
      tenant_id: ctx.tenantId,
      building_id: i.building_id,
      area_id: i.area_id || null,
      room_id: i.room_id || null,
      request_id: i.request_id || null,
      work_id: i.work_id || null,
      report_item_id: i.report_item_id || null,
      kind: i.kind,
      taken_at: i.taken_at,
      taken_by: ctx.membershipId,
      storage_path: paths.photo,
      thumb_path: paths.thumb,
      width: i.processed.width,
      height: i.processed.height,
      bytes: i.processed.bytes,
    },
    photo: i.processed.photo,
    thumb: i.processed.thumb,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  });
}

export type Outcome = { ok: true; duplicate?: boolean } | { ok: false; kind: "network" | "auth" | "server"; message: string; code?: string };

/** 送る口（Supabase の Storage と表。単体のテストでは偽物） */
export interface PhotoSender {
  uploadFile(path: string, bytes: ArrayBuffer): Promise<Outcome>;
  /** 端末の uuid で、既にあれば無視する書き方（on conflict do nothing）で行を作る */
  insertRow(row: NewPhotoRow): Promise<Outcome>;
  /** 報告書の項目つきの写真は、項目の行がサーバーにあるときだけ送る（なければ待つ。R-009-29）。なくてもよい口 */
  ready?(row: NewPhotoRow): Promise<boolean>;
}

export interface FlushPhotosResult {
  sent: number;
  duplicates: number;
  /** サーバーに断られて、端末に残したもの */
  rejected: number;
  /** 報告書の項目の行がまだサーバーになくて、待っているもの（断られたのではない） */
  waiting: number;
  remaining: number;
  /** つながらない・ログインが切れていて、止めた */
  offline: boolean;
}

const running = new WeakMap<PhotoQueue, Promise<FlushPhotosResult>>();

/** 同時に2回呼んでも、1つだけ動く（同じ写真を二度送らない） */
export function flushPhotos(q: PhotoQueue, sender: PhotoSender): Promise<FlushPhotosResult> {
  const cur = running.get(q);
  if (cur) return cur;
  const p = doFlush(q, sender).finally(() => running.delete(q));
  running.set(q, p);
  return p;
}

function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || /fetch|network|offline/i.test(String((e as Error)?.message ?? e));
}

async function doFlush(q: PhotoQueue, sender: PhotoSender): Promise<FlushPhotosResult> {
  const res: FlushPhotosResult = { sent: 0, duplicates: 0, rejected: 0, waiting: 0, remaining: 0, offline: false };
  for (const it of await q.list()) {
    if (it.row.report_item_id && sender.ready) {
      const ok = await sender.ready(it.row).catch(() => false); // 確かめられない（電波がない）ときも、待つ
      if (!ok) {
        res.waiting++;
        continue;
      }
    }
    let dup = false;
    let failed: Extract<Outcome, { ok: false }> | null = null;
    const steps: Array<() => Promise<Outcome>> = [
      () => sender.uploadFile(it.row.storage_path, it.photo),
      () => sender.uploadFile(it.row.thumb_path, it.thumb),
      () => sender.insertRow(it.row),
    ];
    for (const step of steps) {
      let r: Outcome;
      try {
        r = await step();
      } catch (e) {
        r = { ok: false, kind: isNetworkError(e) ? "network" : "server", message: String((e as Error)?.message ?? e) };
      }
      if (!r.ok) {
        failed = r;
        break;
      }
      if (r.duplicate) dup = true;
    }
    if (!failed) {
      await q.remove(it.id);
      res.sent++;
      if (dup) res.duplicates++;
      continue;
    }
    if (failed.kind === "network" || failed.kind === "auth") {
      await q.update(it.id, { lastError: failed.message, lastCode: failed.code });
      res.offline = true;
      break; // 電波がない・ログインが切れている：エラーにはしない。残して、あとで送る
    }
    // サーバーに断られた：残して（消さない）、理由を覚え、次の写真へ
    res.rejected++;
    await q.update(it.id, { attempts: it.attempts + 1, lastError: failed.message, lastCode: failed.code });
  }
  res.remaining = await q.count();
  return res;
}
