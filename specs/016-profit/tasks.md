# 機能016：売上と粗利（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。終わったら `[x]`。

## DB

- [x] DB のテスト `supabase/tests/24_profit.sql` と、`tests.seed_016()`（`00002_seed_016.sql`）を先に書き、失敗を確かめる（R-016-1〜18）
- [x] マイグレーション：`costs`・索引・組の外部キー・policy（型 B）・建物の使われ方（`20261122020000_profit_tables.sql`）
- [x] マイグレーション：view `profit_lines`・`profit_monthly`（`20261122020100_profit_views.sql`）
- [x] 全部の表の漏れ・構造のテスト（01・02・03）に、`costs` が自動で入ることを確かめる

## 画面の部品

- [x] 集め方・合計・粗利・比べ・入力の検査の Vitest を先に書き（R-016-19・20）、実装する

## 画面

- [x] 月の売上と粗利（契約・建物・取引先）と比べ `/profit/`（画面の流れのテスト `e2e/profit.e2e.ts` つき）
- [x] 費用の入力・一覧・直す・消す `/profit/costs/`
- [x] 入口のメニューに `/profit/` を1行足す
- [ ] 実際の Supabase につないだ画面の確かめ（波のあと）

## 仕上げ

- [x] `spec.py check w5-016 --strict`、lint・型・Vitest・ビルド・画面の流れのテスト・DB のテストを通す
