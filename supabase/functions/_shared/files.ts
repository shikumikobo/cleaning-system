// ファイルの期限つきの URL（sign-file-urls）と、掃除（sweep-files）の判断（機能 005）。
// 外への口（DB・Storage）はすべて引数で受ける。Deno にも Node にも依存しない（単体のテストは Vitest で、偽の口を渡して確かめる）。
// 設計は specs/005-files-portal/design.md の3章。

export interface FnResponse {
  status: number;
  body: Record<string, unknown>;
}

/** 鍵や長い文字列を伏せ、200 字までにする。記録・エラーには必ずこれを通す */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "error";
  return raw.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "***").slice(0, 200);
}

// --- 期限つきの URL（R-005-9〜12）----------------------------------------------

export const DEFAULT_EXPIRES = 600;
export const MAX_EXPIRES = 3600;
export const MAX_IDS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FileRow {
  id: string;
  storage_path: string;
}

export interface SignedItem {
  path: string;
  url: string | null;
  error?: string;
}

/** 署名する元。files は 005 のファイル、photos は 008 の写真（variant：小さな画像か元の画像か。files では使わない） */
export type SignSource = "files" | "photos";
export type SignVariant = "thumb" | "original";
export interface SignOptions {
  source: SignSource;
  variant: SignVariant;
}

export interface SignDeps {
  /** 呼んだ人のログインの鍵で files（photos）を読む。見える行（RLS）だけが返る。storage_path は、写真では variant に合う置き場所 */
  readVisible(authHeader: string, ids: string[], opts?: SignOptions): Promise<FileRow[]>;
  /** 置き場所のパスを、1回の呼び出しでまとめて署名する（service_role） */
  sign(paths: string[], expiresIn: number): Promise<SignedItem[]>;
}

export async function handleSignFileUrls(authHeader: string | null, input: unknown, deps: SignDeps): Promise<FnResponse> {
  if (!authHeader) return { status: 401, body: { error: "ログインが必要です", code: "28000" } };
  const b = (input ?? {}) as Record<string, unknown>;
  const raw = b.ids;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1000 || raw.some((x) => typeof x !== "string" || !UUID.test(x))) {
    return { status: 400, body: { error: "ファイルの ID が正しくありません" } };
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_IDS) return { status: 400, body: { error: `一度に作れるのは ${MAX_IDS} 個までです` } };

  // 008：写真も同じ仕組みで署名する（source: "photos"。variant: "thumb" か "original"。初めは元の画像）
  const source = b.source === undefined ? "files" : b.source;
  const variant = b.variant === undefined ? "original" : b.variant;
  if (source !== "files" && source !== "photos") return { status: 400, body: { error: "source が正しくありません" } };
  if (variant !== "thumb" && variant !== "original") return { status: 400, body: { error: "variant が正しくありません" } };

  let expires = DEFAULT_EXPIRES;
  if (typeof b.expires_in === "number" && Number.isFinite(b.expires_in) && b.expires_in > 0) {
    expires = Math.min(Math.floor(b.expires_in), MAX_EXPIRES);
  }

  let rows: FileRow[];
  try {
    rows = await deps.readVisible(authHeader, ids, { source, variant });
  } catch {
    return { status: 500, body: { error: "ファイルの情報を読めませんでした" } };
  }
  const visible = new Map(rows.map((r) => [r.id, r.storage_path]));
  const notFound = ids.filter((i) => !visible.has(i)); // 別の会社・共有なし・消した行は、区別せずここに入る
  const found = ids.filter((i) => visible.has(i));

  const urls: Record<string, string> = {};
  const failed: string[] = [];
  if (found.length > 0) {
    let items: SignedItem[];
    try {
      items = await deps.sign(found.map((i) => visible.get(i) as string), expires);
    } catch {
      return { status: 502, body: { error: "URL を作れませんでした" } };
    }
    const byPath = new Map(items.map((it) => [it.path, it]));
    for (const i of found) {
      const it = byPath.get(visible.get(i) as string);
      if (it?.url) urls[i] = it.url;
      else failed.push(i);
    }
  }
  return { status: 200, body: { urls, not_found: notFound, failed, expires_in: expires } };
}

// --- 掃除（R-005-14〜17）-------------------------------------------------------

export const DEFAULT_GRACE_SECONDS = 86400; // 1 日
const ORPHAN_LIMIT = 1000;

/** DB（file_sweep_* の関数。service_role）と Storage への口 */
export interface SweepStore {
  tenants(): Promise<string[]>;
  startRun(tenant: string): Promise<string | null>;
  orphans(tenant: string, graceSeconds: number, limit: number): Promise<string[]>;
  removeObjects(tenant: string, paths: string[]): Promise<void>;
  sweepRows(tenant: string, graceSeconds: number): Promise<number>;
  /** 008：写真の掃除（photos/ の下）。写真の口がない store では、写真は掃除しない */
  photoOrphans?(tenant: string, graceSeconds: number, limit: number): Promise<string[]>;
  sweepPhotoRows?(tenant: string, graceSeconds: number): Promise<number>;
  finishRun(tenant: string, run: string, status: "success" | "failure", counts: Record<string, number>, error: string | null): Promise<void>;
}

export interface SweepSummary {
  tenants: number;
  skipped: number;
  failedTenants: number;
  removed: number;
  rowsDeleted: number;
  /** files/（写真は photos/）の外や別の会社のパスなので、消さなかった数 */
  refused: number;
  /** 008：写真の実体を消した数と、実体のない写真の行を論理削除した数 */
  photosRemoved: number;
  photoRowsDeleted: number;
}

export async function runFileSweep(deps: { store: SweepStore; graceSeconds?: number }): Promise<SweepSummary> {
  const { store } = deps;
  const grace = deps.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const summary: SweepSummary = { tenants: 0, skipped: 0, failedTenants: 0, removed: 0, rowsDeleted: 0, refused: 0, photosRemoved: 0, photoRowsDeleted: 0 };
  for (const tenant of await store.tenants()) {
    summary.tenants++;
    let run: string | null = null;
    const counts = { removed: 0, rows_deleted: 0, refused: 0, photos_removed: 0, photo_rows_deleted: 0 };
    try {
      run = await store.startRun(tenant);
      if (!run) {
        summary.skipped++; // すでに同じ会社の掃除が動いている（R-005-17）
        continue;
      }
      const prefix = `${tenant}/files/`;
      let prev: string[] = [];
      for (;;) {
        const batch = await store.orphans(tenant, grace, ORPHAN_LIMIT);
        if (batch.length === 0 || (batch.length === prev.length && batch.every((p, i) => p === prev[i]))) break;
        prev = batch;
        // 書く先は必ずこの会社の files/ の下だけ。洗い出しに混ざっていても、ほかは消さない（R-005-16）
        const safe = batch.filter((p) => p.startsWith(prefix) && p.length > prefix.length);
        counts.refused += batch.length - safe.length;
        if (safe.length === 0) break;
        await store.removeObjects(tenant, safe);
        counts.removed += safe.length;
      }
      counts.rows_deleted = await store.sweepRows(tenant, grace);
      // 008：写真。書く先は必ずこの会社の photos/ の下だけ（R-008-19）
      if (store.photoOrphans) {
        const pprefix = `${tenant}/photos/`;
        let pprev: string[] = [];
        for (;;) {
          const batch = await store.photoOrphans(tenant, grace, ORPHAN_LIMIT);
          if (batch.length === 0 || (batch.length === pprev.length && batch.every((p, i) => p === pprev[i]))) break;
          pprev = batch;
          const safe = batch.filter((p) => p.startsWith(pprefix) && p.length > pprefix.length);
          counts.refused += batch.length - safe.length;
          if (safe.length === 0) break;
          await store.removeObjects(tenant, safe);
          counts.photos_removed += safe.length;
        }
      }
      if (store.sweepPhotoRows) counts.photo_rows_deleted = await store.sweepPhotoRows(tenant, grace);
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
      summary.removed += counts.removed;
      summary.rowsDeleted += counts.rows_deleted;
      summary.refused += counts.refused;
      summary.photosRemoved += counts.photos_removed;
      summary.photoRowsDeleted += counts.photo_rows_deleted;
    }
  }
  return summary;
}
