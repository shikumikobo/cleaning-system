# 機能006：小口現金・レシート（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。終わったら `[x]`。

- [x] requirements・design を書く
- [x] DB のテストを先に書く（`supabase/tests/20_cash.sql`。R-006-1〜23・27〜29・33）と、種（`tests.seed_006()`）
- [x] マイグレーション：3つの表・policy・残高の view・確認と月の締めの RPC
- [x] 読み取りの解析と差し替えの口（`supabase/functions/_shared/receipt.ts`）のテスト → 実装（R-006-24〜26）
- [x] Edge Function `read-receipt`
- [x] CSV（R-006-30〜32）のテスト → 実装
- [x] 入力の確かめ・残高の見せ方・操作の出し分け（R-006-34〜36）と、端末へのため方（R-006-10）のテスト → 実装
- [x] 画面：`/cash`（持ち手）、`/cash/manage`（管理）。ブラウザでの動作確認は未（Supabase の本物の環境と、001 の波 1 のログインが要る）
- [ ] 012 のあとに、`work_id` の外部キーと、作業の選択を足す（`building_id` の外部キーは 002 の取り込みで付けた。建物の選択の画面は残り）
- [ ] 001 の波 1 の Supabase のクライアントに差し替える
- [ ] 画面の流れのテスト（Node 版 Playwright）。001 の波 1 のログインのあとで
- [ ] Edge Function `read-receipt` の処理の記録（`job_runs`、R-001-29）。service_role か RPC が要るので、001 の決まりに合わせて足す
- [ ] 外の読み取り（OCR）を使うかの決定と、`getReader()` の差し替え
- [x] `spec.py check --strict`、lint・型・単体・DB のテストを通す
