# 機能006：小口現金・レシート（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md) が正で、ここは 006 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の2章。

## 1. 表

どの表も `tenant_id` と共通の列（`id`・作成と更新の人と時刻・`deleted_at`）を持つ。親は `unique (tenant_id, id)`、子は `(tenant_id, 親の id)` の組で参照する。

| 表 | 型 | 列（共通の列を除く） | 説明 | 基準 |
|---|---|---|---|---|
| `cash_accounts` | C1（持ち主は `holder_id`） | holder_id、name | 持ち手（所属）ごとの小口。`unique (tenant_id, id, holder_id)`（出入りが持ち手を揃えるため）。名前は持ち手の中で、消していない行で一意 | R-006-1〜5 |
| `cash_entries` | C1（持ち主は `holder_id`） | account_id、holder_id、entry_date、direction（in・out）、amount（1円以上の整数）、purpose、building_id、work_id、receipt_id、status（draft・confirmed・closed）、confirmed_at・confirmed_by、closed_at・closed_by、client_created_at・received_at・device_id | `id` は端末の uuid。`(tenant_id, account_id, holder_id)` で小口の持ち手と揃える。`(tenant_id, receipt_id, holder_id)` で同じ持ち手のレシートだけを付ける | R-006-6〜21・29 |
| `receipts` | C1（持ち主は `holder_id`） | holder_id、storage_path、read_amount、read_date、status（pending・read・failed・manual）、client_created_at・received_at・device_id | `id` は端末の uuid。`storage_path` は `<tenant_id>/receipts/<id>.(jpg\|png\|webp)` だけ（check） | R-006-22〜29 |

- `building_id` は、`(tenant_id, building_id)` で 002 の `buildings` を指す外部キー（マイグレーション `20261117030000`）。`work_id` は、`(tenant_id, work_id)` で 010 の `works` を指す外部キー（空でもよい。波 3 の取り込みで足した）
- 残高は view `cash_account_balances`（`security_invoker = true`）：小口ごとに、`balance`（消していない出入りの 入金 − 出金）、`confirmed_balance`（確認済み・締め済みだけ）、`draft_count`。見る人の権限の行だけを数える（R-006-4）
- 状況の値（status）は check 制約で決め、切り替えは RPC だけ。画面は status を書き換えない（R-006-13）

## 2. 権限（RLS）

型 C1 を `app.apply_policy` から付ける（`supervise_perm`・`write_perm` は `cash.manage`）。型の既定は「持ち主の本人が作る・直す」だが、006 は表ごとに狭めるので、`tp_insert`・`tp_update` を同じ名前で作り直す（名前は型の関数と同じ `tp_` から始める）。

| 表 | 操作 | だれが | 条件 | 基準 |
|---|---|---|---|---|
| cash_accounts | 読む | 持ち手の本人、`cash.manage` | 型 C1 | R-006-3 |
| cash_accounts | 作る | `cash.manage` だけ | 持ち手の本人は作れない | R-006-1・2 |
| cash_accounts | 直す・消す | `cash.manage` だけ | 消す（`deleted_at`）のは残高が0のときだけ | R-006-2・5 |
| cash_entries | 読む | 持ち手の本人、`cash.manage` | 型 C1 | R-006-14 |
| cash_entries | 作る | 持ち手の本人（出金だけ）、`cash.manage`（入金・出金） | status は draft、確認・締めの列は空、日付の月が締められていない | R-006-6〜8・13・20 |
| cash_entries | 直す・消す | 同上 | 直す前も後も status = draft。日付の月が締められていない | R-006-11〜13・20 |
| receipts | 読む | 持ち手の本人、`cash.manage` | 型 C1 | R-006-28 |
| receipts | 作る | 持ち手の本人、`cash.manage` | パスが `<tenant_id>/receipts/<id>.<拡張子>` | R-006-22・23 |
| receipts | 直す・消す | 同上 | 確認済み・締め済みの出入りから使われていない | R-006-27 |

- 変更の履歴は、お金の表なので小口と出入りに付ける（`audit: true`）。レシートは付けない（数が多い現場の記録）
- 判定の関数（`security definer`・`search_path` 固定）：`app.cash_balance(tenant, account)`、`app.cash_month_open(tenant, account, date)`（その月に締め済みの出入りがない）、`app.receipt_editable(tenant, receipt)`
- 置き場所は 001 の `tenant-files`（非公開）に、`<tenant_id>/receipts/` の下。置く権限は `field.record` か `master.edit`（スタッフも持つ）

## 3. 画面

| 画面 | パス | 主な操作 | 基準 |
|---|---|---|---|
| 小口（持ち手） | `/cash` | 自分の残高、出金の登録（金額・用途・日付・レシートの写真）、下書きの取り消し、送れていない件数 | R-006-6・10・34・35 |
| 小口の管理 | `/cash/manage` | 全員の出入りの一覧（月・小口で絞る）、確認（まとめて）、月の締め、入金の登録、CSV の書き出し | R-006-15〜19・30〜32・36 |

- 画面が使う処理は `apps/web/src/lib/cash/` にまとめる：入力の確かめ（`entry.ts`）、端末へのため方（`queue.ts`。001 の送り箱に `cash_entries`・`receipts` の行を入れる）、写真の端末へのため方と送り（`receiptQueue.ts`）、CSV（`csv.ts`）、Supabase への読み書き（`api.ts`）
- 送り箱の順は、レシートの行 → 出入りの行（出入りの外部キーが先に届かないように、作った順に送る）。画像は別の端末のための入れ物（IndexedDB の別の DB）にためて、電波が戻ったら置き場所に上げ、読み取りの Edge Function を呼ぶ
- Supabase のクライアントは 001 の `lib/supabase.ts` の1つ。今の会社と権限は、001 の `AuthProvider`（`useSession` 経由）から読む

## 4. サーバーの処理

DB の関数（RPC。`security definer`・`search_path` 固定。中で `has_perm` と行の会社・状況を確かめる）：

| RPC | 呼ぶ人 | 中身 | 基準 |
|---|---|---|---|
| `confirm_cash_entries(ids uuid[])` | `cash.manage` | 下書きを確認済みにし、確認した人と時刻を残す。確認済みは何もしない。見つからない ID があれば、何も変えずに断る | R-006-15〜17・21 |
| `close_cash_month(tenant, month, account default null)` | `cash.manage` | その月（日本時間の1日〜末日）の確認済みを締め済みにする。下書きが残っている月、まだ来ていない月は断る | R-006-18〜21 |
| `cash_holder_names(tenant)` | `cash.manage` | 小口の持ち手の表示名を返す（外部の人を除く）。所属の表は `user.manage` だけが読むので、小口の画面のために別に出す | R-006-37 |

Edge Function：

| 処理 | 呼ぶ時 | 中身 | 基準 |
|---|---|---|---|
| `read-receipt` | 画像を置いたあと、画面から | 操作した人の鍵で、レシートの行と画像を読み、`ReceiptReader`（差し替えられる読み取り）の結果を、同じ鍵でレシートに書く。初めの読み取りは「読み取らない」。外の読み取りが決まったら、`reader.ts` の1か所を差し替える | R-006-24〜26 |

## 5. CSV の列（会計ソフトに渡す形）

1行1件。UTF-8（BOM つき）・CRLF。

| 列 | 中身 |
|---|---|
| 日付 | `YYYY/MM/DD` |
| 小口 | 小口の名前 |
| 持ち手 | 持ち手の表示名 |
| 区分 | 入金・出金 |
| 金額 | 円の整数 |
| 用途 | 入力した用途 |
| レシート | あり・なし |
| 状況 | 確認済み・締め済み |
| 確認日 | `YYYY/MM/DD` |
| 建物ID | 空（002 のあとで、建物の名前の列を足す） |

## 6. テストの方法

| 基準 | テストの種類 | 置き場所 |
|---|---|---|
| R-006-1〜8・11〜29・33・37 | DB（pgTAP） | `supabase/tests/20_cash.sql`（権限・状況・締め・レシート）。全部の表の漏れは、`tests.seed()` に足した種で `02_leak_all_tables.sql` が流す |
| R-006-9 | DB（pgTAP） | `20_cash.sql` |
| R-006-10 | 単体（Vitest） | `apps/web/src/lib/cash/queue.test.ts` |
| R-006-24〜26 | 単体（Vitest） | `apps/web/src/lib/receipt/receipt.test.ts`（読み取りの中身の解析と差し替え） |
| R-006-30〜32 | 単体（Vitest） | `apps/web/src/lib/cash/csv.test.ts` |
| R-006-34・35・36 | 単体（Vitest） | `apps/web/src/lib/cash/entry.test.ts`（入力の確かめ・残高の見せ方・操作の出し分け） |

## 7. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| `cash_entries`・`receipts` に `holder_id` を足す（data-model には書いていない） | 型 C1 は持ち主の列が要る。出入りの持ち主は小口の持ち手と同じなので、組の外部キーで揃えて、持ち主を偽れないようにする | 出入りの持ち主を小口から毎回引く（policy が重くなる） |
| 持ち手の本人は、出金だけを登録できる | crud.md の006の行。持ち手が自分で残高を増やせないようにする | 持ち手も入金を書く |
| 出入りは、作る時も下書きだけ（RLS）。確認・締めは RPC | 「確認のあと直せない」を、画面から status を書けないことで守る | status を書き換える権限を管理者に与える |
| 締めた月への登録は RLS（`app.cash_month_open`）で止める | 締めたあとの数字を動かさない。締めの記録の表を増やさず、締め済みの行があるかで判定する | 締めの表を作る（表が増える） |
| 残高に下書きを含める。確認済み以上の残高を別の列で出す | 持ち手は手持ちを知りたい。管理者は確認した分を知りたい | どちらか1つ |
| 小口の削除は、RLS の with check で「残高が0」を確かめる | crud.md「残高が0のときだけ」。画面の直接の書き込みで済み、RPC を増やさない | 削除の RPC |
| 小口と出入りに履歴を付ける（型 C の既定を変える） | お金の記録。だれがいつ直したかを残す。数は多くない | 付けない（現場の記録の既定どおり） |
| レシートの画像は、行（読み取り待ち）を先に作り、画像は後から上げてよい | 電波のない間に撮れる。行の外部キーは出入りが先に届かないよう、作った順で送る。画像のない行は読み取り待ちのままで、害はない | 画像を上げてから行を作る（電波がないと撮れない） |
| レシートの読み取りは、操作した人の鍵で、同じ表に直接書く | 001 の決まり（会社のデータを書く Edge Function は人の鍵）。レシートの行は持ち手の本人が書ける | service_role で書く |
| 読み取りの初期の方法は「読み取らない」。解析の関数と差し替えの口だけ作る | 外の有料の読み取りは使わない（決める前）。キーも要らず、動く形でテストできる | 特定のサービスにつなぐ |
| CSV は画面（端末）で作る。管理者が RLS で読める行だけを元にする | 管理者の鍵で読んだ行だけが入る。サーバーの処理を増やさない | Edge Function で作る |
| CSV の先頭に BOM、改行は CRLF、式として動く先頭の文字には `'` を付ける | 表計算ソフトで文字化けしないように。式の混入を防ぐ（用途は人が入れる文字） | BOM なし |
| `work_id` は列だけ。外部キーは 012 のあと（`building_id` は 002 の取り込みで付けた） | 作業の表がまだない | 空の表を先に作る（002 と衝突する） |
| 持ち手の表示名は、cash.manage だけが呼べる RPC `cash_holder_names` で出す | 所属の表（型 E）は user.manage だけが読む。社員（cash.manage）が持ち手の名前を見られるようにする | 所属の表の policy を広げる（001 の決まりを変える） |
| Edge Function の読み取りの解析は `supabase/functions/_shared/receipt.ts`（Deno・Node に依存しない）に置き、Vitest から読む | Edge Function の中身を、実際に動かさずにテストできる | 画面側に同じものを置く（二重になる） |
| レシートの画像の縮小は、端末で長辺 1600px の JPEG にする | 送る量と置き場所の量を減らす。読み取りには十分 | 縮めない |
