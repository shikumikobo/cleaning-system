// DB との口の問い合わせの形（R-015-3・16）。記録するだけの偽の Supabase クライアントで確かめる
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createNotificationsApi } from "./api";

interface Step {
  m: string;
  a: unknown[];
}

/** 呼ばれた形を記録し、最後に結果を返す（どのメソッドを何回つないでも受ける） */
function fake(result: { data?: unknown; error?: { message: string } | null; count?: number | null } = {}) {
  const calls: { table?: string; rpc?: string; steps: Step[] }[] = [];
  const make = (entry: { table?: string; rpc?: string; steps: Step[] }) => {
    calls.push(entry);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null });
        }
        return (...a: unknown[]) => {
          entry.steps.push({ m: String(prop), a });
          return proxy;
        };
      },
    });
    return proxy;
  };
  const db = {
    from: (table: string) => make({ table, steps: [] }),
    rpc: (rpc: string, args: unknown) => {
      const e = { rpc, steps: [{ m: "args", a: [args] }] };
      return make(e);
    },
  } as unknown as SupabaseClient;
  return { api: createNotificationsApi(db), calls };
}

const has = (steps: Step[], m: string, ...a: unknown[]) => steps.some((s) => s.m === m && JSON.stringify(s.a) === JSON.stringify(a));

describe("お知らせの問い合わせ", () => {
  it("R-015-16 一覧は、自分の一覧の行（app）だけを、新しい順に取る", async () => {
    const { api, calls } = fake({ data: [] });
    await api.listNotifications("mA", 20);
    const c = calls[0];
    expect(c.table).toBe("notifications");
    expect(has(c.steps, "eq", "channel", "app")).toBe(true);
    expect(has(c.steps, "eq", "membership_id", "mA")).toBe(true);
    expect(has(c.steps, "order", "created_at", { ascending: false })).toBe(true);
    expect(has(c.steps, "limit", 20)).toBe(true);
  });

  it("R-015-16 未読の件数は、自分の一覧の行のうち既読の時刻が空のものを数える", async () => {
    const { api, calls } = fake({ count: 3 });
    expect(await api.unreadCount("mA")).toBe(3);
    const c = calls[0];
    expect(has(c.steps, "select", "id", { count: "exact", head: true })).toBe(true);
    expect(has(c.steps, "is", "read_at", null)).toBe(true);
    expect(has(c.steps, "eq", "channel", "app")).toBe(true);
  });

  it("R-015-16 既読にするのは、既読の時刻（read_at）だけ。選んだ行と、すべて既読の両方", async () => {
    const { api, calls } = fake();
    await api.markRead(["n1", "n2"]);
    await api.markAllRead("mA");
    await api.markRead([]);
    expect(calls).toHaveLength(2); // 空の指定は何もしない
    const upd = calls[0].steps.find((s) => s.m === "update")?.a[0] as Record<string, unknown>;
    expect(Object.keys(upd)).toEqual(["read_at"]);
    expect(has(calls[0].steps, "in", "id", ["n1", "n2"])).toBe(true);
    expect(has(calls[1].steps, "eq", "membership_id", "mA")).toBe(true);
  });

  it("R-015-3 設定は、会社・所属・種類・手段で上書き保存する（同じ組は1つだけ）", async () => {
    const { api, calls } = fake();
    await api.saveSetting("tA", "mA", "work_changed", "push", false);
    const up = calls[0].steps.find((s) => s.m === "upsert");
    expect(up?.a[0]).toEqual({ tenant_id: "tA", membership_id: "mA", kind: "work_changed", channel: "push", enabled: false, deleted_at: null });
    expect(up?.a[1]).toEqual({ onConflict: "tenant_id,membership_id,kind,channel" });
  });

  it("R-015-5 端末の登録は、登録の関数（RPC）で行い、画面から直接書かない", async () => {
    const { api, calls } = fake();
    await api.registerPush("tA", { endpoint: "https://push.example.test/d", p256dh: "P", auth: "A", label: "Pixel" });
    expect(calls[0].rpc).toBe("register_push_subscription");
    expect(calls[0].steps[0].a[0]).toEqual({ p_tenant: "tA", p_endpoint: "https://push.example.test/d", p_p256dh: "P", p_auth: "A", p_label: "Pixel" });
  });

  it("R-015-7 端末を外すのは、外す印（deleted_at）だけを書く", async () => {
    const { api, calls } = fake();
    await api.removePush("https://push.example.test/d");
    const upd = calls[0].steps.find((s) => s.m === "update")?.a[0] as Record<string, unknown>;
    expect(Object.keys(upd)).toEqual(["deleted_at"]);
  });

  it("R-015-16 DB のエラーは、そのまま呼び元に投げる", async () => {
    const { api } = fake({ error: { message: "permission denied" } });
    await expect(api.listNotifications("mA")).rejects.toThrow("permission denied");
    await expect(api.unreadCount("mA")).rejects.toThrow("permission denied");
  });
});
