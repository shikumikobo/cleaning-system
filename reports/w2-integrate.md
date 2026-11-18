# 波 2 の取り込みのあとのつなぎ（w2-integrate）

ブランチ `w2-integrate`（main の 8b33747 から）。

## 直したこと

1. 外部キー：`supabase/migrations/20261118020000_wave2_integration_fks.sql`。`quotes.request_id → requests`、`files.request_id → requests`、`files.quote_id → quotes`（どれも `(tenant_id, …)` の組。空は許す）。DB のテスト `53_integration_fks.sql`（自社・別会社・存在しない・空・付け替え。15 件）。
2. 専用ページの見積の区画：`apps/web/src/lib/quotes/portal.ts`（提出・承認の見積と明細。合計・税・有効期限・明細の金額が見える。作った人・決めた人・取引先・案件の列は取らない）。`portal/page.tsx` で登録。区画の項目に任意の `children`（明細）を足し、005 の `PortalItem` と画面を最小で広げた。型 D の種：`00002_seed_004.sql` に建物 A1 の見積 4 件（提出・承認・不成立・下書き）と明細。`52_external_portal.sql` に、見積と明細が型 D として登録され、extA は提出・承認の 2 件と明細だけを読めることを追加。
3. 入口のメニュー：崩れなし。e2e（`screens.e2e.ts`）で、10 個のリンクが全部あり、重複なし、一覧が 2 つ（通常・管理者）を確かめた。
4. 種と仮の表：下記。
5. `specs/data-model.md`：004 の列（note・submitted_at・decided_at・decided_by・decision_note・sort・amount は生成列・request_id の外部キー）と 005 の外部キーを書き足した（決まりは変えていない）。`specs/005-files-portal/tasks.md` の取り込みの項目に印。
6. 全部の検査：下記。

## 見つけた食い違い

- 各機能の種：すべて本物の表と合っている（`tests.seed()` が通る）。`20_clients_buildings.sql` の仮の表（contracts・invoices・works・photos・report_templates・template_items）は、まだ本物がない表だけで、本物と重なる表はない。ただし 009・010・011・012 の取り込み時に、本物ができた表はこの仮の表から外すこと（`create table` がぶつかる）。
- 既存のテストが外部キーの前提だったので直した：`50_files.sql`（R-005-4：存在しない案件・見積の id を付けていた → 自社の本物の id に）、`21_quotes.sql`（R-004-3：存在しない案件 id → 自社の案件）。R-004-23 の期待の数は、見積の種が増えたので A1 の分を足した。
- 仕様と合わない点（仕様は直していない）：005 の requirements R-005-4 の括弧書き（「外部キーは付けない」）、004 の requirements の範囲外・design の「列だけ」の記載は、外部キーを足したので古い。
- 004 の「案件を消すときの `app.usage_refs`」：003 は案件の削除の RPC を持たない（論理削除の列の更新だけ）ので、行は足していない。案件の削除を設計するときに決める。
- 001 の design が 004・009 で足すとした「見積を作った人の名前」は、004 では足していない（004 の報告のとおり）。

## 共通のファイルの変更（最小）

- `apps/web/src/lib/files/portal.ts`：`PortalItem` に任意の `children`。`apps/web/src/app/portal/page.tsx`：見積の区画の登録 1 行と、明細の表示。
- `supabase/tests/00002_seed_004.sql`：型 D の種を足した。

## 検査

`node tools/pglite/run.mjs` ok 1326・not ok 0（取り込み前は 1307）、`-r test` 298 件、lint・typecheck・build 通過、`test:e2e` 40 件（3 ファイルまとめて。各ファイルが別の Playwright の context で偽の接続先を上書きするのでぶつからない）、spec check 基準 221 件・テストあり 221 件。

## まだのこと

- 009・012 の区画と型 D の種。専用ページの見積に、見積書の印刷表示へのリンクは付けていない（外部の人用の印刷は未設計）。外部の人が押す承認（範囲外のまま）。実機の Supabase での確かめ。
