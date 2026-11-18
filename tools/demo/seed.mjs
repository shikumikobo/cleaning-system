// デモの利用者を作り（ログインのリンクで入る。パスワードなし）、デモデータを入れる。
// 使い方：node tools/demo/seed.mjs（先に up.mjs で Supabase を起動し、マイグレーションを入れておく）
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const users = [
  ["admin", "demo-admin@example.test"],
  ["member", "demo-office@example.test"],
  ["staff1", "demo-staff1@example.test"],
  ["staff2", "demo-staff2@example.test"],
  ["external", "demo-external@example.test"],
];
// このシステムはパスワードを禁止するため（forbid_password）、ログインの管理 API は使わず、利用者を DB に直接入れる
const rows = [];
const mk = users
  .map(
    ([, email]) => `insert into auth.users (instance_id,id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
select '00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated','${email}',now(),'{"provider":"email","providers":["email"]}','{}',now(),now(),'','','',''
where not exists (select 1 from auth.users where email='${email}');
insert into auth.identities (provider_id,user_id,identity_data,provider,created_at,updated_at,last_sign_in_at)
select u.id::text,u.id,jsonb_build_object('sub',u.id::text,'email',u.email,'email_verified',true),'email',now(),now(),now() from auth.users u
where u.email='${email}' and not exists (select 1 from auth.identities i where i.user_id=u.id);`,
  )
  .join("\n");
const mkr = spawnSync("docker", ["exec", "-i", "cleaning-demo-db-1", "psql", "-U", "supabase_admin", "-d", "postgres", "-h", "localhost", "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: mk, encoding: "utf8" });
if (mkr.status !== 0) {
  console.error("利用者を作れない", mkr.stdout, mkr.stderr);
  process.exit(1);
}
for (const [role, email] of users) {
  const q = spawnSync("docker", ["exec", "cleaning-demo-db-1", "psql", "-U", "postgres", "-d", "postgres", "-h", "localhost", "-At", "-c", `select id from auth.users where email='${email}'`], { encoding: "utf8" });
  rows.push(`('${role}','${q.stdout.trim()}')`);
}
const sql = `create temp table u(role text, id uuid); insert into u values ${rows.join(",")};\n` + readFileSync(join(here, "seed.sql"), "utf8");
const r = spawnSync(
  "docker",
  ["exec", "-i", "cleaning-demo-db-1", "psql", "-U", "postgres", "-d", "postgres", "-h", "localhost", "-X", "-v", "ON_ERROR_STOP=1", "-c", "set search_path to public, extensions", "-f", "-"],
  { input: sql, encoding: "utf8" },
);
console.log(r.stdout, r.stderr);
process.exit(r.status ?? 1);
