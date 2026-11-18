// 実績の位置を 90 日で消す定時の処理の判断（機能 013、R-013-19・20）。外への口（DB）は引数で受ける。
// Deno にも Node にも依存しない（単体のテストは Vitest で、偽の口を渡して確かめる）。判断の本体（何を消すか）は DB の関数 purge_locations_run にある。
//
// 守ること
// - 会社ごとに分けて回し、会社ごと・1回ごとに処理の記録（job_runs、種類 purge_locations）を残す
// - 1つの会社の失敗が、ほかの会社を止めない
// - 鍵や環境変数の値を、記録・エラー・戻り値に出さない

export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "error";
  return raw.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "***").slice(0, 200);
}

/** 位置を残す日数（実績の開始から。DB の関数と同じ） */
export const KEEP_DAYS = 90;

/** DB への口（service_role。supabase/migrations の purge_locations_* 関数） */
export interface PurgeStore {
  tenants(): Promise<string[]>;
  /** 同じ会社で動いている最中なら null */
  startRun(tenant: string): Promise<string | null>;
  /** その会社の分だけ。位置を空にした実績の数 */
  purge(tenant: string): Promise<number>;
  finishRun(tenant: string, run: string, status: "success" | "failure", counts: Record<string, number>, error: string | null): Promise<void>;
}

export interface PurgeSummary {
  tenants: number;
  skipped: number;
  failedTenants: number;
  purged: number;
}

export async function runPurgeLocations(store: PurgeStore): Promise<PurgeSummary> {
  const summary: PurgeSummary = { tenants: 0, skipped: 0, failedTenants: 0, purged: 0 };
  for (const tenant of await store.tenants()) {
    summary.tenants++;
    let run: string | null = null;
    try {
      run = await store.startRun(tenant);
      if (!run) {
        summary.skipped++;
        continue;
      }
      const n = await store.purge(tenant);
      await store.finishRun(tenant, run, "success", { purged: n }, null);
      summary.purged += n;
    } catch (e) {
      summary.failedTenants++;
      if (run) {
        try {
          await store.finishRun(tenant, run, "failure", {}, sanitizeError(e));
        } catch {
          // 記録そのものが書けないときは、次の会社へ進む（30 分で古い記録は閉じられる）
        }
      }
    }
  }
  return summary;
}
