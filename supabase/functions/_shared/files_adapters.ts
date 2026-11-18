// Deno にだけ依存する外への口（ファイルの URL と掃除。機能 005）。判断は files.ts に置く。
// この PC には Deno がないため、ここは実行して確かめていない（型と形だけ。配備の前に supabase functions serve で確かめる）。
import { createClient } from "npm:@supabase/supabase-js@2";
import type { FileRow, SignDeps, SweepStore } from "./files.ts";

const BUCKET = "tenant-files";

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

/**
 * 期限つきの URL の口。
 * 見える行は、呼んだ人のログインの鍵で files を読んで決める（RLS。外部の人は共有されたものだけ）。
 * 署名だけ service_role（外部の人は置き場所を直接は読めないので、その人の鍵では署名できない）。
 */
export function createSignDeps(env: Record<string, string | undefined>): SignDeps {
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) throw new Error("supabase_env_missing");
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async readVisible(authHeader, ids, opts) {
      const user = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
      if (opts?.source === "photos") {
        // 写真：小さな画像か元の画像のパスを、storage_path の名前で返す（見える行は RLS が決める）
        const col = opts.variant === "thumb" ? "thumb_path" : "storage_path";
        const rows = must(await user.from("photos").select(`id, ${col}`).in("id", ids).is("deleted_at", null), "photos") as unknown as Array<Record<string, string>>;
        return rows.map((r) => ({ id: r.id, storage_path: r[col] }));
      }
      return must(await user.from("files").select("id, storage_path").in("id", ids).is("deleted_at", null), "files") as FileRow[];
    },
    async sign(paths, expiresIn) {
      const { data, error } = await admin.storage.from(BUCKET).createSignedUrls(paths, expiresIn);
      if (error) throw new Error(`sign: ${error.message}`);
      return (data ?? []).map((d: { path: string | null; signedUrl: string; error: string | null }) => ({
        path: d.path ?? "",
        url: d.error ? null : d.signedUrl,
        error: d.error ?? undefined,
      }));
    },
  };
}

/** 掃除の口（service_role。file_sweep_* の関数と、Storage の API） */
export function createSweepStore(env: Record<string, string | undefined>): SweepStore {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("supabase_env_missing");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const interval = (sec: number) => `${Math.max(0, Math.floor(sec))} seconds`;
  return {
    async tenants() {
      return must(await db.rpc("file_sweep_tenants"), "tenants") as unknown as string[];
    },
    async startRun(tenant) {
      return must(await db.rpc("file_sweep_start_run", { p_tenant: tenant }), "start_run") as unknown as string | null;
    },
    async orphans(tenant, graceSeconds, limit) {
      return must(await db.rpc("file_sweep_orphans", { p_tenant: tenant, p_grace: interval(graceSeconds), p_limit: limit }), "orphans") as unknown as string[];
    },
    async removeObjects(_tenant, paths) {
      const { error } = await db.storage.from(BUCKET).remove(paths);
      if (error) throw new Error(`remove: ${error.message}`);
    },
    async sweepRows(tenant, graceSeconds) {
      return must(await db.rpc("file_sweep_rows", { p_tenant: tenant, p_grace: interval(graceSeconds) }), "sweep_rows") as unknown as number;
    },
    // 008：写真（<tenant>/photos/ の下）の掃除。DB の関数 photo_sweep_*（service_role だけ）
    async photoOrphans(tenant, graceSeconds, limit) {
      return must(await db.rpc("photo_sweep_orphans", { p_tenant: tenant, p_grace: interval(graceSeconds), p_limit: limit }), "photo_orphans") as unknown as string[];
    },
    async sweepPhotoRows(tenant, graceSeconds) {
      return must(await db.rpc("photo_sweep_rows", { p_tenant: tenant, p_grace: interval(graceSeconds) }), "photo_rows") as unknown as number;
    },
    async finishRun(tenant, run, status, counts, error) {
      must(await db.rpc("file_sweep_finish_run", { p_tenant: tenant, p_run: run, p_status: status, p_counts: counts, p_error: error }), "finish_run");
    },
  };
}
