# 機能008：現場の写真（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。

## DB

- [x] 種（`tests.seed_008()`。`00002_seed_008.sql`）と DB のテスト（`54_photos.sql`：R-008-1〜12、`55_photos_sweep.sql`：R-008-16〜18、`56_photos_observation.sql`：R-008-13〜15）を先に書く
- [x] マイグレーション `20261119020000_photos.sql`：表・policy（型 C2＋D）・直せる列・使われ方の登録・掃除の関数・RPC の写真の引数
- [x] 002・003 のテストの仮の表・古い期待を直す

## Edge Function

- [x] `sign-file-urls` の photos 対応（R-008-20・21）、`sweep-files` の写真の掃除（R-008-19）。単体のテスト `apps/web/tests/photos-functions.test.ts`
- [ ] 本物の Supabase での確かめ（この PC には Deno がない）

## 画面

- [x] `lib/photos`（縮小・Exif 除去・端末のため・送り・一覧の組み立て）の Vitest（R-008-22〜33）
- [x] 撮る・一覧・詳細・直す・気づきから案件（R-008-31〜37）と e2e（`e2e/photos.e2e.ts`）
- [ ] 実機のカメラ（iOS・Android）での確かめ

## 取り込みのとき

- [x] 010 を取り込んだら、`photos.work_id` に `(tenant_id, work_id)` の外部キーを足す（波 3 のつなぎ。`is_my_photo` も本物の表を直接読む形に）
- [ ] 009 を取り込んだら、`photo_report_locked`・`photo_external_visible` を本物に置き換え、`report_item_id` の外部キーを足す。専用ページの区画の登録簿に写真の区画を足す
- [ ] `tests.seed()` の `perform tests.seed_008();` を並べる。`20_clients_buildings.sql` の仮の表（photos）は外した
