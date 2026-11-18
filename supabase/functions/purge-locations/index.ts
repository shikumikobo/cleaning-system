// Edge Function：実績の位置を 90 日で消す（機能 013、R-013-19・20）。定時（毎日）に呼ばれる。
// 呼べるのは service_role のキーを持つ呼び出しだけ。会社ごとに、開始から 90 日を過ぎた実績の位置の列を空にする（距離・警告・時刻・行は残す）。
//
// 呼び方：POST {}（Authorization: Bearer <service_role のキー>）
// この PC には Deno がないため、ここは実行して確かめていない（判断は Vitest で確かめた。配備の前に supabase functions serve で確かめる）。
import { createPurgeStore } from "../_shared/geocode_adapters.ts";
import { runPurgeLocations, sanitizeError } from "../_shared/purgeLocations.ts";

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
  try {
    const summary = await runPurgeLocations(createPurgeStore(env));
    return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: sanitizeError(e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
