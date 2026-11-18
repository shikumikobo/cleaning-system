// デモの利用者のログインのリンクを出す（メールを待たずに入るため）。使い方：node tools/demo/login-link.mjs admin|office|staff1|staff2|external
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, ".env"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const who = process.argv[2] ?? "admin";
const email = `demo-${who}@example.test`;
const r = await fetch("http://127.0.0.1:54321/auth/v1/admin/generate_link", {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: env.SERVICE_KEY, Authorization: `Bearer ${env.SERVICE_KEY}` },
  body: JSON.stringify({ type: "magiclink", email, redirect_to: "http://127.0.0.1:3000/" }),
});
const j = await r.json();
console.log(j.action_link ?? j);
