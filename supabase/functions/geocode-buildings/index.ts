// Edge Function：建物の住所から位置を求める（機能 013、R-013-8・10）。2 つの呼び方がある。
//
// 1. 定時（毎日）：POST {}（Authorization: Bearer <service_role のキー>）。会社ごとに、位置が空で直していない建物を求めて保存する。
//    {"limit": 50, "delay_ms": 1100} で、1 社あたりの件数と待ち時間を変えられる
// 2. 画面から 1 件：POST {"building_id": "<uuid>"}（Authorization: Bearer <ログインの鍵>）。master.edit の人が、自分の会社の建物について呼ぶ。
//    戻りは候補の位置 {found, lat, lng}。保存は画面が、地図で確かめたあとに行う
//
// 位置を求める外の API は、環境変数 GEOCODER で選ぶ（配備のときに人が決める。未設定なら「口が未設定」で失敗にする）。API のキーはコードに書かない。
// この PC には Deno がないため、ここは実行して確かめていない（判断は Vitest で確かめた。配備の前に supabase functions serve で確かめる）。
import { createEnvGeocoder, createGeocodeOneDeps, createGeocodeStore } from "../_shared/geocode_adapters.ts";
import { GEOCODE_DELAY_MS, GEOCODE_LIMIT, handleGeocodeOne, runGeocode, sanitizeError } from "../_shared/geocode.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const env = Deno.env.toObject();
  const authHeader = req.headers.get("authorization");
  const given = (authHeader ?? "").replace(/^Bearer\s+/i, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  let input: Record<string, unknown> = {};
  try {
    input = (await req.json()) ?? {};
  } catch {
    // 本文がなければ、定時の既定の値
  }
  try {
    if (key && sameSecret(given, key)) {
      const limit = typeof input.limit === "number" && input.limit >= 1 && input.limit <= 200 ? Math.floor(input.limit) : GEOCODE_LIMIT;
      const delayMs = typeof input.delay_ms === "number" && input.delay_ms >= 0 && input.delay_ms <= 10000 ? input.delay_ms : GEOCODE_DELAY_MS;
      const summary = await runGeocode({ store: createGeocodeStore(env), geocoder: createEnvGeocoder(env), limit, delayMs });
      return json(summary);
    }
    // service_role でなければ、ログインした人の 1 件の呼び出し
    const r = await handleGeocodeOne(authHeader, input, createGeocodeOneDeps(env));
    return json(r.body, r.status);
  } catch (e) {
    return json({ error: sanitizeError(e) }, 500);
  }
});
