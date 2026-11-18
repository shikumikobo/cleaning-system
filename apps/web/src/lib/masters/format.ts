// 画面の部品：ラベル・検索・候補・並び・消せなかったときの文面（R-002-12・21・23・24）
import type { DeleteResult, DeleteTarget } from "./types";

export function kindLabel(kind: string): string {
  return kind === "management_company" ? "管理会社" : kind === "owner" ? "オーナー" : kind;
}

/** 31 は月末 */
export function closingDayLabel(day: number | null | undefined): string {
  if (day === null || day === undefined) return "";
  return day === 31 ? "月末" : `${day}日`;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** 名前の部分一致。空白で区切った語は、すべて含むものだけ（全角半角・大文字小文字は同じに扱う） */
export function filterByName<T extends { name: string }>(items: T[], query: string): T[] {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return items;
  return items.filter((it) => {
    const n = norm(it.name);
    return tokens.every((t) => n.includes(t));
  });
}

/** 新しく選ぶ候補：「使わない」は出さない（R-002-12）。一覧には使わない行も出すので、こちらは候補の選択肢だけに使う */
export function selectableCandidates<T extends { active: boolean }>(items: T[]): T[] {
  return items.filter((it) => it.active);
}

export function sortRooms<T extends { room_no: string; floor: number | null }>(rooms: T[]): T[] {
  return [...rooms].sort((a, b) => {
    const fa = a.floor ?? Number.POSITIVE_INFINITY;
    const fb = b.floor ?? Number.POSITIVE_INFINITY;
    if (fa !== fb) return fa - fb;
    return a.room_no.localeCompare(b.room_no, "ja", { numeric: true });
  });
}

export function sortAreas<T extends { name: string; sort: number }>(areas: T[]): T[] {
  return [...areas].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ja"));
}

const REASON_TEXT: Record<string, (n: number) => string> = {
  has_buildings: (n) => `この取引先を依頼元・所有者とする建物が ${n} 件あります`,
  has_contracts: (n) => `契約が ${n} 件あります`,
  has_invoices: (n) => `請求書が ${n} 件あります`,
  has_quotes: (n) => `見積が ${n} 件あります`,
  has_active_contracts: (n) => `有効な契約が ${n} 件あります`,
  has_future_works: (n) => `先の予定の作業が ${n} 件あります`,
  has_open_requests: (n) => `終わっていない案件が ${n} 件あります`,
  has_costs: (n) => `費用が ${n} 件入っています`,
  used_by_requests: (n) => `案件が ${n} 件で使っています`,
  used_by_photos: (n) => `写真が ${n} 件で使っています`,
  used_by_template_items: (n) => `報告のひな形の項目が ${n} 件で使っています`,
};

const TARGET_NAME: Record<DeleteTarget, string> = { client: "取引先", building: "建物", room: "部屋", area: "場所" };

/** 消す RPC の戻りを、利用者に見せる日本語にする（R-002-24） */
export function deleteMessage(target: DeleteTarget, r: DeleteResult): string {
  const name = TARGET_NAME[target];
  const lines = (r.blockers ?? []).map((b) => (REASON_TEXT[b.reason] ?? ((n: number) => `${b.table} が ${n} 件で使っています`))(b.count));
  if (!r.ok) {
    return `${name}は消せません。${lines.join("。")}。`;
  }
  if (r.deactivated) {
    return `${name}は使われているので、消さずに「使わない」にしました。${lines.join("。")}。`;
  }
  return `${name}を消しました。`;
}
