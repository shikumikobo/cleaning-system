# 機能011：請求（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（011 の章）が正で、ここは 011 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の `app.apply_policy`、使われ方の登録は [../002-clients-buildings/design.md](../002-clients-buildings/design.md) の `app.usage_refs`、合計と税の計算は [../004-quotes/design.md](../004-quotes/design.md)、契約の中身・作業の金額は [../010-contracts/design.md](../010-contracts/design.md)、お知らせの種類は [../015-notifications/design.md](../015-notifications/design.md)。

## 1. 表

共通の列（`id`・`tenant_id`・作成と更新の人と時刻・`deleted_at`）と `unique (tenant_id, id)` は、data-model.md の1章のとおり。親への参照は `(tenant_id, 親の id)` の組。

| 表 | 型 | 列（共通の列を除く） | 制約・索引 | 基準 |
|---|---|---|---|---|
| `invoices` 請求書 | B | client_id（組の外部キー）、period（請求する月の1日。check）、number、issue_date、due_date、tax_rate（numeric(5,4)、0〜1、既定 0.1）、subtotal・tax・total（bigint）、status（`draft`・`issued`・`sent`・`partial`・`paid`・`cancelled`）、previous_id（取り消した請求書。組の外部キー）、note、issued_at、sent_at、cancelled_at、cancel_reason | `total = subtotal + tax`。下書き以外は番号・発行日・期日・発行日時が必須。期日は発行日以後。`unique (tenant_id, client_id, period) where deleted_at is null and status <> 'cancelled'`（取引先ごとに月1枚）。`(tenant_id, number)` は番号がある行で一意。`(tenant_id, previous_id)` は消していない行で一意 | R-011-4・8・14〜17 |
| `invoice_lines` 明細 | B | invoice_id（組の外部キー）、service_key＋service_month、work_id（組の外部キー→`works`）、request_id（組の外部キー→`requests`）、name、qty（numeric(10,2)、0 より大きく 100000 以下）、unit、unit_price（bigint）、**amount（生成列：`round(qty * unit_price)`）**、sort | 元はどれか1つ（check。契約の中身は `service_key` と `service_month` の両方）。`service_month` は月の1日。**同じ元を二度請求しない**：`unique (tenant_id, service_key, service_month)`・`unique (tenant_id, work_id)`・`unique (tenant_id, request_id)`、どれも `where … is not null and deleted_at is null` | R-011-1〜3・5・13 |
| `payments` 入金 | B | invoice_id（組の外部キー）、paid_on、amount（bigint、0 より大きい）、note | `(tenant_id, invoice_id)` の索引（消していない行） | R-011-22〜24 |

- **010 との列名の合意**：010 の `service_invoiced`（契約の中身が請求書に載った月以降か）・`work_charge_locked`・003 の `request_charge_locked` は、`invoice_lines` の列 `service_key`・`service_month`・`work_id`・`request_id`・`deleted_at` を前提にしている。**その列名のまま作った**ので、010・003 の関数は直していない（表ができた時点で効く）。`service_month` は日付（月の1日）で、010 の `left(service_month::text, 7)` の比べ方とそのまま合う
- 003・010 は取り込み済みなので、明細の `work_id`・`request_id` には外部キーを付けた。並列の 009（報告書）・014（取り込み）の表への外部キーは、この機能にはない
- **金額は生成列**：明細の `amount` は、DB が `数量 × 単価` から出す。画面は数量だけを直せ、単価と金額は書けない
- `previous_id` は、取り消した請求書を指す（出し直した下書きに入る）。1つの取り消した請求書から、消していない出し直しは1つだけ
- data-model.md の表に **足した列**：`invoices.note`・`issued_at`・`sent_at`・`cancelled_at`・`cancel_reason`、`invoice_lines.qty`・`unit`・`sort`、`payments` の共通の列のほか変更なし。data-model.md は直していない（報告に書いた）

## 2. 権限（RLS）

policy は `app.apply_policy` で型から作る。そのあと、011 の決まりに狭める。

| 表 | 呼び方 | 読める人 | 書ける人 |
|---|---|---|---|
| `invoices` | `'B'`（`write_perm: invoice.edit`、`lock_sql: status = 'draft'`）。型が作る insert の policy と権限は取り除く | `amount.read`。運営は許可の間 | 直せるのは下書きの行の `due_date`・`tax_rate`・`note` だけ。作る・状況・番号・発行日・合計・前の版・消すのは RPC だけ |
| `invoice_lines` | `'B'`（`lock_sql: app.invoice_is_draft(tenant_id, invoice_id)`）。insert の policy と権限は取り除く | 同じ | 請求書が下書きの間だけ、`name`・`qty`・`unit`・`sort`・`deleted_at`（外す）を直せる。作る・元・単価・金額は書けない |
| `payments` | `'B'`（`write_perm: invoice.edit`）。insert・update の policy と権限は取り除く | 同じ | RPC だけ |

- 読めるのは `amount.read` を持つ人だけ（スタッフ・外部の人・運営は読めない）。外部の人に見せる型 D は付けない
- 判定の関数 `app.invoice_is_draft` は security definer・`search_path` 固定
- **view `invoice_balances`**（`security_invoker`）：請求書ごとの入金額（`paid`）と残高（`balance`）。見る人の権限で絞られる
- 請求書に載った案件の金額・作業の金額・契約の中身を直せなくする仕組みは、003・010 がすでに持つ関数（`request_charge_locked`・`work_charge_locked`・`service_invoiced`）で、`invoice_lines` に消していない行がある間は効く。**下書きの明細に載っている間も効く**（下書きを消すか、明細を外せば、また直せる）

## 3. サーバーの処理（RPC）

すべて `security definer`・`search_path` 固定。会社は行から引き（下書きを作る RPC だけは引数の会社）、`invoice.edit` を `app.require_perm` で確かめる（行が見つからない・消えている・権限がないは、同じ 42501）。`app.mark_rpc()` で履歴の source を `rpc` にする。行は `for update` で押さえる。戻りは jsonb。業務の決まりで断るときは、例外ではなく `{ok:false, reason}`。

| RPC | 中身 | 断る理由（reason） | 基準 |
|---|---|---|---|
| `create_invoice_drafts(p_tenant, p_period, p_client_id)` | 3章下の「下書きを作る」 | `period_required` | R-011-1〜9 |
| `issue_invoice(p_id, p_issue_date)` | 下書きの明細（消していないもの）の金額を足して小計、`floor(小計 × 税率)` を税、合計を入れる。`app.next_doc_no(会社, 'invoice', 発行日の年)` で番号 `I-西暦-4桁`。発行日は日本時間の今日（指定もできる）。期日が空なら請求月の翌月末（それが発行日より前なら発行日＋30日）。すでに発行以降なら `{ok:true, already:true}` と前の番号・合計 | `no_lines`・`zero_total`・`due_before_issue`・`not_draft`（取消） | R-011-14〜17 |
| `mark_invoice_sent(p_id)` | 発行 → 送付（`sent_at`）。送るのは人で、メールは送らない。すでに送付なら `already` | `not_issued`（下書き・取消）・`has_payments`（一部入金・入金済み） | R-011-19 |
| `cancel_invoice(p_id, p_reason)` | 発行・送付 → 取消。`cancelled_at`・理由を入れ、明細に `deleted_at` を入れる。番号は残る。すでに取消なら `already` | `draft`・`has_payments` | R-011-20 |
| `delete_invoice(p_id)` | 下書きだけ、請求書と明細を論理削除 | `not_draft` | R-011-12 |
| `record_payment(p_invoice_id, p_paid_on, p_amount, p_note)` | 入金を足し、状況を `app.invoice_recalc` で決め直す（合計に達すれば `paid`、入金があれば `partial`、なければ送付済みか `issued`） | `not_issued`（下書き）・`cancelled`・`invalid_amount`・`paid_on_required`・`overpaid` | R-011-22・23 |
| `update_payment(p_id, p_paid_on, p_amount, p_note)` | 入金を直し、状況を決め直す（自分の分を除いた合計で `overpaid` を見る） | `cancelled`・`invalid_amount`・`paid_on_required`・`overpaid` | R-011-24 |
| `delete_payment(p_id)` | 入金を論理削除し、状況を決め直す | `cancelled` | R-011-24 |

- 入金の RPC は、請求書の行を先に `for update` で押さえてから入金の行を扱う（同時に2つの入金を記録しても、合計を超えない）
- 状況の決め直し `app.invoice_recalc` は中の関数（誰にも実行を渡さない）

### 下書きを作る（`create_invoice_drafts`）

月は、その月の1日に直す。元の探し方は中の関数 `app.invoice_candidates(会社, 月, 取引先)` に集め、まだ明細に載っていないものだけを、取引先ごとに返す。

| 元 | 条件 | 金額・品名・単位 |
|---|---|---|
| 契約の中身（毎月請求） | 契約の中身（`billing = monthly`、金額が 0 より大きい）で、その月に有効（開始日がその月の末日以前、終了日が空かその月の1日以後）。契約の開始日がその月の末日以前、契約の終了日が空かその月の1日以後。同じ `service_key` の行が複数あるときは、**月の1日に有効な行**（なければ、その月で最初に始まる行）の1行 | 金額＝中身の金額。品名＝建物の名前と中身の名前。単位「月」。元は `service_key` と月 |
| 作業の金額 | 契約の作業（`contract_service_id` あり）で、状況が `done`・消していない・予定の日がその月。作業の金額（`work_charges`）が 0 より大きい | 品名＝建物の名前・作業の名前・（月/日）。単位「回」。元は作業 |
| 案件の金額 | 案件が `done`・消していない、金額（`request_charges`）が請求する（`billable`）で 0 より大きい。案件を作った日（日本時間）がその月の末日以前 | 品名＝建物の名前と案件の題名。単位「式」。元は案件 |

- 取引先は、契約の取引先、案件の取引先（`requests.client_id`）。建物をまたいで、取引先ごとに1枚
- 取引先ごとに、取消でない請求書を探す：なければ新しい下書きを作る（`previous_id` は、その月の取り消した請求書のうち、まだ出し直しのないもの）。**下書きなら**、新しく出てきた元だけを足す（並びは、月額・作業・案件の順）。**発行以降なら**、足さずに「飛ばした」と数える
- 明細の追加は `on conflict do nothing`（二重の一意の索引が最後の守り）。戻りは `{ok, period, created, added, locked, ids}`
- 契約の作業でない作業（案件を元にした作業。`contract_service_id` が空）の作業の金額は、請求しない（案件の金額で請求するため、二重にならない）

## 4. 使われているものは消さない

002 の `app.usage_refs` に、取引先の `invoices`（`client_id = $2`、理由 `has_invoices`）がすでにある。011 の `client_id` 列と合うので、**行は足していない**。取消でない・消していない請求書が1つでもあれば、取引先は消せない（取消も、消していなければ数える）。お知らせの種類 `invoice_overdue`（入金の遅れ。要る権限 `amount.read`）は、015 が初めから登録しているので、**足していない**。

## 5. 画面

`apps/web/src/app/invoices/`。静的書き出しに合うよう、パスは固定で行の ID は `?id=` で渡す。スマホの幅で使える。

| 画面 | パス | 主な操作 | 基準 |
|---|---|---|---|
| 請求の一覧 | `/invoices/` | 月を選んで下書きを作る（`invoice.edit` のときだけ）。番号・取引先・状況・月で探す。期日超過の印。会計ソフト用の CSV（請求書・明細） | R-011-34〜36 |
| 請求書 | `/invoices/edit/?id=` | 下書き：税率・期日・備考、明細の品名・数量・単位の直しと外す、合計（画面で計算）、発行日を決めて発行、下書きを消す。発行以降：送付の記録・取消、入金の記録・直す・消す、入金額と残高。印刷へ | R-011-36 |
| 請求書の印刷 | `/invoices/print/?id=` | A4 の請求書（インボイスの書き方）。「印刷する」で画面の印刷。ヘッダー・操作は印刷に出ない | R-011-33 |

- 画面の中身は、`apps/web/src/lib/invoices/` の純粋な関数と、Supabase を呼ぶ薄い層（`repo.ts`）に分ける。関数は Vitest で確かめる
  - `calc.ts`：見積と同じ BigInt の計算（税は1回、切り捨て）
  - `print.ts`：請求書の中身（会社・登録番号・税率ごとの対象額と消費税）。下書きは画面で計算し、発行以降は DB の確定値
  - `csv.ts`：会計ソフトの CSV（UTF-8・BOM・CRLF・引用符・数式の無害化）
  - `format.ts`：状況・期日超過・入金額と残高・絞り込み・RPC が断った理由の文面
  - `validate.ts`：月・税率・期日・明細・入金の検査
- 会社（tenant_id）は、001 の `useSession` が持つ「今の会社」から読む。Supabase のクライアントは 001 の `lib/supabase.ts` の1つ。権限の出し分け（`invoice.edit` を持たなければ操作を出さない）は見せ方のためだけで、判定は DB が行う
- 印刷の CSS は、見積と同じ `components/quotes/quotes.css`（A4・`BIZ UDPGothic`・金額の表 `BIZ UDGothic`・`@media print`）を使う
- **CSV の出し方**：一覧で絞り込んだもののうち、発行・送付・一部入金・入金済みだけを、請求書ごとに1行（番号・発行日・支払期日・取引先・請求月・税率・小計・消費税・合計・入金額・残高・状況）と、明細ごとに1行（番号・請求月・取引先・品名・数量・単位・単価・金額・税率）にする。画面で作って保存する（サーバーに送らない）

## 6. テストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-011-1〜31 | DB（pgTAP。本物の Postgres を Docker で） | `supabase/tests/23_invoices.sql` |
| 他の会社への漏れ・構造・型の付け忘れ | DB（登録された全部の表に流す） | `02_leak_all_tables.sql`・`01_structure.sql`（`tests.seed()` に 011 の種を足した。`00002_seed_011.sql`） |
| R-011-32 | 単体（Vitest）と DB | `apps/web/src/lib/invoices/invoices.test.ts`（`supabase/tests/fixtures/invoice_totals.json`）と `23_invoices.sql`（同じ数字の `mkcase`） |
| R-011-33〜36 の部品 | 単体（Vitest） | `apps/web/src/lib/invoices/invoices.test.ts` |
| R-011-33〜36 の画面の流れ | 画面（Playwright + Edge。請求の表は、このテストが自分で偽の接続先を受ける） | `apps/web/e2e/invoices.e2e.ts` |

- 画面と実際の Supabase との通信は、実際の Supabase が動くまで確かめられない（001 の画面の流れのテストと同じ制約）
- 種（`tests.seed_011()`）は専用の取引先（A11・B11）に作り、明細の元は契約の中身の鍵だけを使う。契約・作業・案件を元にした下書きの確かめは、`23_invoices.sql` の中で用意する（002・003・010 のテストを変えないため）
- 003（`21_requests.sql`）・010（`22_contracts.sql`）・002（`20_clients_buildings.sql`）のテストが使っていた仮の `invoice_lines`・`invoices` は、本物ができたので外し、本物の表で確かめる形にした

## 7. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 税は請求書1枚に1回、`floor(小計 × 税率)`。税率は請求書ごとに持つ（既定 10%） | constitution.md。明細ごとに税をかけると、端数がずれる。税率が変わっても、出した請求書は変わらない | 明細ごとに税（合計が見積・会計とずれる）、四捨五入 |
| 契約の途中で金額が変わった月は、日割りにしない。月の1日に有効な中身の金額（なければ、その月で最初に始まる中身の金額）。手で日割りにしたいときは、下書きの明細の数量（0.5 など）を直す | data-model.md は「どちらにもできる」としていた。自動の日割りは、日数の数え方（暦日・稼働日）が会社ごとに違う。数量を直せば、同じ月の中で人が決められる | 自動で日割り（日数の決めが要る） |
| 案件の金額は、案件を作った日がその月の末日以前の、まだ載っていない完了済みのものを載せる | 案件に完了日の列がない（003）。月に縛ると、完了が遅れた案件を請求し損ねる。二重は、一意の索引が防ぐ | 完了日の列を 003 に足す（003 の変更が要る） |
| 作業の金額は、予定の日がその月で、状況が完了のものだけ。過去の月の取りこぼしは、その月の下書きを作ると入る | 仕様の「その月に行った」。取り込みの古い作業が、最初の月に全部載るのを避ける | 完了した未請求を全部載せる（古い作業が載る） |
| 契約を元にしない作業（案件の作業）の作業の金額は、請求しない | 案件は案件の金額（`request_charges`）で請求する。二重にならない | 作業の金額も載せる |
| 取引先ごとに、建物をまたいで1枚。品名に建物の名前を付ける | data-model.md（取引先ごとに月1枚）。管理会社は建物ごとの内訳が欲しい | 建物ごとに1枚（月1枚の決まりと合わない） |
| 同じ取引先・月に発行済みの請求書があれば、足さずに飛ばす（数を返す）。直すときは取り消して出し直す。下書きがあれば、新しく出てきた元だけを足す。下書きから外した明細の元は、次に下書きを作ったときにまた入る | 発行した請求書は直せない（仕様）。外した元を覚える別の表を作らない（data-model.md の表のまま）。請求しない元は、案件の「請求する」の印・金額 0 で外す | 外した元を覚える（除外の表が要る） |
| 取消は、状況を `cancelled`、明細に `deleted_at`。出し直しの下書きは `previous_id` で結ぶ。番号は使い回さない | data-model.md。明細が空くので出し直せる。番号を残すので、欠番にならず、取消の履歴になる | 取消で番号を空ける（帳票の番号が重なる） |
| 入金のある請求書は取り消せない（先に入金を消す） | 入金と取消が同時にあると、残高の意味が壊れる | 入金も一緒に消す |
| 状況は、入金の合計から RPC の中で決め直す（`app.invoice_recalc`）。入金の直す・消すでも戻る | data-model.md。同じ中で変えるので、画面の数字と食い違わない | 画面が状況を書く（食い違う） |
| 入金が請求の合計を超える記録は断る | 過入金の扱い（返金・次の月へ）は人が決める。システムが勝手に持ち越さない | 超えてもよい（残高が負になる） |
| 期日が空なら請求月の翌月末（それが発行日より前なら発行日の30日後）。発行日は日本時間の今日（指定もできる） | 月末締め翌月末払いが多い。取引先ごとの支払条件（`payment_terms`）は文字で、読めない | 支払条件を読む（文字の決まりが要る） |
| 番号は `I-<西暦>-<4桁>`、会社ごと・年ごと（発行日の年） | 見積と同じ形。`document_counters`（001）の `invoice` が会社・種類・年ごと | 年なしの通し番号 |
| 送付は、人が送った日時を記録するだけ。システムはメールを送らない | 範囲の外（requirements の 4章）。送付の自動化は、メール送付の機能が決まってから | メールを送る |
| 請求書の印刷は、見積と同じ画面の印刷（PDF に保存）。サーバーで PDF を作らない | constitution.md の決まりに合わせる。フォントは端末のものが使われる | Edge Function で PDF を作る |
| CSV は画面で作る（UTF-8・BOM・CRLF）。数式の先頭の文字は無害にする | データは RLS で絞られた画面の中のものだけで足りる。Excel で開いても、文字化けや数式の実行が起きない | サーバーで CSV を作る |
| 請求書と明細と入金に履歴を付ける（型 B の既定） | 金額のデータなので、だれがいつ直したかを残す | 付けない |
| 入金の遅れのお知らせは作らない（種類 `invoice_overdue` は 015 に登録済み） | 波 6（要件の範囲の外） | 011 で定時の処理を作る |
