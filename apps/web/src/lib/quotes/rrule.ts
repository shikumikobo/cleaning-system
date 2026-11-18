// 繰り返し（RRULE の文字列）の、日本語への訳と、画面で選んだ頻度からの作成（R-004-27・28）。
// 扱うのは、清掃で使う形（毎週◯曜・毎月第◯◯曜・毎月◯日・◯か月に1回・毎年・毎日）だけ。
// 読めない形は、元の文字列をそのまま見せる。DB に入れる文字列は FREQ=… から始まる（RRULE: は付けない）。

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DAY_JA: Record<Weekday, string> = { MO: "月曜", TU: "火曜", WE: "水曜", TH: "木曜", FR: "金曜", SA: "土曜", SU: "日曜" };
export const weekdayLabel = (d: Weekday) => DAY_JA[d];

export type Recurrence =
  | { type: "weekly"; weekdays: Weekday[]; interval: number }
  | { type: "monthly_nth"; nth: number; weekday: Weekday }
  | { type: "monthly_day"; day: number }
  | { type: "every_months"; months: number };

interface Parsed {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byday: Array<{ n: number | null; day: Weekday }>;
  bymonthday: number[];
  bymonth: number[];
}

const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

function parse(rule: string): Parsed | null {
  const body = rule.trim().replace(/^RRULE:/i, "");
  if (!body) return null;
  const out: Parsed = { freq: "DAILY", interval: 1, byday: [], bymonthday: [], bymonth: [] };
  let hasFreq = false;
  for (const part of body.split(";")) {
    const [k0, v] = part.split("=");
    const k = (k0 ?? "").toUpperCase();
    if (v === undefined || v === "") return null;
    if (k === "FREQ") {
      const f = v.toUpperCase();
      if (!FREQS.includes(f)) return null;
      out.freq = f as Parsed["freq"];
      hasFreq = true;
    } else if (k === "INTERVAL") {
      if (!/^\d+$/.test(v) || Number(v) < 1) return null;
      out.interval = Number(v);
    } else if (k === "BYDAY") {
      for (const d of v.toUpperCase().split(",")) {
        const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d);
        if (!m) return null;
        out.byday.push({ n: m[1] ? Number(m[1]) : null, day: m[2] as Weekday });
      }
    } else if (k === "BYMONTHDAY" || k === "BYMONTH") {
      const nums = v.split(",").map((x) => (/^-?\d+$/.test(x) ? Number(x) : NaN));
      if (nums.some((n) => Number.isNaN(n))) return null;
      if (k === "BYMONTHDAY") out.bymonthday = nums;
      else out.bymonth = nums;
    } else {
      return null; // 扱わない項目（BYSETPOS・COUNT・UNTIL など）
    }
  }
  return hasFreq ? out : null;
}

const nthLabel = (n: number) => (n === -1 ? "最終" : `第${n}`);

/** RRULE を日本語にする（例：毎月 第2火曜）。読めないときは元の文字列 */
export function rruleToJa(rule: string): string {
  const p = parse(rule);
  if (!p) return rule;
  const join = (head: string, detail: string) => (detail ? `${head} ${detail}` : head);
  switch (p.freq) {
    case "DAILY":
      return p.interval === 1 ? "毎日" : `${p.interval}日に1回`;
    case "WEEKLY": {
      const head = p.interval === 1 ? "毎週" : `${p.interval}週間に1回`;
      return join(head, p.byday.map((b) => DAY_JA[b.day]).join("・"));
    }
    case "MONTHLY": {
      const head = p.interval === 1 ? "毎月" : `${p.interval}か月に1回`;
      let detail = "";
      if (p.byday.length > 0) {
        if (p.byday.some((b) => b.n === null || b.n === 0)) return rule;
        const days = new Set(p.byday.map((b) => b.day));
        detail =
          days.size === 1
            ? `${p.byday.map((b) => nthLabel(b.n!)).join("・")}${DAY_JA[p.byday[0].day]}`
            : p.byday.map((b) => `${nthLabel(b.n!)}${DAY_JA[b.day]}`).join("・");
      } else if (p.bymonthday.length > 0) {
        detail = p.bymonthday.map((d) => (d === -1 ? "月末" : `${d}日`)).join("・");
      }
      return join(head, detail);
    }
    case "YEARLY": {
      const head = p.interval === 1 ? "毎年" : `${p.interval}年に1回`;
      const months = p.bymonth;
      const days = p.bymonthday;
      let detail = "";
      if (months.length > 0 && days.length === 1) detail = `${months.map((m) => `${m}月`).join("・")}${days[0]}日`;
      else if (months.length > 0) detail = months.map((m) => `${m}月`).join("・");
      else if (days.length > 0) return rule;
      return join(head, detail);
    }
  }
}

/** 画面で選んだ頻度から RRULE の文字列を作る */
export function buildRrule(r: Recurrence): string {
  switch (r.type) {
    case "weekly": {
      const days = WEEKDAYS.filter((d) => r.weekdays.includes(d));
      const iv = r.interval > 1 ? `;INTERVAL=${r.interval}` : "";
      return `FREQ=WEEKLY${iv}${days.length ? `;BYDAY=${days.join(",")}` : ""}`;
    }
    case "monthly_nth":
      return `FREQ=MONTHLY;BYDAY=${r.nth}${r.weekday}`;
    case "monthly_day":
      return `FREQ=MONTHLY;BYMONTHDAY=${r.day}`;
    case "every_months":
      return r.months > 1 ? `FREQ=MONTHLY;INTERVAL=${r.months}` : "FREQ=MONTHLY";
  }
}

/** 保存してある RRULE を、画面の選択に戻す。画面で選べない形は null */
export function parseRecurrence(rule: string): Recurrence | null {
  const p = parse(rule);
  if (!p) return null;
  if (p.freq === "WEEKLY" && p.bymonthday.length === 0 && p.bymonth.length === 0 && p.byday.every((b) => b.n === null)) {
    return { type: "weekly", weekdays: p.byday.map((b) => b.day), interval: p.interval };
  }
  if (p.freq === "MONTHLY" && p.interval === 1 && p.byday.length === 1 && p.byday[0].n !== null && p.bymonthday.length === 0) {
    return { type: "monthly_nth", nth: p.byday[0].n, weekday: p.byday[0].day };
  }
  if (p.freq === "MONTHLY" && p.interval === 1 && p.bymonthday.length === 1 && p.byday.length === 0) {
    return { type: "monthly_day", day: p.bymonthday[0] };
  }
  if (p.freq === "MONTHLY" && p.byday.length === 0 && p.bymonthday.length === 0) {
    return { type: "every_months", months: p.interval };
  }
  return null;
}
