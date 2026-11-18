# 機能005：ファイルと専用ページ（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。終わったら `[x]`。

## DB

- [x] 種（`tests.seed_005()`。`00002_seed_005.sql`）と DB のテストを先に書き、失敗を確かめる（`50_files.sql`：R-005-1〜8、`51_files_sweep.sql`：R-005-14〜18、`52_external_portal.sql`：R-005-19〜24）
- [x] マイグレーション `20261118010000_files.sql`：表・policy（型 A＋D）・直せる列の絞り・建物を消すときの使われ方の登録（R-005-1〜7）
- [x] 掃除の関数 5 つ（service_role だけ）と、同時に1つだけ動く一意索引（R-005-14〜18）
- [x] 外部の人の型 D の決まりのテスト（全部の表を回す確かめ）（R-005-19〜24）

## Edge Function

- [x] 判断（`_shared/files.ts`）の単体のテストを先に書く（`apps/web/tests/files-functions.test.ts`：R-005-9〜12・14〜17）→ 実装
- [x] `sign-file-urls`（ログインの鍵で行を読み、署名は1回でまとめて）・`sweep-files`（定時）と、外への口（`files_adapters.ts`）
- [ ] 本物の Supabase での確かめ（`supabase functions serve`。この PC には Deno がないので未）
- [ ] `sweep-files` の定時の呼び出し（毎日）の登録

## 画面

- [x] 画面の部品（`lib/files`：検査・表記・上げる順・入口・区画の登録簿）の Vitest を先に書き、実装する（R-005-13・25・26・28・31・35・36）
- [x] 建物ごとのファイル（`/files/`）（R-005-30〜36）
- [x] 専用ページ（`/portal/`）とホームの入口（R-005-26〜29）
- [x] 画面の流れのテスト（`e2e/files.e2e.ts`）
- [ ] 実際の Supabase につないだ画面の確かめ（波 1 の画面と合わせて）

## 取り込みのとき

- [x] 003 を取り込んだら、`files.request_id` に `(tenant_id, request_id)` の外部キーを足す（列と索引はある）
- [x] 004 を取り込んだら、`files.quote_id` に `(tenant_id, quote_id)` の外部キーを足す
- [ ] 004・009・012 が、専用ページの区画（`registerPortalSection`）と、型 D の表の種を足す（足すと、52 の確かめに自動で入る）。004 は済（波 2 の取り込み）。009・012 はまだ

## 仕上げ

- [x] `spec.py check --strict`、lint・型・Vitest・DB のテスト・ビルド・画面の流れのテストを通す
- [x] 報告（`reports/w2-005.md`）
