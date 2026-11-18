// Edge Function の中身（機能 008）：写真の期限つきの URL（sign-file-urls の source: "photos"）と、写真の掃除（sweep-files）。
// Deno に依存しない判断（_shared/files.ts）を、偽の口で確かめる。
import { describe, expect, it } from "vitest";
import { handleSignFileUrls, runFileSweep, type SignDeps, type SignOptions, type SweepStore } from "../../../supabase/functions/_shared/files";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

// ---- 写真の期限つきの URL ----
interface Log {
  reads: Array<{ ids: string[]; opts?: SignOptions }>;
  signs: string[][];
}
/** photos: id → { photo, thumb }（見える行だけ） */
function deps(photos: Record<string, { photo: string; thumb: string }>, log: Log): SignDeps {
  return {
    async readVisible(_auth, ids, opts) {
      log.reads.push({ ids, opts });
      return ids
        .filter((i) => photos[i])
        .map((i) => ({ id: i, storage_path: opts?.source === "photos" && opts.variant === "thumb" ? photos[i].thumb : photos[i].photo }));
    },
    async sign(paths) {
      log.signs.push(paths);
      return paths.map((p) => ({ path: p, url: `https://files.example.test/${p}?token=t` }));
    },
  };
}
const P = {
  [id(1)]: { photo: "t/photos/1/photo.jpg", thumb: "t/photos/1/thumb.jpg" },
  [id(2)]: { photo: "t/photos/2/photo.jpg", thumb: "t/photos/2/thumb.jpg" },
};

describe("写真の期限つきの URL（sign-file-urls）", () => {
  it("R-008-20 source が photos で variant が thumb なら、見える写真の小さな画像を、1回の署名でまとめて返す", async () => {
    const log: Log = { reads: [], signs: [] };
    const r = await handleSignFileUrls("Bearer jwt", { ids: [id(1), id(2)], source: "photos", variant: "thumb" }, deps(P, log));
    expect(r.status).toBe(200);
    expect(log.reads[0].opts).toEqual({ source: "photos", variant: "thumb" });
    expect(log.signs).toEqual([["t/photos/1/thumb.jpg", "t/photos/2/thumb.jpg"]]);
    const body = r.body as { urls: Record<string, string> };
    expect(body.urls[id(1)]).toContain("t/photos/1/thumb.jpg");
  });

  it("R-008-20 variant を省くと元の画像。見えない写真（別の会社・外部の人に見せない・消した）は、区別せず not_found", async () => {
    const log: Log = { reads: [], signs: [] };
    const r = await handleSignFileUrls("Bearer jwt", { ids: [id(1), id(9)], source: "photos" }, deps(P, log));
    expect(log.signs).toEqual([["t/photos/1/photo.jpg"]]);
    const body = r.body as { urls: Record<string, string>; not_found: string[] };
    expect(Object.keys(body.urls)).toEqual([id(1)]);
    expect(body.not_found).toEqual([id(9)]);
  });

  it("R-008-20 source を省くと、これまでどおりファイル（005）。ログインしていなければ 401", async () => {
    const log: Log = { reads: [], signs: [] };
    await handleSignFileUrls("Bearer jwt", { ids: [id(1)] }, deps(P, log));
    expect(log.reads[0].opts).toEqual({ source: "files", variant: "original" });
    const r = await handleSignFileUrls(null, { ids: [id(1)], source: "photos" }, deps(P, log));
    expect(r.status).toBe(401);
    expect(log.reads).toHaveLength(1);
  });

  it("R-008-21 source・variant が決まった値でなければ、何も読まず作らず 400 で断る", async () => {
    const log: Log = { reads: [], signs: [] };
    for (const bad of [{ source: "receipts" }, { source: "photos", variant: "huge" }, { source: 1 }, { source: "photos", variant: null }]) {
      const r = await handleSignFileUrls("Bearer jwt", { ids: [id(1)], ...bad }, deps(P, log));
      expect(r.status).toBe(400);
    }
    expect(log.reads).toHaveLength(0);
    expect(log.signs).toHaveLength(0);
  });
});

// ---- 写真の掃除 ----
interface SLog {
  calls: string[];
  removed: string[];
  finished: Array<{ tenant: string; status: string; counts: Record<string, number> }>;
}
function store(opts: { photos?: Record<string, string[]>; photoRows?: Record<string, number>; withPhotos?: boolean; removeFailsPhoto?: string[] }, log: SLog): SweepStore {
  const left: Record<string, string[]> = { ...(opts.photos ?? {}) };
  const base: SweepStore = {
    async tenants() {
      return [T1, T2];
    },
    async startRun(t) {
      log.calls.push(`start:${t}`);
      return `run-${t.slice(0, 2)}`;
    },
    async orphans(t) {
      log.calls.push(`orphans:${t}`);
      return [];
    },
    async removeObjects(t, paths) {
      if (opts.removeFailsPhoto?.includes(t) && paths.some((p) => p.includes("/photos/"))) throw new Error("storage error");
      log.calls.push(`remove:${t}`);
      log.removed.push(...paths);
    },
    async sweepRows(t) {
      log.calls.push(`rows:${t}`);
      return 0;
    },
    async finishRun(tenant, _run, status, counts) {
      log.calls.push(`finish:${tenant}`);
      log.finished.push({ tenant, status, counts });
    },
  };
  if (opts.withPhotos === false) return base;
  return {
    ...base,
    async photoOrphans(t) {
      log.calls.push(`photo_orphans:${t}`);
      const out = left[t] ?? [];
      left[t] = [];
      return out;
    },
    async sweepPhotoRows(t) {
      log.calls.push(`photo_rows:${t}`);
      return opts.photoRows?.[t] ?? 0;
    },
  };
}
const newLog = (): SLog => ({ calls: [], removed: [], finished: [] });

describe("写真の掃除（sweep-files）", () => {
  it("R-008-19 ファイルの掃除のあと、同じ会社の同じ記録の中で、写真の実体を消し、実体のない写真の行を論理削除する", async () => {
    const log = newLog();
    const s = await runFileSweep({
      store: store({ photos: { [T1]: [`${T1}/photos/a/photo.jpg`, `${T1}/photos/a/thumb.jpg`] }, photoRows: { [T1]: 3 } }, log),
      graceSeconds: 7200,
    });
    const t1 = log.calls.filter((c) => c.endsWith(T1));
    expect(t1).toEqual([`start:${T1}`, `orphans:${T1}`, `rows:${T1}`, `photo_orphans:${T1}`, `remove:${T1}`, `photo_orphans:${T1}`, `photo_rows:${T1}`, `finish:${T1}`]);
    expect(log.removed).toEqual([`${T1}/photos/a/photo.jpg`, `${T1}/photos/a/thumb.jpg`]);
    expect(log.finished.find((f) => f.tenant === T1)).toMatchObject({ status: "success", counts: { photos_removed: 2, photo_rows_deleted: 3 } });
    expect(s).toMatchObject({ photosRemoved: 2, photoRowsDeleted: 3, failedTenants: 0 });
  });

  it("R-008-19 洗い出しに、photos/ の外・別の会社のパスが混ざっていても消さない", async () => {
    const log = newLog();
    const s = await runFileSweep({
      store: store({ photos: { [T1]: [`${T1}/photos/a/photo.jpg`, `${T1}/files/x/x.pdf`, `${T2}/photos/b/photo.jpg`, `${T1}/receipts/r.jpg`, `${T1}/photos/`] } }, log),
    });
    expect(log.removed).toEqual([`${T1}/photos/a/photo.jpg`]);
    expect(s.photosRemoved).toBe(1);
    expect(s.refused).toBe(4);
  });

  it("R-008-19 写真の実体の削除が失敗した会社は、失敗で記録を閉じ、写真の行の掃除に進まず、ほかの会社を続ける", async () => {
    const log = newLog();
    const s = await runFileSweep({
      store: store({ removeFailsPhoto: [T1], photos: { [T1]: [`${T1}/photos/a/photo.jpg`], [T2]: [`${T2}/photos/b/photo.jpg`] }, photoRows: { [T2]: 1 } }, log),
    });
    expect(s.failedTenants).toBe(1);
    expect(log.finished.find((f) => f.tenant === T1)?.status).toBe("failure");
    expect(log.finished.find((f) => f.tenant === T2)?.status).toBe("success");
    expect(log.calls).not.toContain(`photo_rows:${T1}`);
    expect(log.removed).toEqual([`${T2}/photos/b/photo.jpg`]);
  });

  it("R-008-19 写真の口を持たない store では、これまでどおりファイルだけを掃除する（件数は 0）", async () => {
    const log = newLog();
    const s = await runFileSweep({ store: store({ withPhotos: false }, log) });
    expect(s).toMatchObject({ tenants: 2, photosRemoved: 0, photoRowsDeleted: 0 });
    expect(log.calls.some((c) => c.startsWith("photo_"))).toBe(false);
  });
});
