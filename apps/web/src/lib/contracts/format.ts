// 画面の部品：ラベル・頻度の日本語・時刻・一覧の絞り込み・RPC が断った理由の文面（R-010-26〜32）
import { rruleToJa } from "../quotes/rrule";
import type { Billing, Contract, ContractKind, ContractService, ContractStatus, ServiceKind, Work, WorkStatus } from "./types";

const STATUS: Record<ContractStatus, string> = { active: "有効", ended: "終了" };
const KIND: Record<ContractKind, string> = { recurring: "定期", one_time: "単発" };
const SERVICE_KIND: Record<ServiceKind, string> = { base: "基本", option: "オプション", special: "特別清掃" };
const BILLING: Record<Billing, string> = { monthly: "毎月", per_visit: "行った回ごと" };
const WORK_STATUS: Record<WorkStatus, string> = { scheduled: "予定", in_progress: "作業中", done: "完了", skipped: "行わず", cancelled: "取消" };

export const contractStatusLabel = (s: string) => STATUS[s as ContractStatus] ?? s;
export const contractKindLabel = (k: string) => KIND[k as ContractKind] ?? k;
export const serviceKindLabel = (k: string) => SERVICE_KIND[k as ServiceKind] ?? k;
export const billingLabel = (b: string) => BILLING[b as Billing] ?? b;
export const workStatusLabel = (s: string) => WORK_STATUS[s as WorkStatus] ?? s;

export const ONE_TIME_RULE = "FREQ=DAILY;COUNT=1";

/** 頻度の日本語。単発（COUNT=1）は「1回だけ」。読めない形は元の文字列 */
export function recurrenceLabel(rule: string): string {
  if (rule === ONE_TIME_RULE) return "1回だけ（単発）";
  return rruleToJa(rule);
}

/** 09:00:00 → 09:00。空なら空 */
export function timeLabel(t: string | null | undefined): string {
  return t ? t.slice(0, 5) : "";
}

export function timeRange(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  return `${timeLabel(start)}〜${timeLabel(end)}`;
}

/** 今の中身（閉じていないもの）を先に、そのあと閉じた古い行を開始日の新しい順に */
export function sortServices(list: ContractService[]): ContractService[] {
  return [...list].sort((a, b) => {
    const ac = a.valid_to === null ? 0 : 1;
    const bc = b.valid_to === null ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return b.valid_from.localeCompare(a.valid_from);
  });
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** 一覧の絞り込み：取引先・建物の名前の一部（空白で区切った語は、すべて含むもの）と状況 */
export function filterContracts(
  contracts: Contract[],
  names: { clients: Record<string, string>; buildings: Record<string, string> },
  f: { q: string; status: string },
): Contract[] {
  const tokens = norm(f.q).split(/\s+/).filter(Boolean);
  return contracts.filter((c) => {
    if (f.status && c.status !== f.status) return false;
    if (tokens.length === 0) return true;
    const hay = norm([names.clients[c.client_id] ?? "", names.buildings[c.building_id] ?? ""].join(" "));
    return tokens.every((t) => hay.includes(t));
  });
}

/** 予定の一覧：日付の順に、状況で絞る（取り消した予定は、指定がなければ出さない） */
export function filterWorks(works: Work[], f: { status: string; building: string }): Work[] {
  return works
    .filter((w) => (f.status ? w.status === f.status : w.status !== "cancelled"))
    .filter((w) => !f.building || w.building_id === f.building)
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || (a.start_time ?? "").localeCompare(b.start_time ?? ""));
}

/** 開始日・終了日の入力の検査。問題があれば理由を返す */
export function validateStart(start: string, end: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return "開始日を入れてください";
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return "終了日の形が正しくありません";
  if (end && end < start) return "終了日は開始日より後にしてください";
  return null;
}

/** 変更の入力を、RPC に渡す差分にする。変えていない項目は入れない */
export function buildChanges(
  current: Pick<ContractService, "name" | "amount" | "recurrence">,
  input: { name: string; amount: string; recurrence: string },
): { changes: Record<string, unknown>; error: string | null } {
  const changes: Record<string, unknown> = {};
  const name = input.name.trim();
  if (!name) return { changes, error: "名前を入れてください" };
  if (name !== current.name) changes.name = name;
  const amountText = input.amount.trim();
  if (!/^\d{1,11}$/.test(amountText)) return { changes, error: "金額は 0 以上の整数で入れてください" };
  if (Number(amountText) !== Number(current.amount)) changes.amount = Number(amountText);
  const rec = input.recurrence.trim();
  if (!/^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$/.test(rec)) return { changes, error: "頻度を選んでください" };
  if (rec !== current.recurrence) changes.recurrence = rec;
  return { changes, error: null };
}

const ACTION_TEXT: Record<string, string> = {
  not_approved: "承認された見積からだけ、契約を作れます",
  start_required: "開始日を入れてください",
  end_before_start: "終了日は開始日より後にしてください",
  no_lines: "見積に明細がないので、契約を作れません",
  contract_ended: "終了した契約の中身は、変えられません",
  not_current: "今の中身ではありません。画面を読み込み直してください",
  nothing_to_change: "変えるところがありません",
  no_change: "今と同じ内容です",
  effective_in_past: "適用日は今日以降にしてください",
  effective_not_after_start: "適用日は、今の中身の開始日より後にしてください",
  after_contract_end: "適用日が契約の終了日より後になっています",
  invalid_name: "名前を入れてください",
  invalid_amount: "金額は 0 以上の整数で入れてください",
  invalid_recurrence: "頻度の形が正しくありません",
  invalid_time: "終了の時刻は開始より後にしてください",
  invalid_value: "入力の形が正しくありません",
  invoiced: "請求書に載っている月があるので、できません（載っていない月からの変更にしてください）",
};

/** RPC が断った理由（reason）を、利用者に見せる日本語にする */
export function contractActionMessage(reason: string | undefined): string {
  if (!reason) return "できませんでした";
  return ACTION_TEXT[reason] ?? `できませんでした（${reason}）`;
}
