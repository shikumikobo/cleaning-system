// 運営が会社を作る小さなコマンド（R-001-1）。Edge Function `create-tenant` を呼ぶ。
// 使い方：node tools/create-tenant.mjs --name "A清掃" --email owner@example.com [--trial-days 30]
// 環境変数：SUPABASE_URL（例 https://xxxx.supabase.co）、OPERATOR_TOKEN（運営の利用者のログインの鍵。
//   app_metadata.operator = "true" を持つ利用者の access_token）。鍵はファイルに書かない。
const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = opt("name");
const email = opt("email");
const days = opt("trial-days");
const url = process.env.SUPABASE_URL;
const token = process.env.OPERATOR_TOKEN;
if (!name || !email || !url || !token) {
  console.error('使い方：SUPABASE_URL=… OPERATOR_TOKEN=… node tools/create-tenant.mjs --name "会社名" --email 管理者のメール [--trial-days 30]');
  process.exit(2);
}
const res = await fetch(`${url.replace(/\/+$/, "")}/functions/v1/create-tenant`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name, admin_email: email, ...(days ? { trial_days: Number(days) } : {}) }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`失敗（${res.status}）：${body.error ?? "不明なエラー"}`);
  process.exit(1);
}
console.log(`会社を作り、${email} に招待を送りました（会社の ID：${body.tenant_id}、期限：${body.expires_at}）`);
