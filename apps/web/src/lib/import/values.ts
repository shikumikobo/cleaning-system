// セルの値の読み解き（日付・時刻・金額・頻度・言葉の対応）。R-014-5・8
import { importKey } from "./normalize";

/** 2026-12-01・2026/1/5・2026年12月1日・Excel の日付の数（5桁）を yyyy-mm-dd にする。存在しない日は null */
export function parseDate(s: string): string | null {
  const t = s.normalize("NFKC").trim();
  let y: number, m: number, d: number;
  const a = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(t);
  if (a) {
    [y, m, d] = [Number(a[1]), Number(a[2]), Number(a[3])];
  } else if (/^\d{5}$/.test(t) && Number(t) >= 30000 && Number(t) <= 80000) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Number(t) * 86400000);
    [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 9:00・09:00:00・9時30分・0.375（Excel の時刻の数）を hh:mm にする。正しくなければ null */
export function parseTime(s: string): string | null {
  const t = s.normalize("NFKC").trim();
  let h: number, m: number;
  const a = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  const b = /^(\d{1,2})時(?:(\d{1,2})分?)?$/.exec(t);
  if (a) [h, m] = [Number(a[1]), Number(a[2])];
  else if (b) [h, m] = [Number(b[1]), Number(b[2] ?? 0)];
  else if (/^0?\.\d+$/.test(t)) {
    const min = Math.round(Number(t) * 1440);
    [h, m] = [Math.floor(min / 60), min % 60];
  } else return null;
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 30,000・¥30000・30000円 を整数にする。負・小数・大きすぎる値・数でないものは null */
export function parseAmount(s: string): number | null {
  const t = s.normalize("NFKC").replace(/[,¥￥円\s]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= 100_000_000_000 ? n : null;
}

/** 階：1・2階・3F を整数の文字にする。空は空。読めなければ null */
export function parseFloor(s: string): string | null {
  const t = s.normalize("NFKC").trim();
  if (t === "") return "";
  const m = /^(-?\d{1,4})\s*(?:階|f)?$/i.exec(t);
  return m ? String(Number(m[1])) : null;
}

/** 締め日：25・25日・31・月末 を 1〜31 の文字にする。空は空。読めなければ null */
export function parseClosingDay(s: string): string | null {
  const t = s.normalize("NFKC").trim();
  if (t === "") return "";
  if (t === "月末") return "31";
  const m = /^(\d{1,2})日?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? String(n) : null;
}

const DAYS: Record<string, string> = { 月: "MO", 火: "TU", 水: "WE", 木: "TH", 金: "FR", 土: "SA", 日: "SU" };
const RRULE_OK = /^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$/;
export const ONE_TIME = "FREQ=DAILY;COUNT=1";

/** 頻度：RRULE か日本語を RRULE にする。空・「単発」は単発（FREQ=DAILY;COUNT=1） */
export function parseRecurrence(s: string): { ok: true; rrule: string } | { ok: false } {
  const t = s.normalize("NFKC").replace(/\s+/g, "");
  if (t === "" || /^(単発|1回|1回だけ|一回|1回のみ)$/.test(t)) return { ok: true, rrule: ONE_TIME };
  if (/^(rrule:)?freq=/i.test(t)) {
    const r = t.replace(/^rrule:/i, "").toUpperCase();
    return RRULE_OK.test(r) ? { ok: true, rrule: r } : { ok: false };
  }
  const day = "([月火水木金土日])曜?日?";
  let m: RegExpExecArray | null;
  if (/^毎日$/.test(t)) return { ok: true, rrule: "FREQ=DAILY" };
  if ((m = new RegExp(`^毎週${day}$`).exec(t))) return { ok: true, rrule: `FREQ=WEEKLY;BYDAY=${DAYS[m[1]]}` };
  if ((m = new RegExp(`^隔週${day}$`).exec(t))) return { ok: true, rrule: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${DAYS[m[1]]}` };
  if ((m = new RegExp(`^毎月第([1-5])${day}$`).exec(t))) return { ok: true, rrule: `FREQ=MONTHLY;BYDAY=${m[1]}${DAYS[m[2]]}` };
  if ((m = new RegExp(`^毎月最終${day}$`).exec(t))) return { ok: true, rrule: `FREQ=MONTHLY;BYDAY=-1${DAYS[m[1]]}` };
  if (/^毎月末日?$/.test(t)) return { ok: true, rrule: "FREQ=MONTHLY;BYMONTHDAY=-1" };
  if ((m = /^毎月(\d{1,2})日$/.exec(t))) {
    const n = Number(m[1]);
    return n >= 1 && n <= 31 ? { ok: true, rrule: `FREQ=MONTHLY;BYMONTHDAY=${n}` } : { ok: false };
  }
  if ((m = /^(\d{1,2})[かヶケカヵ]月(?:に1回|ごと|おき|毎)?$/.exec(t))) {
    const n = Number(m[1]);
    return n >= 1 && n <= 24 ? { ok: true, rrule: `FREQ=MONTHLY;INTERVAL=${n}` } : { ok: false };
  }
  return { ok: false };
}

// ---- 言葉 → DB の値 ----
function lookup(map: Record<string, string>, s: string): string | null {
  const k = importKey(s);
  for (const [word, value] of Object.entries(map)) if (importKey(word) === k) return value;
  return null;
}
const CLIENT_KIND = { 管理会社: "management_company", management_company: "management_company", オーナー: "owner", owner: "owner" };
const CONTRACT_KIND = { 定期: "recurring", recurring: "recurring", 単発: "one_time", one_time: "one_time" };
const SERVICE_KIND = { 基本: "base", base: "base", オプション: "option", option: "option", 特別清掃: "special", 特別: "special", special: "special" };
const BILLING = { 毎月: "monthly", monthly: "monthly", 行った回ごと: "per_visit", 回ごと: "per_visit", 都度: "per_visit", per_visit: "per_visit" };
export const clientKindOf = (s: string) => lookup(CLIENT_KIND, s);
export const contractKindOf = (s: string) => lookup(CONTRACT_KIND, s);
export const serviceKindOf = (s: string) => lookup(SERVICE_KIND, s);
export const billingOf = (s: string) => lookup(BILLING, s);
