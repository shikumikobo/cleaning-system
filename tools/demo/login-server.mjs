// デモ用の入り口（http://127.0.0.1:3001/）。押すと、その役割のログインのリンクをその場で作って、画面へ送る。
// 本物の運用では使わない（デモの利用者だけ、手元の PC だけ）。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const WHO = [
  ["admin", "管理者", "山田 太郎（社長）。会社のすべて"],
  ["office", "社員（事務）", "佐藤 花子。案件・見積・請求・予定。利用者の管理はできない"],
  ["staff1", "スタッフ", "鈴木 一郎。自分の予定の記録・小口。金額と見積は見えない"],
  ["staff2", "スタッフ", "高橋 美咲。同上"],
  ["external", "外部（管理会社）", "中村 健。専用ページだけ"],
];

createServer(async (req, res) => {
  const m = /^\/go\/([a-z0-9]+)/.exec(req.url ?? "");
  if (m) {
    const r = await fetch("http://127.0.0.1:54321/auth/v1/admin/generate_link", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: env.SERVICE_KEY, Authorization: `Bearer ${env.SERVICE_KEY}` },
      body: JSON.stringify({ type: "magiclink", email: `demo-${m[1]}@example.test`, redirect_to: "http://127.0.0.1:3000/" }),
    });
    const j = await r.json();
    if (j.action_link) {
      res.writeHead(302, { Location: j.action_link });
      return res.end();
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ログインのリンクを作れませんでした：" + JSON.stringify(j));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>デモの入り口</title>
<style>body{font-family:"BIZ UDPGothic","Yu Gothic",sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#14263a;background:#eef2f1}h1{border-left:6px solid #f2c12e;padding-left:12px}a.b{display:block;margin:10px 0;padding:14px 16px;background:#fff;border:1px solid #d3dad7;border-left:5px solid #14263a;border-radius:6px;color:inherit;text-decoration:none}a.b:hover{border-left-color:#f2c12e;background:#e1eef1}a.b b{display:block}small{color:#3d5064}</style>
<h1>デモの入り口</h1><p>入りたい役割を選んでください（架空の会社「サンプル清掃株式会社」）。</p>
${WHO.map(([k, n, d]) => `<a class="b" href="/go/${k}"><b>${n}</b><small>${d}</small></a>`).join("")}`);
}).listen(3001, "127.0.0.1", () => console.log("デモの入り口 http://127.0.0.1:3001/"));
