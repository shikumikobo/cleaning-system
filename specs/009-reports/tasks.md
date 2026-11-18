# 機能009：清掃報告書（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。

## DB

- [x] 種（`tests.seed_009()`。`00002_seed_009.sql`）と DB のテスト（`23_report_templates.sql`：R-009-1〜7、`24_reports.sql`：R-009-8〜18・21・23、`25_reports_external.sql`：R-009-19・20・22）を先に書く
- [x] マイグレーション `20261121010000_reports_tables.sql`：ひな形・項目・報告書・報告書の項目の表と policy（型 A・C2＋D）、008 の写真の判定の本物、写真の作る policy、`photos.report_item_id`・`works.report_template_id`・`contract_services.report_template_id` の外部キー
- [x] マイグレーション `20261121010100_reports_rpcs.sql`：確認・差し戻し・提出、ひな形・項目を消す RPC
- [x] 002 のテストの仮の表（report_templates・template_items）、008 のテストの仮の固定・外部の見せ方を、本物に置き換える

## 画面と端末

- [x] `lib/reports`（下書きの組み立て・端末にためる・送る口・専用ページの区画）の Vitest（R-009-24〜29・36）
- [x] 写真の入れ物に、報告書の項目つきの写真を足す（`work_id`・`report_item_id`・項目の行が届くまで待つ）
- [x] 一覧・報告書（スマホ）・確認と提出・印刷・ひな形の編集と、画面の流れのテスト（`e2e/reports.e2e.ts`。R-009-30〜37）
- [x] 入口のメニューに 1 行、専用ページに報告書と写真の区画
- [ ] 実機のカメラ（iOS・Android）での確かめ
- [ ] 実際の Supabase につないだ画面の確かめ

## 取り込みのとき

- [x] `tests.seed()` の `perform tests.seed_009();`（008・010 の行の後に並べる）
- [ ] 011（請求）・012（作業の割り当て・状況）・014（取り込み）と並べたときの、`tests.seed()` と全部のテストの確かめ（呼び元）
- [ ] 波 6：「出ていない報告書」のお知らせ（`report_missing`）を作る処理
