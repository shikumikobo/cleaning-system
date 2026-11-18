// Supabase のクライアント（画面側）。1つだけ作って、全部の画面で使い回す。
// 鍵は公開してよい anon の鍵だけ（service_role はここに置かない）。
// ログインはメールのリンク。リンクから戻ったとき、URL の中のログイン情報を拾う（implicit）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** 接続先の設定がなければ null */
export function getClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, {
    auth: { flowType: "implicit", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

/** 設定がなければ例外（画面の外の処理向け） */
export function getSupabase(): SupabaseClient {
  const c = getClient();
  if (!c) throw new Error("Supabase の接続先（NEXT_PUBLIC_SUPABASE_URL・NEXT_PUBLIC_SUPABASE_ANON_KEY）が設定されていません");
  return c;
}
