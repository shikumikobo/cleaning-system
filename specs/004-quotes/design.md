# 機能004：見積（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（004 の章）が正で、ここは 004 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の `app.apply_policy`、使われ方の登録は [../002-clients-buildings/design.md](../002-clients-buildings/design.md) の `app.usage_refs`、お知らせは [../015-notifications/design.md](../015-notifications/design.md) の `app.enqueue_notification`。

## 1. 表

共通の列（`id`・`tenant_id`・作成と更新の人と時刻・`deleted_at`）と `unique (tenant_id, id)` は、data-model.md の1章のとおり。親への参照は `(tenant_id, 親の id)` の組。

| 表 | 型 | 列（共通の列を除く） | 制約・索引 | 基準 |
|---|---|---|---|---|
| `items` 品名の候補 | B | name、unit（既定「式」）、unit_price（0〜1億）、kind（`base`・`option`・`one_time`） | name は空でない。`(tenant_id, name)` は消していない行で一意 | R-004-1・2 |
| `quotes` 見積 | B＋D | client_id・building_id（組の外部キー）、request_id（**列だけ。外部キーなし**）、kind（`request`・`recurring`・`special`）、number、issue_date、valid_until、tax_rate（numeric(5,4)、0〜1、既定 0.1）、subtotal・tax・total（bigint）、status（`draft`・`submitted`・`approved`・`rejected`）、previous_id（組の外部キー）、note、submitted_at、decided_at・decided_by・decision_note | `total = subtotal + tax`。提出以降は number・issue_date・submitted_at が必須。承認・不成立は decided_at・decided_by が必須。`(tenant_id, number)` は番号がある行で一意。`(tenant_id, previous_id)` は、消していない行で一意（1つの元から直した版は1つ） | R-004-3・6・8・10・19 |
| `quote_lines` 明細 | B＋D | quote_id（組の外部キー）、item_id（組の外部キー、任意）、line_kind（`base`・`option`・`one_time`）、name、qty（numeric(10,2)、0 より大きく 100000 以下）、unit、unit_price（0〜1億）、**amount（生成列：`round(qty * unit_price)`）**、recurrence（RRULE。`FREQ=…` から始まる形の check）、sort | `(tenant_id, quote_id, sort)` の索引 | R-004-4・5 |

- **`request_id`**：003（案件）の表を並列で作っているので、列だけを置き、外部キーは付けない。003 の取り込みのときに、`quotes (tenant_id, request_id) → requests (tenant_id, id)` を足す（報告に書いた）
- **金額は生成列**：明細の `amount` は、DB が `数量 × 単価` から出す（画面や API から書けない）。画面が金額を計算し間違えても、DB の値は変わらない
- 合計は、提出の RPC が1回だけ計算して入れる。下書きの間の合計は 0（画面が明細から計算して見せる）
- data-model.md の表に **足した列**：`quotes.note`・`submitted_at`・`decided_at`・`decided_by`・`decision_note`、`quote_lines.sort`、`items` の `unit` の既定。data-model.md は直していない（報告に書いた）

## 2. 権限（RLS）

policy は `app.apply_policy` で型から作る。そのあと、004 の決まりに狭める。

| 表 | 呼び方 | 読める人 | 書ける人 |
|---|---|---|---|
| `items` | `apply_policy(表, 'B', {"write_perm":"quote.edit"})` | `amount.read`。運営は許可の間 | `quote.edit`（管理者・社員）。消すのは論理削除（`deleted_at` を直す） |
| `quotes` | `'B'`＋`lock_sql: status = 'draft'`＋`external_read: status in ('submitted','approved') and deleted_at is null and can_external_see_building` | 上に加えて、外部の人は許された建物の提出・承認だけ | `quote.edit`。直せるのは下書きの行だけ（`using` と `with check` の両方） |
| `quote_lines` | `'B'`＋`lock_sql: app.quote_is_draft(tenant_id, quote_id)`＋`external_read: app.quote_external_visible(...)` | `quotes` と同じ | `quote.edit`。見積が下書きの間だけ |

- **作れるのは、下書きで、番号・合計・決めた人・元の版がない行だけ**：型が作る `tp_insert` を、`status = 'draft'` かつ `number`・`issue_date`・`subtotal`・`tax`・`total`・`previous_id`・`submitted_at`・`decided_*` が空（0）の条件に作り直した（R-004-6）。明細の `tp_insert` は「見積が下書き」を足した（型の既定は insert に lock を付けないため）
- **直接書ける列を絞る**：`quotes` の update は `tenant_id`・`client_id`・`building_id`・`request_id`・`kind`・`valid_until`・`tax_rate`・`note`・`deleted_at` だけ。`status`・`number`・`issue_date`・`subtotal`・`tax`・`total`・`previous_id`・`submitted_at`・`decided_*` は書けない（権限なし 42501）。`quote_lines` は `quote_id`（付け替え）と `amount` を除く（R-004-4・6）。`tenant_id` を残すのは、002 と同じ理由（行の会社を変えるトリガーが止め、型の漏れのテストも使えるため）
- **提出のあとの固定**：状況が下書きでなくなれば、`lock_sql` で更新が 0 行になる。消す（`deleted_at`）のも同じ update なので、提出後は消せない（R-004-7・14）
- 判定の関数 `app.quote_is_draft`・`app.quote_external_visible` は security definer・`search_path` 固定。外部の人が見積の行を読めるかを、`quotes` の policy を通さず確かめる
- 外部の人は品名の候補を読めない（型 B で外部の条件を付けない）。運営は、許可の間だけ読める（型の共通の仕組み）

## 3. サーバーの処理（RPC）

すべて `security definer`・`search_path` 固定。会社は行から引き、`quote.edit` を `app.require_perm` で確かめる（行が見つからない・消えている・権限がないは、同じ 42501）。`app.mark_rpc()` で履歴の source を `rpc` にする。行は `for update` で押さえる。戻りは jsonb。業務の決まりで断るときは、例外ではなく `{ok:false, reason}`。

| RPC | 中身 | 断る理由（reason） | 基準 |
|---|---|---|---|
| `submit_quote(p_id)` | 下書きの明細（消していないもの）の金額を足して小計、`floor(小計 × 税率)` を税、合計を入れる。`app.next_doc_no(会社, 'quote', 日本時間の年)` で番号 `Q-西暦-4桁`。issue_date は日本時間の今日、valid_until が空なら +30 日。直した版なら、元が「提出」のままのとき元を「不成立」（理由：改訂版に置き換え）にする。すでに「提出」なら `{ok:true, already:true}` と前の番号・合計 | `no_lines`・`valid_until_before_issue`・`recurring_needs_base`・`recurrence_missing`・`recurrence_not_allowed`・`not_draft`（承認・不成立のもの） | R-004-8〜13・20 |
| `approve_quote(p_id)` | 提出 → 承認。decided_at・decided_by を入れる。外部でなく有効な所属（承認した本人を除く）のそれぞれに `app.enqueue_notification(… 'quote_approved', 題名 '見積が承認されました：番号', 本文, '/quotes/edit/?id=…', 'quote_approved:<id>')`。金額を見る権限のない所属には 0 が返り、何も作られない。すでに承認なら `{ok:true, already:true}`（お知らせは作らない） | `not_submitted` | R-004-15・17・18 |
| `reject_quote(p_id, p_note)` | 提出 → 不成立。理由は任意（空は null）。すでに不成立なら `{ok:true, already:true}` | `not_submitted` | R-004-16・18 |
| `revise_quote(p_id)` | 提出済み・不成立 → `previous_id` に元を入れた新しい下書き（取引先・建物・案件・種類・税率・備考を引き継ぎ、消していない明細を写す）。すでに下書きの直しがあれば `{ok:true, already:true, id}` | `not_revisable`（下書き・承認済み）・`already_revised`（直した版がすでに提出されている） | R-004-19 |

- お知らせの種類 `quote_approved`（見積の承認。初めの値は通知・メールとも入、要る権限は `amount.read`）は、015 のマイグレーションに**すでに入っている**。004 では足していない
- お知らせは、承認と同じトランザクションの中で「送る前」を作るだけ（送るのは 015 の Edge Function）
- 番号の振り直し：`app.next_doc_no`（001）は `document_counters` を `on conflict … last_no + 1` で進める。提出が途中で失敗すれば、同じトランザクションなので番号も戻る（欠番を作らない）。断る場合は、番号を振る前に返す

## 4. 使われているものは消さない

002 の `app.usage_refs` に2行を足す（`reason = has_quotes`）：

| parent | action | 子 | 条件 |
|---|---|---|---|
| client | block | quotes | `client_id = $2` |
| building | block | quotes | `building_id = $2` |

消していない見積が1つでもあれば、取引先・建物は消せない（下書きは、先に消す）。`masters/format.ts` の文面に `has_quotes` を1行足した。

## 5. 画面

`apps/web/src/app/quotes/`。静的書き出しに合うよう、パスは固定で行の ID は `?id=` で渡す。スマホの幅で使える（明細の表は、狭い幅では縦に並べる）。

| 画面 | パス | 主な操作 | 基準 |
|---|---|---|---|
| 見積の一覧 | `/quotes/` | 番号・取引先・建物で探す、状況で絞る、見積を作る（`quote.edit` のときだけ） | R-004-31 |
| 見積の作成・編集 | `/quotes/edit/?id=` | 取引先・建物・種類・税率・有効期限・備考。下書きの間は明細の追加・直す・消す（品名の候補から写す。定期の見積は頻度を選ぶ）。合計は画面で計算（提出後は DB の確定した値）。提出・承認・不成立・直した版を作る・下書きを消す。提出できない理由は、押したときに日本語で出す | R-004-3〜5・8・11・12・15〜20・27〜29・31 |
| 品名の候補 | `/quotes/items/` | 一覧・追加・直す・消す | R-004-1・2 |
| 見積書の印刷 | `/quotes/print/?id=` | A4 の見積書。「印刷する」で画面の印刷（PDF に保存もここから）。ヘッダー・操作は印刷に出ない | R-004-30 |

- 画面の中身は、`apps/web/src/lib/quotes/` の純粋な関数と、Supabase を呼ぶ薄い層（`repo.ts`）に分ける。関数は Vitest で確かめる
  - `calc.ts`：明細の金額・合計（BigInt の整数だけ。DB と同じ答え）
  - `rrule.ts`：RRULE の日本語訳・画面で選んだ頻度からの作成・画面の選択へ戻す
  - `validate.ts`：入力の検査と、提出できない理由の先調べ
  - `format.ts`：ラベル・金額・日付・税率・一覧の検索・RPC が断った理由の文面
  - `print.ts`：見積書の中身（会社の情報・登録番号・明細・合計）
- 会社（tenant_id）は、001 の `useSession` が持つ「今の会社」から読む。Supabase のクライアントは 001 の `lib/supabase.ts` の1つ。権限の出し分け（`quote.edit` を持たなければ操作を出さない）は見せ方のためだけで、判定は DB が行う
- 印刷の CSS は `components/quotes/quotes.css`（`@page { size: A4; margin: 18mm; }`、本文 `"BIZ UDPGothic", "Yu Gothic", "Meiryo", sans-serif`、金額の表 `"BIZ UDGothic"`）。`@media print` で `.app-header`・`.q-noprint` を隠す
- 見積書の登録番号は、`tenants.invoice_reg_no`（001）。未登録なら行を出さない。会社の情報は、001 の型 E の policy で、所属する全員が自分の会社の行を読める

## 6. 繰り返し（RRULE）

- DB に入れるのは、`FREQ=…` から始まる RRULE の文字列（`RRULE:` は付けない）。DB の check は形だけを見る
- 画面で選べるのは4つ：毎週◯曜（複数の曜日・N 週間に1回）、毎月第◯◯曜（第1〜4・最終）、毎月◯日（1〜31・月末）、◯か月に1回。選んだものを `buildRrule` で文字列にし、`rruleToJa` で「毎月 第2火曜」のように訳して見せる（`parseRecurrence` で選択に戻せる）
- 訳せない形（`BYSETPOS`・`COUNT`・`UNTIL` など）は、元の文字列をそのまま見せる。保存はできる
- 契約（010）が予定を作るときに、この RRULE を使う（ここでは文字列を持つだけ）

## 7. 合計の突き合わせ（R-004-29）

- 共通のテストのデータ：`supabase/tests/fixtures/quote_totals.json`（10 ケース：端数・小数の数量・税率 8%・大きな金額・明細ごとに税をかけない例）
- DB の側：`tools/pglite/quote-totals.mjs` が、PGlite にマイグレーションと種を入れ、ケースごとに下書きを作って `submit_quote` を呼び、DB が出した小計・税・合計を JSON で出す
- 画面の側：`apps/web/src/lib/quotes/parity.test.ts` が、上のスクリプトを子プロセスで動かし、その出力・画面の `calcQuote`・データの期待値の3つが全ケースで同じであることを確かめる（`pnpm test` に入る）

## 8. テストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-004-1〜26 | DB（pgTAP。PGlite でも流す） | `supabase/tests/21_quotes.sql` |
| 他の会社への漏れ・構造・型の付け忘れ | DB（登録された全部の表に流す） | `02_leak_all_tables.sql`・`01_structure.sql`（`tests.seed()` に 004 の種を足した） |
| R-004-27〜28・30・31 の部品 | 単体（Vitest） | `apps/web/src/lib/quotes/quotes.test.ts` |
| R-004-29 | 単体（Vitest。DB を PGlite で動かして比べる） | `apps/web/src/lib/quotes/parity.test.ts` |
| R-004-8・11・21・29・30・31 の画面の流れ | 画面（Playwright + Edge。見積の表は、このテストが自分で偽の接続先を受ける） | `apps/web/e2e/quotes.e2e.ts` |

- 画面と実際の Supabase との通信は、実際の Supabase が動くまで確かめられない（001 の画面の流れのテストと同じ制約）
- 種（`tests.seed_004()`）は専用の取引先・建物（A4・B4）に作る。002 の「消せるか」のテストを変えないため、既存の取引先・建物（A1 ほか）には見積を付けない

## 9. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 見積番号は `Q-<西暦>-<4桁>`、会社ごと・年ごと（日本時間の年） | `document_counters` が会社・種類・年ごと。ひと目で見積と分かる | 年なしの通し番号 |
| 建物は必須（`building_id` not null） | 外部の人に見せる条件が建物のため。取引先だけの見積は、外部の人に見えない行になる | 建物を空にできる（外部の見え方を別に決める必要） |
| 税率は帳票ごとに小数（0〜1）で持つ。画面は % | 税率が変わっても、出した帳票は変わらない。BigInt で 1 万分の 1 の整数にして計算 | 税率の表を別に持つ |
| 明細の金額は生成列 | 画面が計算し間違えても DB の値は変わらず、直接書けない | 画面が計算して書く（食い違う） |
| 定期の見積の合計は、全部の明細の金額の単純な合計（基本の月額＋オプション1回分＋単発）に税を1回かける | 期間ごとの総額は契約（010）が決める。1枚の見積書の合計として一貫する | 基本だけを合計にする（オプションが合計に入らない） |
| 有効期限が空なら提出の日から 30 日 | 見積書に有効期限がないと、取引先に伝わらない | 空のまま |
| 直した版を提出したら、元の「提出」を「不成立」（理由つき）にする | 有効な見積を1つにする。状況の値を増やさない（data-model.md の4つのまま） | 元は「提出」のまま（2つとも承認できてしまう） |
| 直せるのは「提出」「不成立」から。「承認」からは直せない | 承認は契約（010）の元になる。承認後の変更は契約の変更で行う | 承認からも直せる |
| 1つの元から直した版は1つだけ（部分一意索引） | 二重の改訂を防ぐ。同じ元からもう一度呼ぶと、その下書きを返す | 何版でも作れる |
| 業務の決まりで断るときは `{ok:false, reason}`（例外にしない） | 画面が日本語の理由を出せる（002 の消す RPC と同じ） | 例外のメッセージ |
| 承認のお知らせは、承認した本人を除く、外部でない有効な所属に作る。受け取れるかは `enqueue_notification` の権限の確かめ（`amount.read`）に任せる | 本人に知らせる必要がない。権限の判定を1か所に保つ | 管理者だけに知らせる |
| 下書きを消すのは論理削除（update）。提出後は消せない | `authenticated` に delete の権限がない決まり（001）。提出後の固定は RLS の1行 | 消す RPC |
| 見積と明細の履歴を付ける（型 B の既定） | 金額のデータなので、だれがいつ直したかを残す | 付けない |
| 外部の人が見積を作った人の名前を読む仕組みは、ここでは作らない | 001 の `app.can_see_profile` を直す必要があり、009（報告書）と一緒に決めたほうがよい | 004 で `can_see_profile` を広げる（並列の機能と競合） |
| 見積の PDF は、画面の印刷（ブラウザの「PDF に保存」）。サーバーで PDF を作らない | 仕様どおり。フォントは端末のものが使われる（BIZ UD が入っていなければ Yu Gothic など） | Edge Function で PDF を作る |
