// Edge Function：ファイルの期限つきの URL（機能 005、R-005-9〜12）。
// 呼んだ人のログインの鍵で files の行を読み（見える行は RLS が決める）、見えた行のパスを、まとめて1回で署名する。
//
// 呼び方：POST { "ids": ["<uuid>", …], "expires_in": 600 }（Authorization: Bearer <ログインの鍵>）
import { createSignDeps } from "../_shared/files_adapters.ts";
import { handleSignFileUrls, sanitizeError } from "../_shared/files.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  try {
    const r = await handleSignFileUrls(req.headers.get("Authorization"), input, createSignDeps(Deno.env.toObject()));
    return json(r.body, r.status);
  } catch (e) {
    return json({ error: sanitizeError(e) }, 500);
  }
});
