// Edge Function：レシートの読み取り（機能 006、R-006-24〜26）。
// 操作した人の鍵で、レシートの行と画像を読み、読み取りの結果を同じ鍵でレシートに書く（RLS を通す。service_role は使わない）。
// 読み取りの方法は getReader() の1か所で差し替える。初めは「読み取らない」で、状況は「読み取れず」になり、画面で手で入れる。
//
// 呼び方：POST { "receipt_id": "<uuid>" }（Authorization: Bearer <ログインの鍵>）
import { createClient } from "npm:@supabase/supabase-js@2";
import { manualReader, runReader, type ReceiptReader } from "../_shared/receipt.ts";

const BUCKET = "tenant-files";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

/** 読み取りの方法。外の読み取りが決まったら、ここだけを差し替える（例：textReader("名前", 画像から文字を返す関数)） */
function getReader(): ReceiptReader {
  return manualReader;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "unauthorized" }, 401);

  let receiptId: string | undefined;
  try {
    receiptId = (await req.json())?.receipt_id;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (typeof receiptId !== "string" || !/^[0-9a-f-]{36}$/i.test(receiptId)) return json({ error: "bad_request" }, 400);

  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  // 見えるのは、持ち手の本人か cash.manage を持つ人のレシートだけ（RLS）
  const { data: receipt, error } = await client
    .from("receipts")
    .select("id, storage_path, status")
    .eq("id", receiptId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return json({ error: "read_failed" }, 500);
  if (!receipt) return json({ error: "not_found" }, 404);
  if (receipt.status === "manual") return json({ status: "manual" }); // 手で入れたものは読み取らない

  const file = await client.storage.from(BUCKET).download(receipt.storage_path);
  if (file.error || !file.data) return json({ error: "image_not_found" }, 404); // 画像がまだ上がっていない

  const bytes = new Uint8Array(await file.data.arrayBuffer());
  const outcome = await runReader(getReader(), bytes, file.data.type || "image/jpeg");

  const { error: upErr } = await client
    .from("receipts")
    .update({ read_amount: outcome.amount, read_date: outcome.date, status: outcome.status })
    .eq("id", receiptId);
  // 確認済みの出入りから使われているレシートは、RLS が書かせない（エラーにはしない）
  if (upErr) return json({ status: "locked" });
  return json({ status: outcome.status, amount: outcome.amount, date: outcome.date, reader: outcome.reader });
});
