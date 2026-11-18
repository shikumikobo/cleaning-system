// Edge Function：ファイルの掃除（機能 005、R-005-14〜18）。定時（毎日）に呼ばれ、会社ごとに、
// 行のない置き場所のファイルを消し、ファイルのない行を論理削除する。処理の記録（job_runs）は会社ごと・1回ごと。
// 呼べるのは service_role のキーを持つ呼び出しだけ。判断は _shared/files.ts。
//
// 呼び方：POST {}（Authorization: Bearer <service_role のキー>）。{"grace_seconds": 86400} で猶予を変えられる
import { createSweepStore } from "../_shared/files_adapters.ts";
import { runFileSweep, sanitizeError } from "../_shared/files.ts";

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
  let graceSeconds: number | undefined;
  try {
    const body = await req.json();
    if (body && typeof body.grace_seconds === "number" && body.grace_seconds >= 0) graceSeconds = body.grace_seconds;
  } catch {
    // 本文がなければ初めの猶予
  }
  try {
    const summary = await runFileSweep({ store: createSweepStore(env), graceSeconds });
    return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: sanitizeError(e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
