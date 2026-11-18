// 運営が会社を作る道具（R-001-1）。tools/create-tenant.mjs から呼ばれる。
// 呼んだ人が運営か（JWT の app_metadata.operator）を、サーバー側で確かめてから、service_role で create_tenant を呼ぶ。
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleCreateTenant } from "../_shared/handlers.ts";
import { loginLinkMailer } from "../_shared/mailer.ts";

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const siteUrl = Deno.env.get("SITE_URL") ?? "http://127.0.0.1:3000";
  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, flowType: "implicit" } });

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    /* 入力の検査で断る */
  }
  const r = await handleCreateTenant(req.headers.get("Authorization"), body, {
    isOperator: async (authHeader) => {
      const { data, error } = await service.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
      return !error && data.user?.app_metadata?.operator === "true";
    },
    serviceClient: service,
    mailer: loginLinkMailer(anon, siteUrl),
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
});
