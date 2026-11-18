// Supabase のクライアントの代わり（呼び出しを記録し、決めた答えを返す）。API のテストで使う。
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Call {
  kind: "from" | "rpc" | "invoke" | "auth";
  name: string;
  chain?: Array<[string, unknown[]]>;
  args?: unknown;
}

type Answer = { data?: unknown; error?: unknown };

export function fakeClient(
  answers: {
    tables?: Record<string, Answer>;
    rpc?: Record<string, Answer>;
    invoke?: Record<string, Answer>;
    auth?: Answer;
  } = {},
) {
  const calls: Call[] = [];
  const builder = (table: string) => {
    const chain: Array<[string, unknown[]]> = [];
    calls.push({ kind: "from", name: table, chain });
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const a = answers.tables?.[table] ?? { data: [], error: null };
            return (res: (v: unknown) => void) => res({ data: a.data ?? [], error: a.error ?? null });
          }
          return (...args: unknown[]) => {
            chain.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const client = {
    from: builder,
    rpc(name: string, args: unknown) {
      calls.push({ kind: "rpc", name, args });
      const a = answers.rpc?.[name] ?? {};
      return Promise.resolve({ data: a.data ?? null, error: a.error ?? null });
    },
    functions: {
      invoke(name: string, opts: unknown) {
        calls.push({ kind: "invoke", name, args: opts });
        const a = answers.invoke?.[name] ?? { data: { ok: true } };
        return Promise.resolve({ data: a.data ?? null, error: a.error ?? null });
      },
    },
    auth: {
      signInWithOtp(args: unknown) {
        calls.push({ kind: "auth", name: "signInWithOtp", args });
        return Promise.resolve({ data: {}, error: answers.auth?.error ?? null });
      },
      signOut() {
        calls.push({ kind: "auth", name: "signOut" });
        return Promise.resolve({ error: null });
      },
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}
