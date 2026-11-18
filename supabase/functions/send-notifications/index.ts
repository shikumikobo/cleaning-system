// お知らせを送る Edge Function（機能 015）。定時（1 分ごと）に呼ばれ、会社ごとに通知・メールを送る。
// 呼べるのは service_role のキーを持つ呼び出しだけ。会社をまたぐ処理なので、判断は _shared/notifications.ts。
//   POST {"task": "send"}   送る前のお知らせを送る（既定）
//   POST {"task": "purge"}  180 日を過ぎたお知らせを消す（毎日）
import { createDeps } from "../_shared/adapters.ts";
import { runPurge, runSend, sanitizeError } from "../_shared/notifications.ts";

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (req.method !== "POST" || !key || !sameSecret(given, key)) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  let task = "send";
  try {
    const body = await req.json();
    if (body && typeof body.task === "string") task = body.task;
  } catch {
    // 本文がなければ送る
  }
  try {
    const deps = createDeps(env);
    const summary = task === "purge" ? await runPurge(deps) : await runSend(deps);
    return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: sanitizeError(e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
