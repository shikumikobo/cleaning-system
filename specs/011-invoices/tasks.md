# 機能011：請求（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。終わったら `[x]`。

## DB

- [x] DB のテスト `supabase/tests/23_invoices.sql` と、`tests.seed_011()`（`00002_seed_011.sql`）を先に書き、失敗を確かめる（R-011-1〜31）
- [x] マイグレーション：表・索引・組の外部キー・二重請求を止める一意の索引（`20261121020000_invoices_tables.sql`）
- [x] マイグレーション：policy の型（B）と、列の権限・直接書き込みの禁止・view `invoice_balances`
- [x] マイグレーション：下書きを作る・発行・送付・取消・下書きを消す・入金の RPC（`20261121020100_invoices_rpcs.sql`）
- [x] 002・003・010 のテストの仮の表（`invoices`・`invoice_lines`）を外し、本物の表で通す
- [x] 全部の表の漏れ・構造のテスト（01・02・03）に、011 の表が自動で入ることを確かめる
- [x] 010 の `service_invoiced`・`work_charge_locked`、003 の `request_charge_locked` が、本物の `invoice_lines` で効くことを確かめる（R-011-21）

## 画面の部品

- [x] 合計の計算・インボイスの書き方・CSV・期日超過・絞り込み・入力の検査の Vitest を先に書き（R-011-32〜36）、実装する
- [x] 画面の合計と DB の合計の一致（`fixtures/invoice_totals.json` と、`23_invoices.sql` の同じ数字。R-011-32）

## 画面

- [x] 請求の一覧・下書きの作成・CSV（画面の流れのテスト `e2e/invoices.e2e.ts` つき）
- [x] 請求書の詳細：下書きの編集・発行・送付・取消・下書きを消す・入金（記録・直す・消す）
- [x] 印刷（A4・インボイスの書き方）
- [x] 入口のメニューに `/invoices/` を1行足す
- [ ] 実際の Supabase につないだ画面の確かめ（波のあと）

## 仕上げ

- [x] `spec.py check w4-011 --strict`、lint・型・Vitest・ビルド・画面の流れのテスト・DB のテストを通す
- [x] reports/w4-011.md
