// デモ用の鍵を作って .env に書く（本物ではない。手元のデモだけで使う）。
import { createHmac } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, ".env");
if (existsSync(envFile)) process.exit(0);
const secret = "demo-only-jwt-secret-at-least-32-characters-long";
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (role) => {
  const h = b({ alg: "HS256", typ: "JWT" });
  const p = b({ role, iss: "supabase-demo", iat: 1700000000, exp: 4800000000 });
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
};
writeFileSync(envFile, `JWT_SECRET=${secret}\nANON_KEY=${sign("anon")}\nSERVICE_KEY=${sign("service_role")}\nPGPASSWORD=demo-postgres-pass\n`);
console.log(".env を作りました");
