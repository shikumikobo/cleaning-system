// 本物の Postgres（Supabase のイメージ、Docker）で、マイグレーションと DB のテスト（pgTAP）を流す。
// 使う場面：Docker が動くとき。Supabase の CLI は Smart App Control で動かないので、CLI を使わずにイメージを直接使う。
// 使い方：node tools/docker/run.mjs [テストのファイル名の一部]
//   KEEP=1 で終わってもコンテナを残す（調べるとき）。IMAGE=… でイメージを変える。
//   SETUP_ONLY=1 で補いまでで止める（設定の確かめ）。
// 役割：補いは管理者（supabase_admin。auth・storage に作るため）。マイグレーションとテストは、本物の Supabase と同じ postgres。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const IMAGE = process.env.IMAGE ?? "supabase/postgres:17.11.0.018";
const NAME = process.env.CONTAINER ?? "cleaning-pgtest";
const filter = process.argv[2];

function sh(args, opt = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opt });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function psqlFile(path, extra = [], user = "postgres") {
  return sh(["exec", NAME, "psql", "-U", user, "-d", "postgres", "-h", "localhost", "-X", "-q", "-At", ...extra, "-f", path]);
}

// 1. 新しいコンテナ
sh(["rm", "-f", NAME]);
const run = sh(["run", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=localtest", IMAGE]);
if (run.code !== 0) {
  console.error("コンテナを始められない：\n" + run.out);
  process.exit(2);
}
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  ready = /accepting/.test(sh(["exec", NAME, "pg_isready", "-U", "postgres", "-h", "localhost"]).out);
  if (!ready) spawnSync("node", ["-e", "setTimeout(()=>{},2000)"]);
}
if (!ready) {
  console.error("Postgres が起きない");
  process.exit(2);
}
// 起動直後の初期化の再起動を待つ（イメージの初期化は一度再起動する）
spawnSync("node", ["-e", "setTimeout(()=>{},4000)"]);
ready = /accepting/.test(sh(["exec", NAME, "pg_isready", "-U", "postgres", "-h", "localhost"]).out);
if (!ready) {
  console.error("Postgres が起きない（再起動のあと）");
  process.exit(2);
}

// 2. ファイルを入れる
sh(["exec", NAME, "mkdir", "-p", "/work"]);
const cp1 = sh(["cp", join(root, "supabase"), `${NAME}:/work/supabase`]);
const cp2 = sh(["cp", join(here, "supabase_gap.sql"), `${NAME}:/work/supabase_gap.sql`]);
if (cp1.code !== 0 || cp2.code !== 0) {
  console.error("ファイルを入れられない：\n" + cp1.out + cp2.out);
  process.exit(2);
}

// 3. 足りないものを補う
const gap = psqlFile("/work/supabase_gap.sql", ["-v", "ON_ERROR_STOP=1"], "supabase_admin");
if (gap.code !== 0) {
  console.error("補いが失敗：\n" + gap.out);
  process.exit(2);
}
console.log("補い OK");
if (process.env.SETUP_ONLY) {
  if (!process.env.KEEP) sh(["rm", "-f", NAME]);
  process.exit(0);
}

// 4. マイグレーション（名前の順）
const migs = readdirSync(join(root, "supabase", "migrations")).filter((x) => x.endsWith(".sql")).sort();
for (const f of migs) {
  const r = psqlFile(`/work/supabase/migrations/${f}`, ["-v", "ON_ERROR_STOP=1", "-c", "set search_path to public, extensions"]);
  if (r.code !== 0) {
    console.error(`マイグレーションが失敗：${f}\n${r.out}`);
    process.exit(2);
  }
}
console.log(`マイグレーション OK（${migs.length} 本）`);

// 5. DB のテスト（本物の pgTAP）。ファイルごとに別のセッション
let ok = 0, notOk = 0, errors = 0, skipped = 0;
for (const f of readdirSync(join(root, "supabase", "tests")).filter((x) => x.endsWith(".sql")).sort()) {
  if (filter && !f.includes(filter) && !f.startsWith("0000")) {
    skipped++;
    continue;
  }
  const wrapped = `/work/supabase/tests/${f}`;
  // 検索の道筋に extensions を入れる（pgTAP の関数がある）。-c と -f は同じセッションで順に動く
  const r = sh(["exec", NAME, "psql", "-U", "postgres", "-h", "localhost", "-X", "-q", "-At",
    "-c", "set search_path to public, extensions", "-f", wrapped]);
  console.log(`\n# ${f}`);
  const lines = r.out.split(/\r?\n/);
  let fileNotOk = 0;
  for (const l of lines) {
    if (/^ok \d+/.test(l)) ok++;
    else if (/^not ok \d+/.test(l)) {
      notOk++;
      fileNotOk++;
      console.log(l);
    } else if (/^#/.test(l) && fileNotOk > 0) console.log(l);
    else if (/ERROR:|FATAL:/.test(l)) {
      errors++;
      console.log(l);
    }
  }
}
console.log(`\n合計：ok ${ok}、not ok ${notOk}、エラー ${errors}${skipped ? `（絞り込みで ${skipped} ファイルを飛ばした）` : ""}`);

if (!process.env.KEEP) sh(["rm", "-f", NAME]);
process.exit(notOk > 0 || errors > 0 ? 1 : 0);
