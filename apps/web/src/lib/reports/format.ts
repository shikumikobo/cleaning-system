// 画面の純粋な部品（機能 009）：状況の表記・固定の判定・進み具合・端末での下書きの組み立て・押せるボタン・文面。
import type {
  NewReportItemRow,
  ReportActionResult,
  ReportDraft,
  ReportStatus,
  TemplateDeleteResult,
  TemplateItemRow,
} from "./types";

const STATUS_LABEL: Record<ReportStatus, string> = { draft: "下書き", checked: "確認済み", submitted: "提出" };

/** 状況の表記（R-009-30） */
export function reportStatusLabel(s: string | null | undefined): string {
  if (!s) return "未作成";
  return STATUS_LABEL[s as ReportStatus] ?? s;
}

/** 確認・提出のあとは固定される。画面は直せない形にする（判定は DB。R-009-17・30） */
export function isLocked(status: string | null | undefined): boolean {
  return status === "checked" || status === "submitted";
}

/** 進み具合の表記：チェック済みの数 / 項目の数（R-009-30） */
export function progressLabel(items: Array<{ done: boolean }>): string {
  return `${items.filter((i) => i.done).length} / ${items.length}`;
}

export function sortReportItems<T extends { sort: number; name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ja"));
}

/** ひな形がない・使う項目が1つもないときに作る項目（写真の付け先になる。R-009-24） */
export const WHOLE_ITEM_NAME = "清掃全体";

export interface DraftInput {
  tenantId: string;
  /** 作業と、作業が写したひな形の ID（なければ null） */
  work: { id: string; report_template_id: string | null };
  /** ひな形の項目（使わないものも渡してよい。ここで外す） */
  templateItems: TemplateItemRow[];
  deviceId?: string | null;
  /** 端末で uuid を作る口（テストでは差し替える） */
  newId?: () => string;
  now?: () => string;
}

/** 端末で、ひな形から報告書の下書きを組み立てる（R-009-24）。使わない・消した項目は写さない。並びは並び順どおり */
export function buildReportDraft(i: DraftInput): ReportDraft {
  const newId = i.newId ?? (() => crypto.randomUUID());
  const at = (i.now ?? (() => new Date().toISOString()))();
  const reportId = newId();
  const usable = i.templateItems.filter((t) => t.active && !t.deleted_at);
  const base = {
    tenant_id: i.tenantId,
    report_id: reportId,
    done: false,
    note: "",
    client_created_at: at,
    device_id: i.deviceId ?? null,
  };
  let items: NewReportItemRow[];
  if (usable.length === 0) {
    items = [{ ...base, id: newId(), template_item_id: null, area_id: null, name: WHOLE_ITEM_NAME, sort: 1 }];
  } else {
    items = sortReportItems(usable).map((t) => ({ ...base, id: newId(), template_item_id: t.id, area_id: t.area_id, name: t.name, sort: t.sort }));
  }
  return {
    report: {
      id: reportId,
      tenant_id: i.tenantId,
      work_id: i.work.id,
      template_id: i.work.report_template_id,
      remarks: "",
      client_created_at: at,
      device_id: i.deviceId ?? null,
    },
    items,
  };
}

/** 押せるボタン（見せ方のためだけ。判定は DB。R-009-33） */
export function reviewActions(status: string, canAssign: boolean): { check: boolean; reopen: boolean; submit: boolean } {
  return { check: canAssign && status === "draft", reopen: canAssign && status === "checked", submit: canAssign && status === "checked" };
}

const ACTION_REASON: Record<string, string> = {
  submitted: "提出済みの報告書は、確認も差し戻しもできません",
  not_checked: "確認してからでないと、提出できません",
};

/** 確認・差し戻し・提出の戻りを、利用者に見せる日本語にする */
export function reportActionMessage(verb: "check" | "reopen" | "submit", r: ReportActionResult): string {
  if (!r.ok) return ACTION_REASON[r.reason ?? ""] ?? "この操作はできません";
  const done = { check: "確認済みにしました", reopen: "下書きに戻しました", submit: "提出しました" }[verb];
  return r.already ? "すでにその状況です" : done;
}

const REASON_TEXT: Record<string, (n: number) => string> = {
  used_by_works: (n) => `作業が ${n} 件で使っています`,
  used_by_contract_services: (n) => `契約の中身が ${n} 件で使っています`,
  used_by_reports: (n) => `報告書が ${n} 件で使っています`,
  used_by_report_items: (n) => `報告書の項目が ${n} 件に写されています`,
};

/** ひな形・項目を消す RPC の戻りを、利用者に見せる日本語にする（R-009-4・5） */
export function templateDeleteMessage(target: "template" | "item", r: TemplateDeleteResult): string {
  const name = target === "template" ? "ひな形" : "項目";
  const lines = (r.blockers ?? []).map((b) => (REASON_TEXT[b.reason] ?? ((n: number) => `${b.table} が ${n} 件で使っています`))(b.count));
  if (r.deactivated) return `${name}は使われているので、消さずに「使わない」にしました。${lines.join("。")}。`;
  return `${name}を消しました。`;
}

export const NAME_MAX = 100;

/** ひな形・項目の名前の検査（R-009-1・2。DB の check と同じ） */
export function validateName(name: string): string | null {
  const t = name.trim();
  if (t === "") return "名前を入れてください";
  if ([...name].length > NAME_MAX) return `名前は ${NAME_MAX} 字までにしてください`;
  return null;
}

/** 項目を1つ上・下に動かす：並び順を 1 から振り直し、変わるものだけ返す（R-009-35）。動かせなければ null */
export function swapSort<T extends { id: string; sort: number }>(items: T[], id: string, dir: -1 | 1): Array<{ id: string; sort: number }> | null {
  const list = [...items].sort((a, b) => a.sort - b.sort);
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((x, k) => ({ id: x.id, sort: k + 1 })).filter((x) => list.find((y) => y.id === x.id) && items.find((y) => y.id === x.id)!.sort !== x.sort);
}

/** 日付（YYYY-MM-DD）に日数を足す（日本時間の日付のまま計算する） */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** 一覧が出す作業の範囲：2週間前から明日まで（R-009-31） */
export function reportWorkRange(today: string): { from: string; to: string } {
  return { from: addDays(today, -14), to: addDays(today, 1) };
}

export interface ReportListRow {
  workId: string;
  reportId: string | null;
  status: string | null;
}

/** 状況で絞る：空はすべて、none は報告書がまだない作業（R-009-31） */
export function filterByReportStatus<T extends { status: string | null }>(rows: T[], filter: string): T[] {
  if (!filter) return rows;
  if (filter === "none") return rows.filter((r) => !r.status);
  return rows.filter((r) => r.status === filter);
}
