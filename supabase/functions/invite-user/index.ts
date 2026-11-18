// 招待のメール（R-001-7）。管理者の画面から呼ばれる。
// 操作した人のログインの鍵（Authorization）で DB を呼ぶ。service_role は使わない。
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleInvite } from "../_shared/handlers.ts";
import { loginLinkMailer } from "../_shared/mailer.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const siteUrl = Deno.env.get("SITE_URL") ?? "http://127.0.0.1:3000";
  const anon = createClient(url, anonKey, { auth: { persistSession: false, flowType: "implicit" } });

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    /* 本文がなければ、入力の検査で断る */
  }
  const r = await handleInvite(req.headers.get("Authorization"), body, {
    userClient: (authHeader) =>
      createClient(url, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      }),
    mailer: loginLinkMailer(anon, siteUrl),
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
});
