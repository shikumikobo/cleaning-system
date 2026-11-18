// 期限の近い案件のお知らせを作る定時の処理の判断（機能 003）。外への口（DB）は引数で受ける。
// Deno にも Node にも依存しない（単体のテストは Vitest で、偽の口を渡して確かめる）。
// 設計は specs/003-requests/design.md の4章。判断の本体（誰に・いつ作るか）は DB の関数 request_due_notify にある。
//
// 守ること
// - 会社ごとに分けて回し、会社ごと・1回ごとに処理の記録（job_runs、種類 request_due）を残す（R-003-26）
// - 1つの会社の失敗が、ほかの会社を止めない
// - 鍵や環境変数の値を、記録・エラー・戻り値に出さない

/** 鍵のような長い文字列を伏せる（015 の sanitizeError と同じ。Deno の import の拡張子を避けるため、ここに置く） */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "error";
  return raw.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "***").slice(0, 200);
}

/** DB への口（service_role。supabase/migrations の request_due_* 関数） */
export interface RequestDueStore {
  tenants(): Promise<string[]>;
  /** 同じ会社で動いている最中なら null */
  startRun(tenant: string): Promise<string | null>;
  notify(tenant: string, run: string, days: number): Promise<{ requests: number; notified: number }>;
  finishRun(tenant: string, run: string, status: "success" | "failure", counts: Record<string, number>, error: string | null): Promise<void>;
}

export interface RequestDueSummary {
  tenants: number;
  skipped: number;
  failedTenants: number;
  requests: number;
  notified: number;
}

/** 期限が近いとみなす日数（既定 3。画面の部品 DUE_SOON_DAYS と同じ） */
export const DEFAULT_DAYS = 3;

export async function runRequestDue(store: RequestDueStore, days: number = DEFAULT_DAYS): Promise<RequestDueSummary> {
  const summary: RequestDueSummary = { tenants: 0, skipped: 0, failedTenants: 0, requests: 0, notified: 0 };
  for (const tenant of await store.tenants()) {
    summary.tenants++;
    let run: string | null = null;
    try {
      run = await store.startRun(tenant);
      if (!run) {
        summary.skipped++;
        continue;
      }
      const r = await store.notify(tenant, run, days);
      await store.finishRun(tenant, run, "success", { requests: r.requests, notified: r.notified }, null);
      summary.requests += r.requests;
      summary.notified += r.notified;
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
