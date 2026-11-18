// Supabase を呼ぶ薄い層。権限と会社は RLS が決めるので、ここは「どの表・どの RPC をどう呼ぶか」だけを持つ。
// 状況の切り替え（提出・承認・不成立・直す）は RPC だけ。画面は status・番号・合計を直接書かない（R-004-6）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { percentToRate } from "./format";
import type { ActionResult, CompanyInfo, Item, Quote, QuoteLine } from "./types";

const nul = (v: string | undefined | null) => (v === undefined || v === null || v.trim() === "" ? null : v.trim());

function fail<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

// ---- 品名の候補 ----
export interface ItemInput {
  name: string;
  unit: string;
  unit_price: string;
  kind: string;
}
export async function listItems(sb: SupabaseClient, tenantId: string): Promise<Item[]> {
  return fail(await sb.from("items").select("*").eq("tenant_id", tenantId).is("deleted_at", null).order("name"));
}
export async function saveItem(sb: SupabaseClient, tenantId: string, id: string | null, i: ItemInput): Promise<Item> {
  const row = { name: i.name.trim(), unit: i.unit.trim(), unit_price: Number(i.unit_price.trim()), kind: i.kind };
  if (id) return fail(await sb.from("items").update(row).eq("id", id).select().single());
  return fail(await sb.from("items").insert({ tenant_id: tenantId, ...row }).select().single());
}
/** 消すのは論理削除。すでに見積の明細に写した品名と単価は変わらない */
export async function deleteItem(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("items").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}

// ---- 見積 ----
export interface QuoteHeaderInput {
  client_id: string;
  building_id: string;
  kind: string;
  tax_percent: string;
  valid_until: string;
  note: string;
}
const headerRow = (i: QuoteHeaderInput) => ({
  client_id: i.client_id,
  building_id: i.building_id,
  kind: i.kind,
  tax_rate: percentToRate(i.tax_percent),
  valid_until: nul(i.valid_until),
  note: nul(i.note),
});

export async function listQuotes(sb: SupabaseClient, tenantId: string): Promise<Quote[]> {
  return fail(await sb.from("quotes").select("*").eq("tenant_id", tenantId).is("deleted_at", null).order("created_at", { ascending: false }));
}
export async function getQuote(sb: SupabaseClient, tenantId: string, id: string): Promise<Quote | null> {
  return fail(await sb.from("quotes").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}
export async function createQuote(sb: SupabaseClient, tenantId: string, i: QuoteHeaderInput): Promise<Quote> {
  return fail(await sb.from("quotes").insert({ tenant_id: tenantId, ...headerRow(i) }).select().single());
}
export async function updateQuoteHeader(sb: SupabaseClient, id: string, i: QuoteHeaderInput): Promise<Quote> {
  return fail(await sb.from("quotes").update(headerRow(i)).eq("id", id).select().single());
}
/** 下書きだけ消せる（論理削除） */
export async function deleteQuote(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("quotes").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}

// ---- 明細 ----
export interface LineInput {
  item_id?: string | null;
  line_kind: string;
  name: string;
  qty: string;
  unit: string;
  unit_price: string;
  recurrence: string;
  sort?: number;
}
const lineRow = (i: LineInput) => ({
  item_id: i.item_id ?? null,
  line_kind: i.line_kind,
  name: i.name.trim(),
  qty: Number(i.qty.trim()),
  unit: i.unit.trim(),
  unit_price: Number(i.unit_price.trim()),
  recurrence: nul(i.recurrence),
});
export async function listLines(sb: SupabaseClient, quoteId: string): Promise<QuoteLine[]> {
  return fail(await sb.from("quote_lines").select("*").eq("quote_id", quoteId).is("deleted_at", null).order("sort").order("created_at"));
}
export async function saveLine(sb: SupabaseClient, tenantId: string, quoteId: string, id: string | null, i: LineInput): Promise<QuoteLine> {
  if (id) return fail(await sb.from("quote_lines").update(lineRow(i)).eq("id", id).select().single());
  return fail(await sb.from("quote_lines").insert({ tenant_id: tenantId, quote_id: quoteId, sort: i.sort ?? 0, ...lineRow(i) }).select().single());
}
export async function deleteLine(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("quote_lines").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}

// ---- 状況の切り替え（RPC） ----
async function rpc(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<ActionResult> {
  return fail(await sb.rpc(fn, args)) as ActionResult;
}
export const submitQuote = (sb: SupabaseClient, id: string) => rpc(sb, "submit_quote", { p_id: id });
export const approveQuote = (sb: SupabaseClient, id: string) => rpc(sb, "approve_quote", { p_id: id });
export const rejectQuote = (sb: SupabaseClient, id: string, note: string) => rpc(sb, "reject_quote", { p_id: id, p_note: nul(note) });
export const reviseQuote = (sb: SupabaseClient, id: string) => rpc(sb, "revise_quote", { p_id: id });

// ---- 見積書に載せる会社の情報 ----
export async function getCompany(sb: SupabaseClient, tenantId: string): Promise<CompanyInfo> {
  return fail(await sb.from("tenants").select("name, address, phone, invoice_reg_no").eq("id", tenantId).single());
}
