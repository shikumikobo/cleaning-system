"use client";

// ログインの状態と、所属する会社（複数もありうる。R-001-17）、今選んでいる会社を持つ。
// 選んだ会社は、この端末に覚えておく（次に開いたとき同じ会社）。
// 「今の会社」はここの current だけ。取引先・建物・小口・お知らせの画面は、useSession 経由でここを読む。
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApi, type Api, type MyMembership } from "@/lib/api";
import { getClient } from "@/lib/supabase";

type Status = "loading" | "anon" | "ready" | "noconfig";

interface AuthValue {
  status: Status;
  userId: string | null;
  client: SupabaseClient | null;
  api: Api | null;
  memberships: MyMembership[];
  current: MyMembership | null;
  /** 今の会社での自分の権限の code。読み込み中は null（読めなかったら空） */
  perms: string[] | null;
  selectCurrent(membershipId: string): void;
  /** 所属を取り直す。selectId があれば、その所属を選ぶ（招待を受けた直後など） */
  refresh(selectId?: string): Promise<void>;
  signOut(): Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);
const KEY = "cleaning.currentMembership";

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthProvider の中で使う");
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => getClient(), []);
  const api = useMemo(() => (client ? createApi(client) : null), [client]);
  const [status, setStatus] = useState<Status>(client ? "loading" : "noconfig");
  const [userId, setUserId] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<MyMembership[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [permState, setPermState] = useState<{ role: string; perms: string[] } | null>(null);

  // ログインの状態（コールバックの中では Supabase を呼ばない）
  useEffect(() => {
    if (!client) return;
    let alive = true;
    void client.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setUserId(data.session?.user.id ?? null);
      if (!data.session) setStatus("anon");
    });
    const { data: sub } = client.auth.onAuthStateChange((_e, session) => {
      setUserId(session?.user.id ?? null);
      if (!session) {
        setMemberships([]);
        setCurrentId(null);
        setStatus("anon");
      }
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [client]);

  const load = useCallback(
    async (selectId?: string) => {
      if (!api || !userId) return;
      const list = await api.myMemberships(userId);
      setMemberships(list);
      setCurrentId((prev) => {
        const want = selectId ?? prev ?? remembered();
        return list.find((m) => m.id === want)?.id ?? list[0]?.id ?? null;
      });
      setStatus("ready");
    },
    [api, userId],
  );

  useEffect(() => {
    if (userId) void load().catch(() => setStatus("ready"));
  }, [userId, load]);

  const current = memberships.find((m) => m.id === currentId) ?? null;
  const roleCode = current?.roleCode ?? null;

  // 今の会社での権限（会社を切り替えたら、その役割の分を取り直す）
  useEffect(() => {
    if (!api || !roleCode) return;
    let alive = true;
    void api
      .permissionsOf(roleCode)
      .catch(() => [] as string[])
      .then((list) => {
        if (alive) setPermState({ role: roleCode, perms: list });
      });
    return () => {
      alive = false;
    };
  }, [api, roleCode]);
  const perms = roleCode && permState?.role === roleCode ? permState.perms : null;

  const value: AuthValue = {
    status,
    userId,
    client,
    api,
    memberships,
    current,
    perms,
    selectCurrent(id) {
      setCurrentId(id);
      try {
        localStorage.setItem(KEY, id);
      } catch {
        /* 覚えられなくても使える */
      }
    },
    refresh: (selectId) => load(selectId),
    async signOut() {
      await api?.signOut();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
