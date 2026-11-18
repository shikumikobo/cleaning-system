// 予定表の組み立て（R-012-30）：期間・前後への移動・スタッフごと／建物ごとのまとめ・重なりの印
import { sortWorks } from "./format";
import type { AssignmentRow, OverlapRow, WorkRow } from "./types";

export type CalendarMode = "day" | "week" | "month";
export type GroupBy = "staff" | "building";

const D = 24 * 3600 * 1000;
const parse = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, dd);
};
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => fmt(parse(d) + n * D);

/** その日を含む週の月曜日 */
export function weekStart(d: string): string {
  const wd = new Date(parse(d)).getUTCDay(); // 0=日
  return addDays(d, -((wd + 6) % 7));
}

/** その月の1日と末日 */
export function monthRange(d: string): { from: string; to: string } {
  const [y, m] = d.split("-").map(Number);
  return { from: fmt(Date.UTC(y, m - 1, 1)), to: fmt(Date.UTC(y, m, 0)) };
}

/** 表示する期間（両端を含む） */
export function rangeFor(mode: CalendarMode, anchor: string): { from: string; to: string } {
  if (mode === "day") return { from: anchor, to: anchor };
  if (mode === "week") {
    const from = weekStart(anchor);
    return { from, to: addDays(from, 6) };
  }
  return monthRange(anchor);
}

/** 前（-1）・次（+1）へ動かした基準日 */
export function shiftAnchor(mode: CalendarMode, anchor: string, dir: -1 | 1): string {
  if (mode === "day") return addDays(anchor, dir);
  if (mode === "week") return addDays(anchor, 7 * dir);
  const [y, m, d] = anchor.split("-").map(Number);
  const first = Date.UTC(y, m - 1 + dir, 1);
  const last = new Date(Date.UTC(y, m + dir, 0)).getUTCDate();
  return fmt(first + (Math.min(d, last) - 1) * D);
}

/** 期間の見出し：2026年11月17日 ／ 2026年11月16日〜11月22日 ／ 2026年11月 */
export function rangeTitle(mode: CalendarMode, anchor: string): string {
  const { from, to } = rangeFor(mode, anchor);
  const j = (d: string) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
  if (mode === "day") return j(from);
  if (mode === "week") return `${j(from)}〜${Number(to.slice(5, 7))}月${Number(to.slice(8, 10))}日`;
  return `${Number(from.slice(0, 4))}年${Number(from.slice(5, 7))}月`;
}

/** 期間の日付の並び */
export function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = parse(from); t <= parse(to); t += D) out.push(fmt(t));
  return out;
}

export interface ScheduleGroup {
  key: string;
  label: string;
  works: WorkRow[];
}

export const UNASSIGNED = "unassigned";

/**
 * スタッフごと・建物ごとにまとめる。取消は出さない。
 * スタッフごと：担当が2人の作業は、2人の下にそれぞれ出る。担当のない作業は「担当なし」にまとまる。
 */
export function groupSchedule(
  works: WorkRow[],
  assignments: AssignmentRow[],
  by: GroupBy,
  names: { staff: Record<string, string>; buildings: Record<string, string> },
): ScheduleGroup[] {
  const live = works.filter((w) => w.status !== "cancelled" && !w.deleted_at);
  const groups = new Map<string, ScheduleGroup>();
  const add = (key: string, label: string, w: WorkRow) => {
    const g = groups.get(key) ?? { key, label, works: [] };
    g.works.push(w);
    groups.set(key, g);
  };
  for (const w of live) {
    if (by === "building") {
      add(w.building_id, names.buildings[w.building_id] ?? "（不明な建物）", w);
      continue;
    }
    const mine = assignments.filter((a) => a.work_id === w.id && !a.deleted_at);
    if (mine.length === 0) add(UNASSIGNED, "担当なし", w);
    for (const a of mine) add(a.membership_id, names.staff[a.membership_id] ?? "（不明な人）", w);
  }
  const list = [...groups.values()].map((g) => ({ ...g, works: sortWorks(g.works) }));
  // 担当なしは最後。ほかは名前の順
  return list.sort((a, b) => (a.key === UNASSIGNED ? 1 : b.key === UNASSIGNED ? -1 : a.label.localeCompare(b.label, "ja")));
}

/** 重なりのある作業の id → 重なる相手の id */
export function overlapMap(overlaps: OverlapRow[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const o of overlaps) {
    const s = m.get(o.work_id) ?? new Set<string>();
    s.add(o.other_work_id);
    m.set(o.work_id, s);
  }
  return m;
}

/** 重なりの警告文：「同じ人の時刻が重なっています（○○）」。なければ空 */
export function overlapText(workId: string, map: Map<string, Set<string>>, works: WorkRow[]): string {
  const others = map.get(workId);
  if (!others || others.size === 0) return "";
  const titles = [...others].map((id) => works.find((w) => w.id === id)?.title ?? "別の作業");
  return `同じ人の時刻が重なっています（${titles.join("、")}）`;
}
