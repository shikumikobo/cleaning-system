# 波 3 の取り込みのあとのつなぎ（w3-integrate）

ブランチ `w3-integrate`（main の 1c76703 から）。

## 直したこと

1. 落ちていたテスト：`54_photos.sql` の R-008-8 の節の仮の `work_assignments`（create/drop table）をやめ、本物の `works`（種の契約の中身 svcA1-base から）と `work_assignments` の行をテストの中で作る形にした。「表がない間は撮った本人で決める」のテストは、表ができて前提がなくなったので外し、R-008-8 に照らした確かめに置き換えた（担当を外す・担当に加える・担当 0 人の作業・作業なしの写真は撮った本人）。
2. マイグレーション `20261120010000_wave3_integration_fks.sql`
   - `photos.work_id → works`（組の外部キー。空は許す）
   - `cash_entries.work_id → works`（006 が「作業の表ができたら足す」としていた分。両方揃ったのでここで足した）と索引
   - `app.is_my_photo` を、表の有無を見る動的な形から、本物の `work_assignments` を直接読む形に置き換え。外された担当（`deleted_at` あり）を数えない（008 で見落としていた不具合。担当を外しても読めてしまう）
   - `app.usage_refs`：足していない。作業を消す RPC はなく（取消は `cancelled`＋`deleted_at`）、外部キーがあるので行は残る
3. `53_integration_fks.sql` に photos（自社・空・別会社・存在しない・付け替え・取り消した作業）と cash_entries の確かめを足した。利用者として作ると、別会社・存在しない作業は担当の判定（RLS 42501）で先に止まるので、外部キー自体（23503）は基盤の権限で確かめている。
4. 008 の判定関数が本物の表で動くこと：54 の R-008-8（作業の担当が読める・直せる・作れる、担当でないと撮った本人でも不可、work.assign の人は読める、担当の外し・追加）で確かめた。
5. 文書：`specs/008-photos/design.md`（判定・外部キー・決めたこと）、`tasks.md`、`specs/data-model.md`（photos・cash_entries の work_id）、`specs/006-petty-cash/design.md`。`tools/docker/`（run.mjs・supabase_gap.sql）を main 本体から写してコミット。

## 検査

- PGlite：ok 1684、not ok 0、ファイルのエラー 0
- Docker（本物の Postgres 17。マイグレーション 22 本）：ok 1684、not ok 0、エラー 0。コンテナは消した
- `pnpm -r test` 27 ファイル 386 件、lint・typecheck・build：エラーなし
- `test:e2e` 5 ファイル 69 件
- `spec.py check w3-integrate --strict`：基準 291・テストあり 291・問題なし

## AI が決めた点

- 担当が 0 人の作業の写真は、撮った本人に戻さず、R-008-8 のとおり `work.assign` を持つ人だけが読める
- 「表がない間」のテストは、仕様の趣旨（持ち主は作業の担当）に合わせて削除し、design.md に理由を書いた
- cash_entries.work_id の外部キーを足した（報告書の「取り込みでやること」にはなかったが、006 の保留の理由が解消したため。要らなければ該当 2 行を外せる）

## 仕様と合わない点（仕様は直していない）

- 008 requirements の R-008-4（「作業は相手の表ができるまで外部キーなし」）と R-008-8（「作業と担当の表ができたあと。それまでは撮った本人」）の括弧書きが古い。報告書の指す 006 の requirements に古い記載があれば同様。

## 共通のファイルの変更

- なし（テストと 008・010 側のみ。`tools/docker/` を追加）

## まだのこと（009・011・012・014 を待つ）

- 009：`photos.report_item_id` の外部キー、`photo_report_locked`・`photo_external_visible` の本物、写真の区画の登録簿と型 D の種、`works.report_template_id`・`contract_services.report_template_id` の外部キー
- 011：`invoice_lines`（service_key・service_month・work_id）ができると `service_invoiced`・`work_charge_locked` が効く。列名が違えば関数を直す
- 012：担当の画面、works の状況を変える RPC、案件を元にした作業の RPC　／　014：`create_contract_import` の呼び出し
- Deno での Edge Function の確かめ、実機カメラ、実際の Supabase での確かめ
