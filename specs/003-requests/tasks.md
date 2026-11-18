# 機能003：案件（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。終わったら `[x]`。

- [x] requirements・design を書く
- [x] DB のテストを先に書く（`supabase/tests/21_requests.sql`。R-003-1〜22・24〜26・30〜32）と、種（`tests.seed_003()`）。表がない状態で失敗を確かめた
- [x] マイグレーション：2つの表・policy・列の権限・使われ方の登録（`20261117100000_requests_tables.sql`）
- [x] マイグレーション：状況の切り替え・気づきから案件・担当の一覧・期限のお知らせの関数（`20261117100100_requests_rpcs.sql`）
- [x] 002 のテストの仮の `requests` の表を、本物の表に置き換える
- [x] 画面の部品（期限の判定・入力の検査・絞り込みと並び・状況の出し分け・気づきの端末へのため方）のテスト → 実装（R-003-23・27〜29・15）
- [x] 定時の処理の判断（`_shared/requestDue.ts`）のテスト → 実装、Edge Function `request-due`（R-003-26）
- [x] 画面：`/requests/`・`/requests/new/`・`/requests/detail/`。ブラウザでの動作確認は未（Supabase の本物の環境と、001 の波 1 のログインが要る）
- [x] `spec.py check --strict`、lint・型・単体・DB のテストを通す
- [ ] 008 のあとに、気づきの RPC に写真の引数を足し、写真の側の `request_id` につなぐ
- [ ] 011 のあとに、`invoice_lines` の列名を確かめ、請求済みのテスト（R-003-13・21）を本物の表で流す
- [ ] 画面の流れのテスト（Node 版 Playwright）。001 の波 1 の偽の接続先に案件を足したあとで
- [ ] `request-due` の定時の設定（配備側）と、実機（Deno）での確認
