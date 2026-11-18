// Supabase を呼ぶ薄い層。権限と会社は RLS と RPC が決める。
// 請求書の作成・状況・番号・合計・入金は RPC だけ。画面から直接書くのは、下書きの期日・税率・備考と、下書きの明細の品名・数量・単位・外すことだけ（R-011-11）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { percentToRate } from "../quotes/format";
import type { ActionResult, Balance, CompanyInfo, DraftResult, Invoice, InvoiceLine, Payment } from "./types";

const nul = (v: string | undefined | null) => (v === undefined || v === null || v.trim() === "" ? null : v.trim());

function fail<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

// ---- 読む ----
export async function listInvoices(sb: SupabaseClient, tenantId: string): Promise<Invoice[]> {
  return fail(await sb.from("invoices").select("*").eq("tenant_id", tenantId).is("deleted_at", null).order("period", { ascending: false }).order("created_at", { ascending: false }));
}
export async function getInvoice(sb: SupabaseClient, tenantId: string, id: string): Promise<Invoice | null> {
  return fail(await sb.from("invoices").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}
export async function listBalances(sb: SupabaseClient, tenantId: string): Promise<Balance[]> {
  return fail(await sb.from("invoice_balances").select("*").eq("tenant_id", tenantId));
}
export async function listLines(sb: SupabaseClient, invoiceId: string): Promise<InvoiceLine[]> {
  return fail(await sb.from("invoice_lines").select("*").eq("invoice_id", invoiceId).is("deleted_at", null).order("sort").order("created_at"));
}
/** 複数の請求書の明細（CSV 用）。URL が長くならないよう、50 件ずつ取る */
export async function listLinesOf(sb: SupabaseClient, invoiceIds: string[]): Promise<InvoiceLine[]> {
  const out: InvoiceLine[] = [];
  for (let i = 0; i < invoiceIds.length; i += 50) {
    const part = invoiceIds.slice(i, i + 50);
    out.push(...fail(await sb.from("invoice_lines").select("*").in("invoice_id", part).is("deleted_at", null).order("sort")));
  }
  return out;
}
export async function listPayments(sb: SupabaseClient, invoiceId: string): Promise<Payment[]> {
  return fail(await sb.from("payments").select("*").eq("invoice_id", invoiceId).is("deleted_at", null).order("paid_on"));
}
export async function getCompany(sb: SupabaseClient, tenantId: string): Promise<CompanyInfo> {
  return fail(await sb.from("tenants").select("name, address, phone, invoice_reg_no").eq("id", tenantId).single());
}

// ---- 下書きの編集（画面から直接。下書きの間だけ） ----
export interface DraftHeaderInput {
  tax_percent: string;
  due_date: string;
  note: string;
}
export async function updateDraftHeader(sb: SupabaseClient, id: string, i: DraftHeaderInput): Promise<Invoice> {
  return fail(await sb.from("invoices").update({ tax_rate: percentToRate(i.tax_percent), due_date: nul(i.due_date), note: nul(i.note) }).eq("id", id).select().single());
}
export interface LineEditInput {
  name: string;
  qty: string;
  unit: string;
}
export async function updateLine(sb: SupabaseClient, id: string, i: LineEditInput): Promise<InvoiceLine> {
  return fail(await sb.from("invoice_lines").update({ name: i.name.trim(), qty: Number(i.qty.trim()), unit: i.unit.trim() }).eq("id", id).select().single());
}
/** 明細を外す（論理削除）。元は、次の下書きに入れ直せる */
export async function removeLine(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("invoice_lines").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}

// ---- RPC ----
async function rpc<T extends { ok: boolean }>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  return fail(await sb.rpc(fn, args)) as T;
}
export const createInvoiceDrafts = (sb: SupabaseClient, tenantId: string, period: string, clientId: string | null) =>
  rpc<DraftResult>(sb, "create_invoice_drafts", { p_tenant: tenantId, p_period: period, p_client_id: clientId });
export const issueInvoice = (sb: SupabaseClient, id: string, issueDate: string | null) =>
  rpc<ActionResult>(sb, "issue_invoice", { p_id: id, p_issue_date: nul(issueDate) });
export const markInvoiceSent = (sb: SupabaseClient, id: string) => rpc<ActionResult>(sb, "mark_invoice_sent", { p_id: id });
export const cancelInvoice = (sb: SupabaseClient, id: string, reason: string) => rpc<ActionResult>(sb, "cancel_invoice", { p_id: id, p_reason: nul(reason) });
export const deleteInvoice = (sb: SupabaseClient, id: string) => rpc<ActionResult>(sb, "delete_invoice", { p_id: id });
export interface PaymentInput {
  paid_on: string;
  amount: string;
  note: string;
}
export const recordPayment = (sb: SupabaseClient, invoiceId: string, i: PaymentInput) =>
  rpc<ActionResult>(sb, "record_payment", { p_invoice_id: invoiceId, p_paid_on: i.paid_on.trim(), p_amount: Number(i.amount.trim()), p_note: nul(i.note) });
export const updatePayment = (sb: SupabaseClient, id: string, i: PaymentInput) =>
  rpc<ActionResult>(sb, "update_payment", { p_id: id, p_paid_on: i.paid_on.trim(), p_amount: Number(i.amount.trim()), p_note: nul(i.note) });
export const deletePayment = (sb: SupabaseClient, id: string) => rpc<ActionResult>(sb, "delete_payment", { p_id: id });
