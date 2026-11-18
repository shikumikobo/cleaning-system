// 電波のない間の報告書のため方と、送り直し（機能 009。波 0 の送り直しの土台・008 の写真のため方と同じ形）。
// 報告書は、報告書ごとに1件、端末の入れ物（IndexedDB）にためる（保存し直すと中身を置き換える）。
// 送る順は 報告書 → 項目（既にあれば無視）→ 項目のチェックとメモ → 報告書のメモ（版を条件にする）。
// 端末で作った uuid が報告書・項目の id なので、二度送っても1件。送れるまで端末から消さない。
import { openDb, reqToPromise, txDone } from "../offline/db";
import type { NewReportItemRow, NewReportRow, ReportDraft } from "./types";

export interface QueuedReport {
  /** 報告書の id */
  id: string;
  tenantId: string;
  draft: ReportDraft;
  /** 送るとき、報告書のメモを直す条件にする版（サーバーでこの版のときだけ直す） */
  baseVersion: number;
  /** サーバーが持っていると分かっている、報告書のメモ（これと同じなら、メモは送らない＝版も上がらない） */
  serverRemarks: string;
  /** 保存するたびに 1 つ増える（送っている間に直されたら、消さずに残すための印） */
  rev: number;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  lastCode?: string;
}

export interface ReportQueue {
  get(id: string): Promise<QueuedReport | undefined>;
  /** 同じ報告書の id があれば、中身を置き換える（版の条件と最初にためた時刻は残す）。R-009-25 */
  save(draft: ReportDraft, ctx: { tenantId: string; baseVersion: number; serverRemarks?: string }): Promise<QueuedReport>;
  list(): Promise<QueuedReport[]>;
  update(id: string, patch: Partial<QueuedReport>): Promise<void>;
  /** rev を渡したときは、その rev のままのときだけ消す（送っている間に直されていたら残す） */
  remove(id: string, rev?: number): Promise<boolean>;
  count(): Promise<number>;
  subscribe(listener: () => void): () => void;
}

export async function openReportQueue(dbName = "cleaning-reports"): Promise<ReportQueue> {
  const db = await openDb(dbName);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const all = async () => {
    const tx = db.transaction("items", "readonly");
    const rows = (await reqToPromise(tx.objectStore("items").getAll())) as QueuedReport[];
    return rows.sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));
  };
  return {
    async get(id) {
      const tx = db.transaction("items", "readonly");
      return (await reqToPromise(tx.objectStore("items").get(id))) as QueuedReport | undefined;
    },
    async save(draft, ctx) {
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const cur = (await reqToPromise(store.get(draft.report.id))) as QueuedReport | undefined;
      const next: QueuedReport = cur
        ? { ...cur, draft, rev: cur.rev + 1, attempts: 0, lastError: undefined, lastCode: undefined }
        : { id: draft.report.id, tenantId: ctx.tenantId, draft, baseVersion: ctx.baseVersion, serverRemarks: ctx.serverRemarks ?? "", rev: 1, queuedAt: new Date().toISOString(), attempts: 0 };
      store.put(next);
      await txDone(tx);
      notify();
      return next;
    },
    list: all,
    async update(id, patch) {
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const cur = (await reqToPromise(store.get(id))) as QueuedReport | undefined;
      if (cur) store.put({ ...cur, ...patch, id });
      await txDone(tx);
      notify();
    },
    async remove(id, rev) {
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const cur = (await reqToPromise(store.get(id))) as QueuedReport | undefined;
      let removed = false;
      if (cur && (rev === undefined || cur.rev === rev)) {
        store.delete(id);
        removed = true;
      }
      await txDone(tx);
      if (removed) notify();
      return removed;
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

export type ReportOutcome =
  | { ok: true; duplicate?: boolean; version?: number }
  | { ok: false; kind: "network" | "auth" | "server"; message: string; code?: string };

/** 送る口（Supabase の表。単体のテストでは偽物） */
export interface ReportSender {
  /** 端末の uuid で、既にあれば無視する書き方で作る */
  insertReport(row: NewReportRow): Promise<ReportOutcome>;
  insertItems(rows: NewReportItemRow[]): Promise<ReportOutcome>;
  /** チェックとメモを直す（報告書が下書きでなければ、固定のあととして断られる） */
  updateItem(item: NewReportItemRow): Promise<ReportOutcome>;
  /** 報告書のメモを直す。版を条件にする。食い違い・固定のあとは断られる（R-009-28） */
  updateRemarks(id: string, remarks: string, baseVersion: number): Promise<ReportOutcome>;
}

export interface FlushReportsResult {
  sent: number;
  /** 送れた報告書ごとの、サーバーの版と、サーバーが持つメモ（画面が次の保存の条件にする） */
  synced: Record<string, { version: number; remarks: string }>;
  /** サーバーに断られて、端末に残したもの */
  rejected: number;
  remaining: number;
  /** つながらない・ログインが切れていて、止めた */
  offline: boolean;
}

interface Running {
  promise: Promise<FlushReportsResult>;
  /** 動いている間にもう一度呼ばれた：終わったら、もう一度動く（途中で電波が戻っても、取りこぼさない） */
  again: boolean;
}
const running = new WeakMap<ReportQueue, Running>();

/** 同時に2回呼んでも、同時には動かさない（同じ報告書を二度送らない。R-009-26）。動いている間に呼ばれたら、終わったあとにもう一度動く */
export function flushReports(q: ReportQueue, sender: ReportSender): Promise<FlushReportsResult> {
  const cur = running.get(q);
  if (cur) {
    cur.again = true;
    return cur.promise;
  }
  const state: Running = { again: false, promise: Promise.resolve(null as unknown as FlushReportsResult) };
  state.promise = (async () => {
    let total = null as FlushReportsResult | null;
    do {
      state.again = false;
      const r = await doFlush(q, sender);
      total = total ? { ...r, sent: total.sent + r.sent, synced: { ...total.synced, ...r.synced } } : r;
    } while (state.again);
    return total;
  })().finally(() => running.delete(q));
  running.set(q, state);
  return state.promise;
}

function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || /fetch|network|offline/i.test(String((e as Error)?.message ?? e));
}

async function doFlush(q: ReportQueue, sender: ReportSender): Promise<FlushReportsResult> {
  const res: FlushReportsResult = { sent: 0, synced: {}, rejected: 0, remaining: 0, offline: false };
  for (const it of await q.list()) {
    let newVersion: number | undefined;
    let failed: Extract<ReportOutcome, { ok: false }> | null = null;
    const steps: Array<() => Promise<ReportOutcome>> = [
      () => sender.insertReport(it.draft.report),
      () => sender.insertItems(it.draft.items),
      async () => {
        for (const item of it.draft.items) {
          const r = await sender.updateItem(item);
          if (!r.ok) return r;
        }
        return { ok: true };
      },
      // メモがサーバーと同じなら送らない（版を無駄に上げない）
      () => (it.draft.report.remarks === it.serverRemarks ? Promise.resolve<ReportOutcome>({ ok: true }) : sender.updateRemarks(it.draft.report.id, it.draft.report.remarks, it.baseVersion)),
    ];
    for (let k = 0; k < steps.length; k++) {
      let r: ReportOutcome;
      try {
        r = await steps[k]();
      } catch (e) {
        r = { ok: false, kind: isNetworkError(e) ? "network" : "server", message: String((e as Error)?.message ?? e) };
      }
      if (!r.ok) {
        failed = r;
        break;
      }
      if (k === 3 && r.version !== undefined) newVersion = r.version;
    }
    if (!failed) {
      const version = newVersion ?? it.baseVersion;
      const removed = await q.remove(it.id, it.rev);
      // 送っている間に直されていたら、残る。次は、今のサーバーの版とメモを条件にする
      if (!removed) await q.update(it.id, { baseVersion: version, serverRemarks: it.draft.report.remarks });
      res.synced[it.id] = { version, remarks: it.draft.report.remarks };
      res.sent++;
      continue;
    }
    if (failed.kind === "network" || failed.kind === "auth") {
      await q.update(it.id, { lastError: failed.message, lastCode: failed.code });
      res.offline = true;
      break; // 電波がない・ログインが切れている：エラーにはしない。残して、あとで送る
    }
    // サーバーに断られた：残して（消さない）、理由を覚え、次の報告書へ
    res.rejected++;
    await q.update(it.id, { attempts: it.attempts + 1, lastError: failed.message, lastCode: failed.code });
  }
  res.remaining = await q.count();
  return res;
}
