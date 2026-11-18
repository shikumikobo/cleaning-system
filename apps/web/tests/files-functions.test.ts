// Edge Function の中身（機能 005）：期限つきの URL（sign-file-urls）と、ファイルの掃除（sweep-files）。
// Deno に依存しない部分を、偽の口で確かめる。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPIRES,
  MAX_EXPIRES,
  MAX_IDS,
  handleSignFileUrls,
  runFileSweep,
  type SignDeps,
  type SweepStore,
} from "../../../supabase/functions/_shared/files";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

// ---- 期限つきの URL ----
interface SignLog {
  reads: Array<{ auth: string; ids: string[] }>;
  signs: Array<{ paths: string[]; expiresIn: number }>;
}
function signDeps(visible: Record<string, string>, log: SignLog, over: Partial<SignDeps> = {}): SignDeps {
  return {
    async readVisible(auth, ids) {
      log.reads.push({ auth, ids });
      return ids.filter((i) => visible[i]).map((i) => ({ id: i, storage_path: visible[i] }));
    },
    async sign(paths, expiresIn) {
      log.signs.push({ paths, expiresIn });
      return paths.map((p) => ({ path: p, url: `https://files.example.test/${p}?token=t` }));
    },
    ...over,
  };
}
const newLog = (): SignLog => ({ reads: [], signs: [] });

describe("期限つきの URL（sign-file-urls）", () => {
  it("R-005-9 見える行の URL を、1回の署名の呼び出しでまとめて返す。期限の初めは 10 分", async () => {
    const log = newLog();
    const r = await handleSignFileUrls("Bearer jwt", { ids: [id(1), id(2), id(3)] }, signDeps({ [id(1)]: "t/files/a.pdf", [id(2)]: "t/files/b.pdf", [id(3)]: "t/files/c.pdf" }, log));
    expect(r.status).toBe(200);
    expect(log.signs).toHaveLength(1);
    expect(log.signs[0].paths).toEqual(["t/files/a.pdf", "t/files/b.pdf", "t/files/c.pdf"]);
    expect(log.signs[0].expiresIn).toBe(DEFAULT_EXPIRES);
    expect(DEFAULT_EXPIRES).toBe(600);
    const body = r.body as { urls: Record<string, string>; not_found: string[]; expires_in: number };
    expect(Object.keys(body.urls)).toEqual([id(1), id(2), id(3)]);
    expect(body.urls[id(1)]).toContain("t/files/a.pdf");
    expect(body.not_found).toEqual([]);
    expect(body.expires_in).toBe(600);
  });

  it("R-005-9 ログインの鍵で行を読む（見える範囲は RLS が決める）。期限は指定でき、最長 1 時間に丸める", async () => {
    const log = newLog();
    await handleSignFileUrls("Bearer user-jwt", { ids: [id(1)], expires_in: 60 }, signDeps({ [id(1)]: "t/files/a.pdf" }, log));
    expect(log.reads[0].auth).toBe("Bearer user-jwt");
    expect(log.signs[0].expiresIn).toBe(60);
    await handleSignFileUrls("Bearer jwt", { ids: [id(1)], expires_in: 99999 }, signDeps({ [id(1)]: "t/files/a.pdf" }, log));
    expect(log.signs[1].expiresIn).toBe(MAX_EXPIRES);
    expect(MAX_EXPIRES).toBe(3600);
    await handleSignFileUrls("Bearer jwt", { ids: [id(1)], expires_in: -5 }, signDeps({ [id(1)]: "t/files/a.pdf" }, log));
    expect(log.signs[2].expiresIn).toBe(DEFAULT_EXPIRES);
  });

  it("R-005-10 見えない行（別の会社・共有なし・消した行）の ID は、URL を作らず not_found に入れる。見える分は返す", async () => {
    const log = newLog();
    const r = await handleSignFileUrls("Bearer jwt", { ids: [id(1), id(2), id(3)] }, signDeps({ [id(1)]: "t/files/a.pdf" }, log));
    const body = r.body as { urls: Record<string, string>; not_found: string[] };
    expect(r.status).toBe(200);
    expect(Object.keys(body.urls)).toEqual([id(1)]);
    expect(body.not_found).toEqual([id(2), id(3)]);
    expect(log.signs[0].paths).toEqual(["t/files/a.pdf"]); // 見えない行のパスは署名に渡さない
    expect(JSON.stringify(r.body)).not.toMatch(/別の会社|共有|消し/); // 理由を区別して返さない
  });

  it("R-005-10 1つも見えないときは、署名を呼ばず、すべて not_found", async () => {
    const log = newLog();
    const r = await handleSignFileUrls("Bearer jwt", { ids: [id(7)] }, signDeps({}, log));
    expect(log.signs).toHaveLength(0);
    expect((r.body as { urls: object; not_found: string[] }).not_found).toEqual([id(7)]);
  });

  it("R-005-10 署名に失敗した行は、その ID だけ failed にして、ほかは返す（URL や鍵をエラーに入れない）", async () => {
    const log = newLog();
    const r = await handleSignFileUrls(
      "Bearer jwt",
      { ids: [id(1), id(2)] },
      signDeps({ [id(1)]: "t/files/a.pdf", [id(2)]: "t/files/b.pdf" }, log, {
        async sign(paths) {
          return paths.map((p) => (p.endsWith("b.pdf") ? { path: p, url: null, error: "secret-key-abcdefghijklmnopqrstuvwxyz123456" } : { path: p, url: `https://x.test/${p}` }));
        },
      }),
    );
    const body = r.body as { urls: Record<string, string>; failed: string[] };
    expect(Object.keys(body.urls)).toEqual([id(1)]);
    expect(body.failed).toEqual([id(2)]);
    expect(JSON.stringify(r.body)).not.toContain("secret-key");
  });

  it("R-005-10 行を読めなかった（通信の失敗など）なら、500 で理由を伏せて返す", async () => {
    const r = await handleSignFileUrls("Bearer jwt", { ids: [id(1)] }, {
      async readVisible() {
        throw new Error("connection to db.secret-host.example.test failed password=abcdefghijklmnopqrstuvwxyz0123456789");
      },
      async sign() {
        return [];
      },
    });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("R-005-11 ログインしていない呼び出しは、行も読まず、URL も作らず、401 で断る", async () => {
    const log = newLog();
    const r = await handleSignFileUrls(null, { ids: [id(1)] }, signDeps({ [id(1)]: "t/files/a.pdf" }, log));
    expect(r.status).toBe(401);
    expect(log.reads).toHaveLength(0);
    expect(log.signs).toHaveLength(0);
  });

  it("R-005-12 ID が空・多すぎる・uuid の形でない・配列でないなら、断る（何も読まず作らない）", async () => {
    const log = newLog();
    const d = signDeps({ [id(1)]: "t/files/a.pdf" }, log);
    for (const bad of [
      undefined,
      {},
      { ids: [] },
      { ids: "x" },
      { ids: ["not-a-uuid"] },
      { ids: [id(1), 5] },
      { ids: Array.from({ length: MAX_IDS + 1 }, (_, i) => id(i + 1)) },
    ]) {
      const r = await handleSignFileUrls("Bearer jwt", bad, d);
      expect(r.status).toBe(400);
    }
    expect(MAX_IDS).toBe(100);
    expect(log.reads).toHaveLength(0);
    expect(log.signs).toHaveLength(0);
  });

  it("R-005-12 100 個ちょうどは受け付け、同じ ID の重複は1つにまとめる", async () => {
    const log = newLog();
    const ids = Array.from({ length: 100 }, (_, i) => id(i + 1));
    const visible = Object.fromEntries(ids.map((i, n) => [i, `t/files/${n}.pdf`]));
    const r = await handleSignFileUrls("Bearer jwt", { ids: [...ids, id(1)] }, signDeps(visible, log));
    expect(r.status).toBe(200);
    expect(log.reads[0].ids).toHaveLength(100);
  });
});

// ---- 掃除 ----
interface SweepLog {
  calls: string[];
  removed: string[];
  finished: Array<{ tenant: string; run: string; status: string; counts: Record<string, number>; error: string | null }>;
  graces: number[];
}
function sweepStore(
  opts: {
    tenants?: string[];
    running?: string[];
    orphans?: Record<string, string[]>;
    rows?: Record<string, number>;
    removeFails?: string[];
    startFails?: string[];
  },
  log: SweepLog,
): SweepStore {
  const left: Record<string, string[]> = { ...(opts.orphans ?? {}) };
  return {
    async tenants() {
      return opts.tenants ?? [T1, T2];
    },
    async startRun(t) {
      if (opts.startFails?.includes(t)) throw new Error("db down");
      if (opts.running?.includes(t)) return null;
      log.calls.push(`start:${t}`);
      return `run-${t.slice(0, 2)}`;
    },
    async orphans(t, graceSeconds) {
      log.graces.push(graceSeconds);
      log.calls.push(`orphans:${t}`);
      const out = left[t] ?? [];
      left[t] = [];
      return out;
    },
    async removeObjects(t, paths) {
      if (opts.removeFails?.includes(t)) throw new Error("storage error key=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
      log.calls.push(`remove:${t}`);
      log.removed.push(...paths);
    },
    async sweepRows(t) {
      log.calls.push(`rows:${t}`);
      return opts.rows?.[t] ?? 0;
    },
    async finishRun(tenant, run, status, counts, error) {
      log.calls.push(`finish:${tenant}`);
      log.finished.push({ tenant, run, status, counts, error });
    },
  };
}
const newSweepLog = (): SweepLog => ({ calls: [], removed: [], finished: [], graces: [] });

describe("ファイルの掃除（sweep-files）", () => {
  it("R-005-14 洗い出し → 実体を消す → 行の掃除 → 記録を閉じる、の順に、会社ごとに行う。猶予の初めは 1 日", async () => {
    const log = newSweepLog();
    const s = await runFileSweep({
      store: sweepStore({ tenants: [T1], orphans: { [T1]: [`${T1}/files/a/x.pdf`, `${T1}/files/b/y.pdf`] }, rows: { [T1]: 2 } }, log),
    });
    expect(log.calls).toEqual([`start:${T1}`, `orphans:${T1}`, `remove:${T1}`, `orphans:${T1}`, `rows:${T1}`, `finish:${T1}`]);
    expect(log.graces[0]).toBe(86400);
    expect(log.removed).toEqual([`${T1}/files/a/x.pdf`, `${T1}/files/b/y.pdf`]);
    expect(log.finished[0]).toMatchObject({ tenant: T1, status: "success", counts: { removed: 2, rows_deleted: 2 }, error: null });
    expect(s).toMatchObject({ tenants: 1, removed: 2, rowsDeleted: 2, failedTenants: 0, skipped: 0 });
  });

  it("R-005-14 猶予は指定でき、洗い出しにそのまま渡す", async () => {
    const log = newSweepLog();
    await runFileSweep({ store: sweepStore({ tenants: [T1] }, log), graceSeconds: 3600 });
    expect(log.graces[0]).toBe(3600);
  });

  it("R-005-16 files/ の外・別の会社のパスは、洗い出しの結果に混ざっていても消さない", async () => {
    const log = newSweepLog();
    const s = await runFileSweep({
      store: sweepStore({ tenants: [T1], orphans: { [T1]: [`${T1}/files/a/x.pdf`, `${T1}/photos/p.jpg`, `${T2}/files/z/z.pdf`, "files/x.pdf", `${T1}/files/`] } }, log),
    });
    expect(log.removed).toEqual([`${T1}/files/a/x.pdf`]);
    expect(s.removed).toBe(1);
    expect(s.refused).toBe(4);
  });

  it("R-005-17 同じ会社の掃除がすでに動いているなら、その会社は何もしない（skipped）。ほかの会社は進む", async () => {
    const log = newSweepLog();
    const s = await runFileSweep({ store: sweepStore({ running: [T1], orphans: { [T2]: [`${T2}/files/a/x.pdf`] } }, log) });
    expect(s.skipped).toBe(1);
    expect(log.calls.some((c) => c.endsWith(T1))).toBe(false);
    expect(log.removed).toEqual([`${T2}/files/a/x.pdf`]);
  });

  it("R-005-17 1つの会社の実体の削除が失敗しても、記録は失敗で閉じ（鍵は伏せる）、ほかの会社を続ける", async () => {
    const log = newSweepLog();
    const s = await runFileSweep({
      store: sweepStore({ removeFails: [T1], orphans: { [T1]: [`${T1}/files/a/x.pdf`], [T2]: [`${T2}/files/b/y.pdf`] }, rows: { [T2]: 1 } }, log),
    });
    expect(s.failedTenants).toBe(1);
    const f1 = log.finished.find((f) => f.tenant === T1)!;
    expect(f1.status).toBe("failure");
    expect(f1.error).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect((f1.error ?? "").length).toBeLessThanOrEqual(200);
    const f2 = log.finished.find((f) => f.tenant === T2)!;
    expect(f2.status).toBe("success");
    expect(log.removed).toEqual([`${T2}/files/b/y.pdf`]);
    expect(log.calls).not.toContain(`rows:${T1}`); // 実体が消せなかった会社は、行の掃除に進まない
  });

  it("R-005-17 記録を始められなかった（DB の失敗）会社は失敗として数え、ほかを止めない", async () => {
    const log = newSweepLog();
    const s = await runFileSweep({ store: sweepStore({ startFails: [T1], orphans: { [T2]: [] } }, log) });
    expect(s.failedTenants).toBe(1);
    expect(log.finished.map((f) => f.tenant)).toEqual([T2]);
  });

  it("R-005-14 洗い出しが同じ結果を返し続けても（消えない実体）、無限に回らない", async () => {
    const log = newSweepLog();
    let n = 0;
    const store = sweepStore({ tenants: [T1] }, log);
    store.orphans = async () => {
      n++;
      if (n > 20) throw new Error("loop");
      return [`${T1}/files/a/x.pdf`];
    };
    const s = await runFileSweep({ store });
    expect(s.failedTenants).toBe(0);
    expect(n).toBeLessThanOrEqual(3);
  });
});
