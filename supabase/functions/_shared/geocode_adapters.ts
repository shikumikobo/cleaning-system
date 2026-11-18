// Deno にだけ依存する外への口（住所から位置を求める処理と、位置の掃除。機能 013）。判断は geocode.ts・purgeLocations.ts に置く。
// この PC には Deno がないため、ここは実行して確かめていない（型と形だけ。配備の前に supabase functions serve で確かめる）。
import { createClient } from "npm:@supabase/supabase-js@2";
import type { GeocodeOneDeps, GeocodeStore } from "./geocode.ts";
import { createGeocoder } from "./geocode.ts";
import type { PurgeStore } from "./purgeLocations.ts";

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

function serviceClient(env: Record<string, string | undefined>) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("supabase_env_missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** 位置を求める口（GEOCODER の環境変数で選ぶ。API のキーが要る口は、その環境変数も配備のときに入れる。ここには書かない） */
export function createEnvGeocoder(env: Record<string, string | undefined>) {
  return createGeocoder(env, (url, init) => fetch(url, init));
}

export function createGeocodeStore(env: Record<string, string | undefined>): GeocodeStore {
  const db = serviceClient(env);
  return {
    async tenants() {
      return must(await db.rpc("geocode_tenants"), "tenants") as unknown as string[];
    },
    async startRun(tenant) {
      return must(await db.rpc("geocode_start", { p_tenant: tenant }), "start_run") as unknown as string | null;
    },
    async pending(tenant, limit) {
      return must(await db.rpc("geocode_pending", { p_tenant: tenant, p_limit: limit }), "pending") as unknown as Array<{ id: string; address: string }>;
    },
    async apply(tenant, building, lat, lng) {
      return must(await db.rpc("geocode_apply", { p_tenant: tenant, p_building: building, p_lat: lat, p_lng: lng }), "apply") as unknown as boolean;
    },
    async fail(tenant, building) {
      must(await db.rpc("geocode_fail", { p_tenant: tenant, p_building: building }), "fail");
    },
    async finishRun(tenant, run, status, counts, error) {
      must(await db.rpc("geocode_finish", { p_tenant: tenant, p_run: run, p_status: status, p_counts: counts, p_error: error }), "finish_run");
    },
  };
}

/** 画面から 1 件求める入口。呼んだ人のログインの鍵で、RPC geocode_target（master.edit の確かめ）を呼ぶ */
export function createGeocodeOneDeps(env: Record<string, string | undefined>): GeocodeOneDeps {
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("supabase_env_missing");
  return {
    async target(authHeader, buildingId) {
      const user = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
      const { data, error } = await user.rpc("geocode_target", { p_building: buildingId });
      if (error) {
        if (error.code === "42501") return null;
        throw new Error(`geocode_target: ${error.message}`);
      }
      return data as { address: string };
    },
    geocoder: createEnvGeocoder(env),
  };
}

export function createPurgeStore(env: Record<string, string | undefined>): PurgeStore {
  const db = serviceClient(env);
  return {
    async tenants() {
      return must(await db.rpc("purge_locations_tenants"), "tenants") as unknown as string[];
    },
    async startRun(tenant) {
      return must(await db.rpc("purge_locations_start", { p_tenant: tenant }), "start_run") as unknown as string | null;
    },
    async purge(tenant) {
      return must(await db.rpc("purge_locations_run", { p_tenant: tenant }), "purge") as unknown as number;
    },
    async finishRun(tenant, run, status, counts, error) {
      must(await db.rpc("purge_locations_finish", { p_tenant: tenant, p_run: run, p_status: status, p_counts: counts, p_error: error }), "finish_run");
    },
  };
}
