// デモの入り口：押された役割（固定の5つだけ）のログインのリンクを作って送る。デモの利用者だけに使う。
const ROLES = { admin: 1, office: 1, staff1: 1, staff2: 1, external: 1 };
export async function onRequestGet({ params, request, env }) {
  const role = params.role;
  if (!ROLES[role]) return new Response("not found", { status: 404 });
  const origin = new URL(request.url).origin;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: env.SERVICE_KEY, Authorization: `Bearer ${env.SERVICE_KEY}` },
    body: JSON.stringify({ type: "magiclink", email: `demo-${role}@example.test`, redirect_to: origin + "/" }),
  });
  const j = await r.json();
  if (!j.action_link) return new Response("ログインのリンクを作れませんでした", { status: 500 });
  return Response.redirect(j.action_link, 302);
}
