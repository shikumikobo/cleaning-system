# 機能014：データの取り込み（タスク）

基準ごとに「テストを書いて失敗を確かめる → 実装する → 通す」の順。終わったら `[x]`。

## DB

- [x] DB のテスト `supabase/tests/23_import.sql` と `tests.seed_014()`（`00002_seed_014.sql`）を先に書き、失敗を確かめる（R-014-12〜16）
- [x] マイグレーション：`import_jobs`（型 E。読めるのは `master.edit`）
- [x] マイグレーション：RPC `import_rows`（取引先・建物・部屋・契約。契約は `create_contract_import` を呼ぶ）、名前の比べ方 `app.import_key`

## 読み込みと確かめ（純粋な関数）

- [x] Vitest を先に書き（R-014-1〜9）、`apps/web/src/lib/import/` を実装する（CSV・xlsx の読み込み、見出し、検査、重なり、契約のまとめ、頻度の読み解き、ひな形）

## 画面

- [x] 画面の流れのテスト `apps/web/e2e/import.e2e.ts` を先に書く（R-014-10・11・17〜19）
- [x] `/import/`（種類の選択・ひな形・ファイル・確かめ・取り込み・結果・履歴）。入口のメニューに1行

## 仕上げ

- [x] `spec.py check w4-014 --strict`、lint・型・Vitest・ビルド・画面の流れ・DB のテストを通す
- [x] reports/w4-014.md
