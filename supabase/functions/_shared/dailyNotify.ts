// 毎日の定時のお知らせを作る処理の判断（機能 015、波 6）。外への口（DB）は引数で受ける。
// Deno にも Node にも依存しない（単体のテストは Vitest で、偽の口を渡して確かめる）。
// 誰に・いつ作るかの本体は DB の関数（work_tomorrow_notify・report_missing_notify・invoice_overdue_notify）にある。
// 設計は specs/015-notifications/design.md の8章。
//
// 守ること
// - 会社ごと・処理ごとに処理の記録（job_runs、種類 notify_<処理>）を残す（R-015-39）
// - 1つの会社・1つの処理の失敗が、ほかの会社・ほかの処理を止めない（R-015-40）
// - 鍵や環境変数の値を、記録・エラー・戻り値に出さない

/** 鍵のような長い文字列を伏せる（015 の sanitizeError と同じ。Deno の import の拡張子を避けるため、ここに置く） */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "error";
  return raw.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "***").slice(0, 200);
}

export const DAILY_TASKS = ["work_tomorrow", "report_missing", "invoice_overdue"] as const;
export type DailyTask = (typeof DAILY_TASKS)[number];

/** 出ていない報告書を見る日数（作業の日が今日より前、この日数前まで） */
export const REPORT_MISSING_DAYS = 14;

export type Counts = Record<string, number>;

/** DB への口（service_role。supabase/migrations の daily_notify_* と、処理ごとの *_notify 関数） */
export interface DailyNotifyStore {
  tenants(): Promise<string[]>;
  /** 同じ会社・同じ処理が動いている最中なら null */
  startRun(tenant: string, task: DailyTask): Promise<string | null>;
  /** お知らせを作る。戻りは件数（作業・請求書の数と、お知らせを作った人の数） */
  notify(tenant: string, task: DailyTask, run: string, opts: { days: number }): Promise<Counts>;
  finishRun(tenant: string, run: string, task: DailyTask, status: "success" | "failure", counts: Counts, error: string | null): Promise<void>;
}

export interface DailyNotifySummary {
  tenants: number;
  /** 動いている最中のため見送った（会社×処理）の数 */
  skipped: number;
  /** 失敗した（会社×処理）の数 */
  failed: number;
  /** 処理ごとの、お知らせを作った人の数の合計 */
  notified: Record<DailyTask, number>;
}

export async function runDailyNotify(
  store: DailyNotifyStore,
  opts: { tasks?: readonly DailyTask[]; reportDays?: number } = {},
): Promise<DailyNotifySummary> {
  const tasks = opts.tasks ?? DAILY_TASKS;
  const days = opts.reportDays ?? REPORT_MISSING_DAYS;
  const summary: DailyNotifySummary = {
    tenants: 0,
    skipped: 0,
    failed: 0,
    notified: { work_tomorrow: 0, report_missing: 0, invoice_overdue: 0 },
  };
  for (const tenant of await store.tenants()) {
    summary.tenants++;
    for (const task of tasks) {
      let run: string | null = null;
      try {
        run = await store.startRun(tenant, task);
        if (!run) {
          summary.skipped++;
          continue;
        }
        const counts = await store.notify(tenant, task, run, { days });
        await store.finishRun(tenant, run, task, "success", counts, null);
        summary.notified[task] += counts.notified ?? 0;
      } catch (e) {
        summary.failed++;
        if (run) {
          try {
            await store.finishRun(tenant, run, task, "failure", {}, sanitizeError(e));
          } catch {
            // 記録そのものが書けないときは、次へ進む（30 分で古い記録は閉じられる）
          }
        }
      }
    }
  }
  return summary;
}
