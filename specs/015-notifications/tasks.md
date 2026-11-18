# 機能015：お知らせ（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。終わったら `[x]`。

## 波 1：仕組み

- [x] requirements.md・design.md・tasks.md を書く
- [x] DB のテスト（pgTAP）を先に書き、失敗を確かめる（R-015-1〜17・25 と、送る処理が呼ぶ関数 R-015-18〜23）
- [x] マイグレーション：表3つ・種類の一覧と初めの値・policy の型・列の権限・共通の関数・端末の登録の RPC・送る処理が呼ぶ関数・掃除（R-015-1〜25）
- [x] `tests.seed_notifications()` を足す（全部の表に流す確かめに入れる）
- [x] 送る処理の判断のコード（`_shared/notifications.ts`）と、Deno の口（`adapters.ts`・`index.ts`）
- [x] 送る処理の単体のテスト（偽の送り手・偽の DB。R-015-18〜25）。コードのあとに書いたため、コードを壊して（端末を消す・会社の取り違えを防ぐ処理を外して）テストが失敗することを確かめた
- [x] 画面の部品のテスト（設定の合成・許可と登録・`sw-push.js`）を先に書く（R-015-26〜28）
- [x] 画面の部品と、お知らせの一覧・通知の設定の画面、`sw-push.js`、`NotificationBell`
- [x] lint・型・単体・ビルド、`node tools/pglite/run.mjs`、`spec.py check cleaning --strict` を通す

## 波 6：出来事ごとの通知（012 の予定と実績のあと）

- [x] 出来事ごとの基準（R-015-29〜42）を requirements.md に足す
- [x] DB のテスト（pgTAP）を先に書く（R-015-29〜40）。実装のあとで、コードを壊して（操作した本人を除く条件・期日の比べ方）テストが失敗することを確かめた
- [x] 予定の変更（`work_changed`）：012 の `reschedule_work`・`skip_work`・`cancel_work`・`swap_assignment` から `app.enqueue_notification` を呼ぶ
- [x] 明日の作業（`work_tomorrow`）・出ていない報告書（`report_missing`）・請求の入金の遅れ（`invoice_overdue`）：毎日の定時の処理（DB の関数と Edge Function `daily-notifications`）
- [x] 期限の近い案件（`request_due`）：003 で作成済み（R-003-24〜26）
- [x] 見積の承認（`quote_approved`）：004 で作成済み（R-004-15・17・18）
- [x] 定時の処理の判断の単体のテスト（Vitest。R-015-39・40）
- [x] 画面の流れのテスト（Node 版 Playwright。許可 → 登録 → 設定 → 一覧 → 既読 → 鈴。R-015-26・27・41・42）
- [x] ヘッダーの鈴・今の会社の読み方を 001 の `AuthProvider` に合わせる（取り込みで済み）。既読の直後に鈴を更新する
- [ ] 定時の呼び出し（毎日 `daily-notifications`、毎分 `send-notifications`）の配備の設定（人）
- [ ] 実機（Android・iOS の PWA）と実際のメールの送りの確かめ（鍵と送り手が決まってから。人）
