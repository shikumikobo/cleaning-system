// 小口の画面が使う、Supabase の読み書き。権限は DB（RLS・RPC）が守る。ここは見せるための取り出しだけ。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BalanceRow } from "./entry";
import type { CsvEntry } from "./csv";
import { receiptPath } from "./queue";

export interface CashSession {
  userId: string;
  tenantId: string;
  membershipId: string;
  perms: string[];
}

export interface AccountBalance extends BalanceRow {
  tenant_id: string;
  account_id: string;
  holder_id: string;
  name: string;
}

export interface EntryRow {
  id: string;
  account_id: string;
  holder_id: string;
  entry_date: string;
  direction: "in" | "out";
  amount: number;
  purpose: string;
  receipt_id: string | null;
  status: "draft" | "confirmed" | "closed";
  confirmed_at: string | null;
  building_id: string | null;
}

export interface ReceiptRow {
  id: string;
  status: "pending" | "read" | "failed" | "manual";
  read_amount: number | null;
  read_date: string | null;
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export async function loadBalances(c: SupabaseClient, tenantId: string): Promise<AccountBalance[]> {
  const { data, error } = await c.from("cash_account_balances").select("*").eq("tenant_id", tenantId).order("name");
  fail(error);
  return (data ?? []) as AccountBalance[];
}

export async function loadEntries(c: SupabaseClient, tenantId: string, opts: { month?: string; accountId?: string } = {}): Promise<EntryRow[]> {
  let q = c
    .from("cash_entries")
    .select("id, account_id, holder_id, entry_date, direction, amount, purpose, receipt_id, status, confirmed_at, building_id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (opts.accountId) q = q.eq("account_id", opts.accountId);
  if (opts.month) {
    const [y, m] = opts.month.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    q = q.gte("entry_date", `${opts.month}-01`).lt("entry_date", next);
  }
  const { data, error } = await q;
  fail(error);
  return (data ?? []) as EntryRow[];
}

export async function loadReceipts(c: SupabaseClient, ids: string[]): Promise<Map<string, ReceiptRow>> {
  const map = new Map<string, ReceiptRow>();
  if (!ids.length) return map;
  const { data, error } = await c.from("receipts").select("id, status, read_amount, read_date").in("id", ids);
  fail(error);
  for (const r of (data ?? []) as ReceiptRow[]) map.set(r.id, r);
  return map;
}

export async function loadHolderNames(c: SupabaseClient, tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await c.rpc("cash_holder_names", { p_tenant: tenantId });
  fail(error);
  return new Map(((data ?? []) as { membership_id: string; display_name: string }[]).map((r) => [r.membership_id, r.display_name]));
}

/** 下書きの金額を、読み取った値に直す（持ち手が画面で確かめたとき。R-006-25） */
export async function updateDraftAmount(c: SupabaseClient, id: string, amount: number): Promise<void> {
  const { error } = await c.from("cash_entries").update({ amount }).eq("id", id);
  fail(error);
}

/** 下書きを消す（論理削除。確認済みは DB が断る） */
export async function deleteDraft(c: SupabaseClient, id: string): Promise<void> {
  const { error } = await c.from("cash_entries").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  fail(error);
}

export async function confirmEntries(c: SupabaseClient, ids: string[]): Promise<number> {
  const { data, error } = await c.rpc("confirm_cash_entries", { p_ids: ids });
  fail(error);
  return Number(data ?? 0);
}

export async function closeMonth(c: SupabaseClient, tenantId: string, month: string, accountId: string | null): Promise<number> {
  const { data, error } = await c.rpc("close_cash_month", { p_tenant: tenantId, p_month: `${month}-01`, p_account: accountId });
  fail(error);
  return Number(data ?? 0);
}

/** 画像を置き場所に上げる（同じ場所に上げ直してよい） */
export async function uploadReceiptImage(c: SupabaseClient, path: string, bytes: ArrayBuffer, mime: string) {
  const { error } = await c.storage.from("tenant-files").upload(path, bytes, { contentType: mime, upsert: true });
  if (!error) return { ok: true as const };
  const msg = error.message ?? String(error);
  const kind = /fetch|network|failed|offline/i.test(msg) ? ("network" as const) : /jwt|auth|token/i.test(msg) ? ("auth" as const) : ("server" as const);
  return { ok: false as const, kind, message: msg };
}

/** 読み取りの Edge Function を呼ぶ */
export async function callReadReceipt(c: SupabaseClient, receiptId: string): Promise<void> {
  const { error } = await c.functions.invoke("read-receipt", { body: { receipt_id: receiptId } });
  if (error) throw new Error(error.message);
}

export function toCsvEntries(
  entries: EntryRow[],
  accounts: AccountBalance[],
  holderNames: Map<string, string>,
): CsvEntry[] {
  const acc = new Map(accounts.map((a) => [a.account_id, a]));
  return entries.map((e) => ({
    entry_date: e.entry_date,
    account_name: acc.get(e.account_id)?.name ?? "",
    holder_name: holderNames.get(e.holder_id) ?? "",
    direction: e.direction,
    amount: e.amount,
    purpose: e.purpose,
    has_receipt: e.receipt_id !== null,
    status: e.status,
    confirmed_at: e.confirmed_at,
    building_id: e.building_id,
  }));
}

export { receiptPath };
