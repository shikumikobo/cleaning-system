# 機能010：清掃の契約・定期と単発（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（010・012 の章）が正で、ここは 010 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の `app.apply_policy`、使われ方の登録は [../002-clients-buildings/design.md](../002-clients-buildings/design.md) の `app.usage_refs`、明細の繰り返しは [../004-quotes/design.md](../004-quotes/design.md) の6章。

## 1. 表

共通の列（`id`・`tenant_id`・作成と更新の人と時刻・`deleted_at`）と `unique (tenant_id, id)` は、data-model.md の1章のとおり。親への参照は `(tenant_id, 親の id)` の組。

| 表 | 型 | 列（共通の列を除く） | 制約・索引 | 基準 |
|---|---|---|---|---|
| `contracts` 契約 | B | client_id・building_id・quote_id（組の外部キー。quote_id は任意）、source（`quote`・`import`）、kind（`recurring`・`one_time`）、start_date、end_date、status（`active`・`ended`） | 元が見積なら quote_id 必須、取り込みなら空。終了日は開始日以後。終了なら終了日が必須。`(tenant_id, quote_id)` は消していない行で一意（1つの見積から1つ） | R-010-1・3・4 |
| `contract_services` 清掃の中身 | B | contract_id（組の外部キー）、service_key、service_kind（`base`・`option`・`special`）、name、amount（0〜1000億）、billing（`monthly`・`per_visit`）、recurrence（RRULE の形の check）、start_time・end_time、report_template_id（**列だけ**。009 のひな形）、valid_from、valid_to | `(tenant_id, service_key)` で、今の行（valid_to が空・消していない）は1つ。valid_to は valid_from 以後。時刻は終了が開始より後 | R-010-2・13 |
| `contract_service_staff` 決まった担当 | A | contract_service_id・membership_id（組の外部キー） | `(tenant_id, contract_service_id, membership_id)` は消していない行で一意 | R-010-20 |
| `works` 作業 | A＋D | building_id・contract_service_id・request_id・run_id（`job_runs` への組の外部キー）、service_key、title、report_template_id（**列だけ**）、scheduled_date、start_time・end_time、status、version | 契約の中身か案件のどちらか1つ（check）。`unique (tenant_id, service_key, scheduled_date) where run_id is not null and deleted_at is null`（定時の処理が二度動いても重ならない） | R-010-7〜9・21・23 |
| `work_charges` 作業の金額 | B | work_id（組の外部キー）、amount | 1つの作業に1つ（消していない行で一意） | R-010-10・22 |
| `work_assignments` 担当（最小） | A | work_id・membership_id（組の外部キー） | `(tenant_id, work_id, membership_id)` は消していない行で一意 | R-010-9・21 |

- **`report_template_id`**：009（報告書）を並列で作っているので、列だけを置き、外部キーは付けない。009 の取り込みのときに足す（報告に書いた）
- **`works.request_id`**：003 の `requests` の組の外部キーを付けた（003 は取り込み済み）。案件を元にした作業を作る RPC は 012 が持つ。010 は、案件を元にした行が入れられる形だけを守る
- **`works` の `version`**：2人が別々に直す表（data-model.md の1章）。010 では更新の画面がなく、012 が使う
- 担当の表 `work_assignments` は、予定の作成が初めの担当を入れるための最小。割り当ての画面・実績は 012

## 2. 権限（RLS）

policy は `app.apply_policy` で型から作る。そのあと、010 の決まりに狭める。

| 表 | 呼び方 | 読める人 | 書ける人 |
|---|---|---|---|
| `contracts`・`contract_services` | `'B'`（`write_perm: contract.edit`）。型が作る insert・update の policy と権限は取り除く | `amount.read`。運営は許可の間 | RPC だけ（R-010-18） |
| `contract_service_staff` | `'A'`（`write_perm: contract.edit`、`read_scope: app.is_owner_membership(...)`） | 会社の中の人。スタッフは自分の行だけ | `contract.edit`。担当にできるのは同じ会社の社内の人だけ（`app.request_assignee_ok`） |
| `works` | `'A'`（`write_perm: work.assign`）＋`lock_sql: status = 'scheduled'`＋`read_scope: app.is_assigned_to_work(...)`＋`external_read: deleted_at is null and app.can_external_see_building(...)` | `work.assign`（全部）／スタッフ（担当の作業）／外部（許された建物の作業） | 直接直せるのは、予定の間の時刻だけ。作る・状況・日付・消すのは RPC だけ |
| `work_charges` | `'B'`＋作る・直すに `contract.edit` と `amount.read` の両方 | `amount.read` | 上に同じ。請求書に載ったら直せない |
| `work_assignments` | `'A'`（`write_perm: work.assign`） | 会社の中の人。スタッフは自分の行だけ | `work.assign` |

- **列の権限を絞る**：`works` の update は `tenant_id`・`start_time`・`end_time`・`updated_*` だけ。`work_charges` は `amount`・`deleted_at`。担当は `membership_id`・`deleted_at`（付け替えは作り直し）
- **外部の人**：作業は読めるが、行の列は画面（専用ページの区画）が `id, scheduled_date, status` だけを取る。契約・中身・金額・担当は読めない
- 判定の関数 `app.is_assigned_to_work`（security definer。スタッフが担当の作業か）、`app.service_invoiced`・`app.work_charge_locked`（`invoice_lines` が無ければ false。あれば `service_key`・`service_month`／`work_id` で請求書に載ったかを見る）

## 3. サーバーの処理（RPC）

すべて `security definer`・`search_path` 固定。会社は行から引き、`contract.edit` を `app.require_perm` で確かめる（行が見つからない・消えている・権限がないは、同じ 42501）。`app.mark_rpc()` で履歴の source を `rpc` にする。行は `for update` で押さえる。戻りは jsonb。業務の決まりで断るときは、例外ではなく `{ok:false, reason}`。

| RPC | 中身 | 断る理由（reason） | 基準 |
|---|---|---|---|
| `create_contract_from_quote(p_quote_id, p_start_date, p_end_date)` | 承認された見積から契約と中身を作る。すでに契約があれば `{ok:true, already:true, id}` | `not_approved`・`start_required`・`end_before_start`・`no_lines` | R-010-1〜3 |
| `create_contract_import(...)` | 取り込み用（014）。見積なしで契約と中身を作る。先に全部の中身を確かめ、1つでも正しくなければ何も作らない | `invalid_kind`・`start_required`・`end_before_start`・`no_services`・`invalid_service_kind`・`invalid_name`・`invalid_amount`・`invalid_billing`・`invalid_recurrence`・`invalid_time` | R-010-4 |
| `change_contract_service(p_service_id, p_effective, p_changes)` | 3章下の「変更」 | `contract_ended`・`not_current`・`nothing_to_change`・`effective_in_past`・`effective_not_after_start`・`after_contract_end`・`invalid_*`・`no_change`・`invoiced` | R-010-13〜16 |
| `end_contract(p_id, p_end_date)` | 3章下の「終了」 | `end_before_start`・`invoiced` | R-010-16・17 |

- **変更**：適用日の前日で今の行を閉じ、同じ `service_key` で新しい行を作る。種類・請求の仕方は引き継ぎ、決まった担当も写す。`app.cancel_future_works` が、適用日以降の、状況が「予定」で `run_id` のある作業（定時の処理が作ったもの）を、`cancelled`＋`deleted_at` にし、作業の金額・担当も論理削除する。取り消した行は履歴として残る（同じ日に新しい予定を作っても一意の索引に当たらない）
- **終了**：状況を「終了」、終了日を入れ、開いている中身を終了日で閉じる（終了日より後に始まる中身は消す）。終了日より後の予定を取り消す。手で足した予定は、状況だけ取消にする
- **請求書に載った月**：変更は、適用日の月以降に載った月があれば断る（適用日がそれより前でも、変更は以後ずっと効くため）。終了は、終了日の月より後の月が載っていれば断る

## 4. 予定を作る定時の処理

- **Edge Function `generate-works`**（`supabase/functions/generate-works/index.ts`）。判断は `_shared/schedule.ts`（RRULE の読み解き・期間の内側の絞り・会社ごとの回し方）に分け、外への口（DB）は `ScheduleStore` として引数で受ける。Deno にも Node にも依存しないので、Vitest で偽の口と PGlite の口をつないで確かめる
- **2つの使い方**：定時（毎朝。`service_role` の鍵）は全部の会社を、会社ごとに順に回す。画面から「いま作り直す」（操作した人のログインの鍵と `contract_id`）は、`contract_schedule_tenant`（権限と契約の会社を確かめる）を通した契約だけを作り直す
- **DB の関数**（`service_role` だけが実行できる）：`schedule_tenants`（終えていない契約を持つ、止めていない会社）、`schedule_start`（処理の記録を始める。同じ会社で動いていれば null。30分を過ぎた古い記録は失敗で閉じる）、`schedule_services`（期間にかかる今の中身と決まった担当）、`schedule_insert`（作業・初めの担当・作業の金額を1つの文で作る。同じ中身・同じ日は `on conflict do nothing`）、`schedule_finish`（記録を閉じる）。作業の `tenant_id` は引数の会社で、中身・契約が別の会社なら作らない
- **処理の記録**：`job_runs`（001）に、種類 `schedule_works`、会社ごと・1回ごとに残す。件数（作った・すでにある・読めない・担当・金額）を `counts` に入れる。エラーは短く切って鍵や環境変数の値を含めない
- **RRULE**：自作の読み解き。扱うのは FREQ（DAILY・WEEKLY・MONTHLY・YEARLY）・INTERVAL・BYDAY（第N曜つき）・BYMONTHDAY（負の値つき）・BYMONTH・COUNT・UNTIL。BYSETPOS など扱わない項目は「読めない」とし、その中身は `invalid` に数えて、ほかの中身は作る。起点は中身の `valid_from`（COUNT・INTERVAL はここから数える）。展開できる期間の上限は約10年

## 5. 使われているものは消さない

002 の `app.usage_refs` が、契約（`active`）と作業（`scheduled`・`in_progress`）を使われ方として仮に登録している。010 の状況の値（契約 `active`・`ended`、作業 `scheduled`・`in_progress`・`done`・`skipped`・`cancelled`）はそれと合っているので、行は足していない。002 のテストが使っていた仮の表（`contracts`・`works`）は、本物ができたので外した（R-010-25）。

## 6. 画面

| 画面 | 場所 | 内容 | 基準 |
|---|---|---|---|
| 契約の一覧 | `/contracts/` | 取引先・建物・種類・状況・期間。絞り込み。「見積から契約を作る」（`contract.edit`） | R-010-26・32 |
| 見積から契約を作る | `/contracts/new/?quote=` | 承認された見積（契約にしていないもの）・開始日・終了日。作ったあと予定を作り直す Edge Function を呼ぶ（失敗しても次の定時の処理が作るので止めない）。見積の画面（承認済み）からも入れる | R-010-29・32 |
| 契約の詳細 | `/contracts/detail/?id=` | 清掃の中身（過去の内容は区別）、これからの予定、中身の変更、契約を終える | R-010-27・28・30・32 |
| 予定の一覧 | `/contracts/works/` | 今日以降の予定。建物・状況で絞る。予定表・割り当ては 012 | R-010-31 |

- 外枠・入口のメニューには、入口に「契約・予定」の1行と、見積の画面（承認済み）に「契約を作る」のリンクを足した。専用ページ（005）の区画の登録簿に、作業の日と状況の区画を足した（R-010-33）
- 一覧の取得は、今の会社の `tenant_id` で絞る。接続・権限は `components/useSession.ts` のものを使う。権限の出し分けは見せ方のためだけで、判定は DB が行う

## 7. テストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-010-1〜5・13〜25 と、定時の処理の DB の関数（R-010-7〜12） | DB（pgTAP。PGlite でも流す） | `supabase/tests/22_contracts.sql` |
| 他の会社への漏れ・構造・型の付け忘れ | DB（登録された全部の表に流す） | `02_leak_all_tables.sql`・`01_structure.sql`（`tests.seed()` に 010 の種を足した。`00002_seed_010.sql`） |
| R-010-6〜12 の判断（RRULE・期間・会社ごとの回し方） | 単体（Vitest。偽の口） | `apps/web/tests/schedule.test.ts` |
| R-010-7〜14・17 の通し（判断のコード＋本物の DB の関数） | 単体（Vitest。PGlite は別のプロセスで流す） | `apps/web/tests/schedule-db.test.ts`・`tools/pglite/schedule-scenario.mjs` |
| R-010-26〜31・33 の部品 | 単体（Vitest） | `apps/web/src/lib/contracts/contracts.test.ts` |
| R-010-26〜32 の画面の流れ | 画面（Playwright + Edge。契約の表は、このテストが自分で偽の接続先を受ける） | `apps/web/e2e/contracts.e2e.ts` |

- Edge Function の本体（`index.ts`）は、この PC に Deno がないため実行して確かめていない。配備の前に `supabase functions serve` で確かめる
- 画面と実際の Supabase との通信は、実際の Supabase が動くまで確かめられない

## 8. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 作業（`works`）・作業の金額・担当の表をこの機能で作る | 予定の作成に要る。表の定義は data-model.md のとおりで、012 は画面と実績を足す | 012 で作る（010 の予定が作れない） |
| 契約の作成・変更・終了は RPC だけ。表への直接の書き込みは受け付けない | 中身の履歴（今の行を閉じて新しい行）と予定の取り消しを1つの処理で守るため | 画面から直接書く（途中で食い違う） |
| 変更は、今の行を `valid_to`＝適用日の前日で閉じ、同じ `service_key` で新しい行 | どの月にいくらだったかが残り、請求書の明細が `service_key`＋月で元をたどれる | 行を直接書き換える（昔の金額が消える） |
| 変更の適用日は今日以降 | 過去の予定・請求を書き換えない | 過去にも変えられる |
| 請求書に載った月以降に効く変更・終了は断る | 請求書に載った契約の中身は直せない（仕様）。変更は以後ずっと効くので、適用日が載った月より前でも断る | 載った月だけ守る（載った月の請求と食い違う） |
| `invoice_lines` が無い間は、載っていない扱いで飛ばす | 011 が並列で、表がまだない | 011 を待つ |
| 取り消した予定は `status=cancelled` に加えて `deleted_at` も入れる | 同じ日に新しい内容で作り直せる（一意の索引は消していない行だけ） | 取消のまま残し、一意の索引に取消を除く条件を足す（索引が複雑になる） |
| 手で足した作業（`run_id` なし）は、変更では取り消さない。契約の終了では、終了日より後のものを、状況だけ取消にする | 人が決めた予定を、契約の変更が勝手に消さない。終了後は行かないので取消にする | 全部取り消す |
| 繰り返しのない明細は単発（`FREQ=DAILY;COUNT=1`）。起点は開始日 | 契約の繰り返しは RRULE の文字列1つ（data-model.md） | 繰り返しを空にする（毎回分岐が要る） |
| 見積の明細の種類を、基本 → 基本（毎月）、オプション → オプション（行った回ごと）、単発 → 特別清掃（行った回ごと）に写す | 003・004 の設計と、請求（011）が「毎月は契約の中身、回ごとは作業の金額」を元にする決まり | すべて毎月 |
| RRULE の読み解きは自作。扱わない項目は「読めない」 | Edge Function（Deno）と Vitest（Node）の両方で同じコードが動き、依存を増やさない。黙って違う予定を作るより、読めないと数えるほうが安全 | 外部のライブラリ（Deno の取り込みと版の管理が増える） |
| 予定の作成は、会社ごとに分け、`schedule_insert` が1つの文で作る | 1つの会社の失敗がほかを止めず、二度動いても重ならない（一意の索引＋`on conflict do nothing`） | 行ごとに作る（遅く、途中で止まると半端） |
| 今日から2か月先まで作る | 仕様（毎朝の処理で2か月先まで） | もっと先まで |
| 画面から契約を作った・変えたあと、Edge Function でいま作り直す。失敗しても止めない | 次の定時の処理が作る。すぐ予定が見えるほうが分かりやすい | 定時の処理だけ（最大1日見えない） |
| 業務の決まりで断るときは `{ok:false, reason}`（例外にしない） | 画面が日本語の理由を出せる（002・004 と同じ） | 例外のメッセージ |
| 外部の人の専用ページの区画は、作業の日と状況だけを取る | data-model.md：外部の人は許された建物の作業の日と状況だけ | 名前や時刻も出す |
