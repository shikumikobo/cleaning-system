// 予定を作る定時の処理の判断（機能 010）。外への口（DB）は引数で受ける。Deno にも Node にも依存しない
// （単体のテストは Vitest で、偽の口と PGlite の口を渡して確かめる）。設計は specs/010-contracts/design.md の3〜4章。
//
// 守ること
// - 今日から 2 か月先までの予定を作る。契約の期間（開始日〜終了日）と、清掃の中身の期間（valid_from〜valid_to）の内側だけ
// - 会社ごとに分けて回し、会社ごと・1回ごとに処理の記録（job_runs、種類 schedule_works）を残す
// - 1つの会社の失敗が、ほかの会社を止めない。1つの中身の繰り返しが読めなくても、ほかの中身は作る（invalid に数える）
// - 二度動いても重ならない（DB の一意の索引と、作る関数が受け止める。ここは何度呼んでもよい形にする）
// - 鍵や環境変数の値を、記録・エラー・戻り値に出さない

// ===== RRULE の読み解き ============================================================================
// 扱うのは清掃で使う形：FREQ（DAILY・WEEKLY・MONTHLY・YEARLY）・INTERVAL・BYDAY（第N曜つき）・BYMONTHDAY（負の値つき）・
// BYMONTH・COUNT・UNTIL。BYSETPOS など、扱わない項目は「読めない」として断る（黙って違う予定を作らない）。

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
const WEEKDAY_INDEX: Record<Weekday, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

export interface ParsedRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byday: Array<{ n: number | null; day: number }>; // day は月曜が 0
  bymonthday: number[];
  bymonth: number[];
  count: number | null;
  until: string | null; // YYYY-MM-DD
}

export type ParseResult = { ok: true; rule: ParsedRule } | { ok: false; error: string };

export function parseRrule(text: string): ParseResult {
  const body = text.trim().replace(/^RRULE:/i, "");
  if (!body) return { ok: false, error: "空の繰り返し" };
  const rule: ParsedRule = { freq: "DAILY", interval: 1, byday: [], bymonthday: [], bymonth: [], count: null, until: null };
  let hasFreq = false;
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) return { ok: false, error: `読めない項目：${part}` };
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1);
    if (value === "") return { ok: false, error: `値がない：${key}` };
    switch (key) {
      case "FREQ": {
        const f = value.toUpperCase();
        if (f !== "DAILY" && f !== "WEEKLY" && f !== "MONTHLY" && f !== "YEARLY") return { ok: false, error: `扱わない頻度：${value}` };
        rule.freq = f;
        hasFreq = true;
        break;
      }
      case "INTERVAL":
        if (!/^\d{1,4}$/.test(value) || Number(value) < 1) return { ok: false, error: "INTERVAL は 1 以上の整数" };
        rule.interval = Number(value);
        break;
      case "COUNT":
        if (!/^\d{1,5}$/.test(value) || Number(value) < 1) return { ok: false, error: "COUNT は 1 以上の整数" };
        rule.count = Number(value);
        break;
      case "UNTIL": {
        const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(value);
        if (!m) return { ok: false, error: "UNTIL の形が読めない" };
        rule.until = `${m[1]}-${m[2]}-${m[3]}`;
        break;
      }
      case "BYDAY":
        for (const d of value.toUpperCase().split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d);
          if (!m) return { ok: false, error: `BYDAY が読めない：${d}` };
          const n = m[1] ? Number(m[1]) : null;
          if (n !== null && (n === 0 || n > 5 || n < -5)) return { ok: false, error: `BYDAY の番号が範囲外：${d}` };
          rule.byday.push({ n, day: WEEKDAY_INDEX[m[2] as Weekday] });
        }
        break;
      case "BYMONTHDAY":
      case "BYMONTH": {
        const nums = value.split(",").map((x) => (/^-?\d{1,2}$/.test(x) ? Number(x) : NaN));
        if (nums.some((n) => Number.isNaN(n))) return { ok: false, error: `${key} が読めない` };
        if (key === "BYMONTHDAY") {
          if (nums.some((n) => n === 0 || n > 31 || n < -31)) return { ok: false, error: "BYMONTHDAY が範囲外" };
          rule.bymonthday = nums;
        } else {
          if (nums.some((n) => n < 1 || n > 12)) return { ok: false, error: "BYMONTH が範囲外" };
          rule.bymonth = nums;
        }
        break;
      }
      case "WKST":
        if (value.toUpperCase() !== "MO") return { ok: false, error: "WKST は MO だけ" };
        break;
      default:
        return { ok: false, error: `扱わない項目：${key}` };
    }
  }
  if (!hasFreq) return { ok: false, error: "FREQ がない" };
  if (rule.byday.some((b) => b.n !== null) && (rule.freq === "WEEKLY" || rule.freq === "DAILY")) {
    return { ok: false, error: "第N曜は、毎月・毎年の繰り返しだけ" };
  }
  return { ok: true, rule };
}

// ---- 日付の計算（UTC の通し日。時差の影響を受けない）----
const DAY_MS = 86_400_000;
const toDayNum = (ymd: string): number => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const fromDayNum = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** 月曜を 0 とした曜日 */
const weekdayOf = (n: number): number => (((n + 3) % 7) + 7) % 7; // 1970-01-01 は木曜（3）

export const MAX_SPAN_DAYS = 3700; // 約10年。これを超える期間は展開しない（暴走の防止）

/** 日付が、DTSTART から数えた間隔（INTERVAL）と、BY○○の条件に合うか */
function matches(r: ParsedRule, n: number, n0: number): boolean {
  const date = new Date(n * DAY_MS);
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
  const start = new Date(n0 * DAY_MS);
  const y0 = start.getUTCFullYear(), m0 = start.getUTCMonth() + 1, d0 = start.getUTCDate();
  const dow = weekdayOf(n);
  const dim = daysInMonth(y, m);
  const monthDayOk = (): boolean => r.bymonthday.some((x) => (x > 0 ? x === d : dim + x + 1 === d));
  const bydayOk = (): boolean =>
    r.byday.some((b) => {
      if (b.day !== dow) return false;
      if (b.n === null) return true;
      if (b.n > 0) return Math.ceil(d / 7) === b.n;
      return Math.ceil((dim - d + 1) / 7) === -b.n;
    });

  switch (r.freq) {
    case "DAILY":
      if ((n - n0) % r.interval !== 0) return false;
      if (r.byday.length > 0 && !bydayOk()) return false;
      if (r.bymonthday.length > 0 && !monthDayOk()) return false;
      if (r.bymonth.length > 0 && !r.bymonth.includes(m)) return false;
      return true;
    case "WEEKLY": {
      const weeks = (n - weekdayOf(n) - (n0 - weekdayOf(n0))) / 7;
      if (weeks % r.interval !== 0) return false;
      if (r.bymonth.length > 0 && !r.bymonth.includes(m)) return false;
      return r.byday.length > 0 ? bydayOk() : dow === weekdayOf(n0);
    }
    case "MONTHLY": {
      const months = (y - y0) * 12 + (m - m0);
      if (months % r.interval !== 0) return false;
      if (r.bymonth.length > 0 && !r.bymonth.includes(m)) return false;
      if (r.bymonthday.length > 0 || r.byday.length > 0) {
        if (r.bymonthday.length > 0 && !monthDayOk()) return false;
        if (r.byday.length > 0 && !bydayOk()) return false;
        return true;
      }
      return d === d0; // その日のない月（31 日など）は飛ばす
    }
    case "YEARLY": {
      if ((y - y0) % r.interval !== 0) return false;
      const months = r.bymonth.length > 0 ? r.bymonth : [m0];
      if (!months.includes(m)) return false;
      if (r.bymonthday.length > 0 || r.byday.length > 0) {
        if (r.bymonthday.length > 0 && !monthDayOk()) return false;
        if (r.byday.length > 0 && !bydayOk()) return false;
        return true;
      }
      return d === d0;
    }
  }
}

/**
 * RRULE を、DTSTART（dtstart）から数えて、from〜to（どちらも含む。YYYY-MM-DD）の日付に展開する。
 * 読めない形は例外（messages に理由）。COUNT は DTSTART から数える（from より前の分も数に入る）。
 */
export function expandRrule(ruleText: string, dtstart: string, from: string, to: string): string[] {
  const parsed = parseRrule(ruleText);
  if (!parsed.ok) throw new Error(parsed.error);
  const r = parsed.rule;
  const n0 = toDayNum(dtstart);
  const nFrom = toDayNum(from);
  let nTo = toDayNum(to);
  if (r.until) nTo = Math.min(nTo, toDayNum(r.until));
  const begin = r.count !== null ? n0 : Math.max(n0, nFrom);
  if (nTo < begin) return [];
  if (nTo - begin > MAX_SPAN_DAYS) throw new Error("期間が長すぎる");
  const out: string[] = [];
  let seen = 0;
  for (let n = begin; n <= nTo; n++) {
    if (!matches(r, n, n0)) continue;
    seen++;
    if (r.count !== null && seen > r.count) break;
    if (n >= nFrom) out.push(fromDayNum(n));
  }
  return out;
}

// ===== 予定の作成 ==================================================================================

/** DB の schedule_services が返す、清掃の中身の1行 */
export interface ServiceRow {
  service_id: string;
  service_key: string;
  contract_id: string;
  name: string;
  recurrence: string;
  valid_from: string;
  valid_to: string | null;
  contract_start: string;
  contract_end: string | null;
  staff: string[];
}

/** 鍵のような長い文字列を伏せる（015 の sanitizeError と同じ。Deno の import の拡張子を避けるため、ここに置く） */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "error";
  return raw.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "***").slice(0, 200);
}

/** 日本時間の今日（YYYY-MM-DD） */
export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 月を足す。その日のない月は、月末に寄せる（12/31 の 2 か月後は 2/28） */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(d, daysInMonth(ny, nm))).padStart(2, "0")}`;
}

/** 今日から先に作る期間の長さ（月） */
export const HORIZON_MONTHS = 2;

const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);

/** 1つの中身について、from〜to の間に作る日付。中身の期間と契約の期間の内側だけ。起点は valid_from */
export function datesForService(s: ServiceRow, from: string, to: string): string[] {
  const lo = maxDate(maxDate(from, s.valid_from), s.contract_start);
  const hi = minDate(minDate(to, s.valid_to), s.contract_end)!;
  if (hi < lo) return [];
  return expandRrule(s.recurrence, s.valid_from, lo, hi);
}

/** DB への口（service_role。supabase/migrations の schedule_* 関数） */
export interface ScheduleStore {
  tenants(): Promise<string[]>;
  /** 同じ会社で動いている最中なら null */
  startRun(tenant: string): Promise<string | null>;
  services(tenant: string, from: string, to: string, contract: string | null): Promise<ServiceRow[]>;
  insert(tenant: string, run: string, works: Array<{ service_id: string; date: string }>): Promise<{ created: number; skipped: number; assignments: number; charges: number }>;
  finishRun(tenant: string, run: string, status: "success" | "failure", counts: Record<string, number>, error: string | null): Promise<void>;
}

export interface ScheduleOptions {
  /** 日本時間の今日（YYYY-MM-DD）。省くと今 */
  today?: string;
  /** 何か月先まで作るか（既定 2） */
  months?: number;
  /** 1つの会社だけ回す（画面から「いま作り直す」を呼んだとき） */
  tenant?: string;
  /** 1つの契約だけに絞る */
  contract?: string;
}

export interface ScheduleSummary {
  tenants: number;
  skipped: number;
  failedTenants: number;
  services: number;
  invalid: number;
  created: number;
  existing: number;
  assignments: number;
  charges: number;
}

const CHUNK = 500;

export async function runSchedule(store: ScheduleStore, opts: ScheduleOptions = {}): Promise<ScheduleSummary> {
  const today = opts.today ?? todayJst();
  const to = addMonths(today, opts.months ?? HORIZON_MONTHS);
  const summary: ScheduleSummary = { tenants: 0, skipped: 0, failedTenants: 0, services: 0, invalid: 0, created: 0, existing: 0, assignments: 0, charges: 0 };
  const tenants = opts.tenant ? [opts.tenant] : await store.tenants();
  for (const tenant of tenants) {
    summary.tenants++;
    let run: string | null = null;
    try {
      run = await store.startRun(tenant);
      if (!run) {
        summary.skipped++;
        continue;
      }
      const counts = { services: 0, invalid: 0, created: 0, existing: 0, assignments: 0, charges: 0 };
      const works: Array<{ service_id: string; date: string }> = [];
      for (const s of await store.services(tenant, today, to, opts.contract ?? null)) {
        counts.services++;
        try {
          for (const date of datesForService(s, today, to)) works.push({ service_id: s.service_id, date });
        } catch {
          counts.invalid++; // この中身の繰り返しは読めない。ほかの中身は作る
        }
      }
      for (let i = 0; i < works.length; i += CHUNK) {
        const r = await store.insert(tenant, run, works.slice(i, i + CHUNK));
        counts.created += r.created;
        counts.existing += r.skipped;
        counts.assignments += r.assignments;
        counts.charges += r.charges;
      }
      await store.finishRun(tenant, run, "success", counts, null);
      summary.services += counts.services;
      summary.invalid += counts.invalid;
      summary.created += counts.created;
      summary.existing += counts.existing;
      summary.assignments += counts.assignments;
      summary.charges += counts.charges;
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
