// Supabase に送る側。insert は端末の ID で upsert（重複は無視）、RPC は端末の uuid を p_id で渡す。
// 二度送っても、DB では1件だけになる（R-001-31）。
import type { OutboxItem } from "./outbox";
import type { SendResult, Sender } from "./sync";

interface DbError {
  code?: string;
  message: string;
}

/** @supabase/supabase-js のクライアントのうち、使う部分だけ */
export interface SupabaseLike {
  from(table: string): {
    upsert(row: Record<string, unknown>, opts: { onConflict: string; ignoreDuplicates: boolean }): PromiseLike<{ error: DbError | null }>;
    insert(row: Record<string, unknown>): PromiseLike<{ error: DbError | null }>;
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: DbError | null }>;
}

function toResult(error: DbError | null): SendResult {
  if (!error) return { ok: true };
  if (error.code === "23505") return { ok: true, duplicate: true }; // もう届いている
  if (error.code === "PGRST301" || /jwt/i.test(error.message)) return { ok: false, kind: "auth", message: error.message, code: error.code };
  if (!error.code && /fetch|network|offline|load failed/i.test(error.message)) {
    return { ok: false, kind: "network", message: error.message };
  }
  return { ok: false, kind: "server", message: error.message, code: error.code };
}

export function createSupabaseSender(client: SupabaseLike): Sender {
  return {
    async send(item: OutboxItem): Promise<SendResult> {
      if (item.kind === "insert") {
        const row = { ...item.payload, id: item.id, tenant_id: item.tenantId };
        const { error } = await client.from(item.target).upsert(row, { onConflict: "id", ignoreDuplicates: true });
        return toResult(error);
      }
      const { error } = await client.rpc(item.target, { ...item.payload, p_id: item.id });
      return toResult(error);
    },
  };
}
