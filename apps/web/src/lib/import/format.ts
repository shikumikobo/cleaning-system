// 画面の文面：サーバーが返した理由（コード）を日本語にする。結果のまとめ・状況の言葉。R-014-17・19
import type { Kind } from "./columns";

const REASON: Record<string, string> = {
  duplicate: "同じものがすでに登録されています（重なり）",
  name_required: "名前がありません",
  invalid_kind: "種類が正しくありません",
  invalid_email: "メールアドレスの形が正しくありません",
  invalid_closing_day: "締め日は 1〜31 の整数にしてください",
  address_required: "住所がありません",
  client_not_found: "取引先が登録されていません",
  client_ambiguous: "同じ名前の取引先が複数あり、決まりません",
  owner_not_found: "所有者が登録されていません",
  owner_ambiguous: "同じ名前の所有者が複数あり、決まりません",
  building_not_found: "建物が登録されていません",
  building_ambiguous: "同じ名前の建物が複数あり、決まりません",
  room_no_required: "部屋番号がありません",
  invalid_floor: "階が整数ではありません",
  no_services: "清掃の中身がありません",
  start_required: "開始日がありません",
  end_before_start: "終了日が開始日より前です",
  invalid_service_kind: "清掃の種類が正しくありません",
  invalid_amount: "金額が正しくありません",
  invalid_billing: "請求の仕方が正しくありません",
  invalid_recurrence: "頻度が正しくありません",
  invalid_time: "時刻が正しくありません",
  invalid_value: "日付などの値が正しくありません",
  invalid: "取り込めない内容です",
  invalid_file_name: "ファイルの名前がありません",
  invalid_total: "行の数が正しくありません",
  invalid_rows: "取り込む行の形が正しくありません",
};

/** サーバーの理由（コード）を日本語に。画面が付けた日本語の文は、そのまま返す */
export function reasonMessage(code: string): string {
  return REASON[code] ?? code;
}

export const KIND_UNIT: Record<Kind, string> = { clients: "件", buildings: "件", rooms: "件", contracts: "契約" };

export function jobStatusLabel(s: string): string {
  return s === "done" ? "すべて取り込み" : s === "partial" ? "エラーの行あり" : s;
}

export interface ImportResult {
  ok: boolean;
  reason?: string;
  job_id?: string;
  status?: string;
  created?: number;
  skipped?: number;
  errors?: number;
  details?: Array<{ row: number; status: "error" | "duplicate"; messages: string[]; by: string }>;
}

/** RPC が断った理由（取り込み全体）を日本語に */
export function importFailureMessage(reason: string | undefined): string {
  return reason ? reasonMessage(reason) : "取り込めませんでした";
}

export function formatJobTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const j = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日 ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}
