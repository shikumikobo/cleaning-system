# 機能015：お知らせ（設計）

要件は [requirements.md](requirements.md)。基準の番号（R-015-n）で対応を書く。表と policy の型は [../data-model.md](../data-model.md)、権限の決まりは [../001-tenants-users/design.md](../001-tenants-users/design.md) が正で、ここは 015 での実際の形を書く。

この設計は、1〜7章が「仕組み」（波 1）、8章が出来事ごとの通知（波 6）。出来事ごとの通知は、共通の関数 `app.enqueue_notification` を呼ぶ処理を足しただけで、仕組み（表・送る処理）は変えていない。

## 1. 表

どの表も `tenant_id` と共通の列（`id`・作成と更新の人と時刻・`deleted_at`）を持つ。`notification_kinds` は共通のマスタなので持たない。親は `(tenant_id, id)` の組で参照する。

| 表 | 型 | 列（共通の列を除く） | 説明 | 基準 |
|---|---|---|---|---|
| `notification_kinds` | M | code（一意）、name、default_push、default_email、required_perm（権限の code。なければ空）、sort | 共通のマスタ。マイグレーションだけが書く。波 6 までの6つの種類を初めから入れる | R-015-1・2 |
| `notification_settings` | C1 | membership_id、kind、channel（push・email）、enabled | `unique (tenant_id, membership_id, kind, channel)`。画面から本人が upsert する。行がなければ種類の初めの値 | R-015-2〜4 |
| `push_subscriptions` | C1 | membership_id、endpoint（`https://` の check）、p256dh、auth、device_label | `unique (tenant_id, membership_id, endpoint)`。作るのは RPC `register_push_subscription` だけ。本人が外す（`deleted_at`）。届かない端末は Edge Function が行ごと消す | R-015-5〜8・21 |
| `notifications` | C1 | membership_id、kind、title、body、link、channel（app・push・email）、status（pending・sent・failed）、error、sent_at、read_at、run_id、dedupe_key | 作るのは `app.enqueue_notification` だけ。`app` の行がアプリの一覧（作るとき `sent`）。`push`・`email` の行を Edge Function が送る。180 日で消す | R-015-9〜25 |

- **data-model.md に足す列**：`notifications.body`（本文）と `notifications.dedupe_key`（重複の印）。要件の基準に要るため、同じ変更を data-model.md の 015 の行に足す（このブランチでは data-model.md を直さず、報告に書く）
- 索引：`notifications (tenant_id, membership_id, created_at desc)`（一覧）、`notifications (tenant_id, created_at) where status = 'pending'`（送る前を拾う）、`notifications (tenant_id, created_at)`（掃除）、`(tenant_id, run_id)`（外部キー）、`unique (tenant_id, membership_id, kind, channel, dedupe_key) where dedupe_key is not null`（R-015-13）
- check：`link` は空か `^/[^/\\]` で始まる（アプリの中の道だけ。R-015-14）、`channel = 'app'` のときは `status = 'sent'`、`title` は 1〜100 字、`body` は 500 字まで
- 処理の記録は 001 の `job_runs` を使う。種類は `send_notifications` と `purge_notifications`。同じ会社・同じ種類の `running` は1つだけにする部分一意の索引を足す（R-015-23）

## 2. 権限（RLS）

policy は `app.apply_policy` から作る（型の割り当てだけを書く）。

| 表 | 読む | 書く | 型の項目 | 基準 |
|---|---|---|---|---|
| notification_kinds | ログインした人 | マイグレーションだけ | M | R-015-1 |
| notification_settings | 本人 | 本人 | C1、`supervise_perm: none`（`work.assign` でも他人の設定は読めない） | R-015-3・4 |
| push_subscriptions | 本人 | 本人は `deleted_at` だけ（列の権限）。作るのは RPC | C1、`supervise_perm: none`。insert の権限を外し、update は `deleted_at` の列だけ | R-015-4〜7 |
| notifications | 本人 | 本人は `read_at` だけ（列の権限）。insert の権限なし | C1、`supervise_perm: none`。insert を外し、update は `read_at` の列だけ | R-015-4・16・17 |

- 運営は、型の共通の決まりのとおり、管理者が許した期間だけ読める（書けない）
- `work.assign` と管理者でも、他人のお知らせと設定は読めない（要件 R-015-4。中身が個人あてのため）

## 3. サーバーの処理

### DB の関数

| 関数 | 呼ぶ人 | 中身 | 基準 |
|---|---|---|---|
| `app.enqueue_notification(tenant, membership, kind, title, body, link, dedupe_key, run_id)` → 作った行の数 | 後の機能の RPC（`security definer` の中から）。画面・anon には実行を与えない | 種類・リンクを確かめる（22023）→ 所属（会社・有効）→ 種類の権限 → `app` の行を作る（重複なら 0 で終わる）→ 通知の設定が入で、有効な端末があれば `push` の行 → メールの設定が入なら `email` の行。設定がなければ種類の初めの値 | R-015-9〜15 |
| `public.enqueue_notification(...)` | 会社をまたぐ定時の処理（service_role だけ） | 上の関数を呼ぶだけ（PostgREST から呼べるように public に置く） | R-015-15 |
| `public.register_push_subscription(tenant, endpoint, p256dh, auth, label)` → id | 本人 | 自分の有効な所属を確かめ、同じ endpoint の他人の登録を消し、自分の分を upsert（消した印も外す） | R-015-5・6・8 |
| `public.notification_tenants_pending()` | service_role | 「送る前」の通知・メールがある会社の ID | R-015-18 |
| `public.notification_start_run(tenant, kind)` → run の ID か null | service_role | 30 分を過ぎた `running` を失敗で閉じてから、`running` の記録を作る。すでに動いていれば null | R-015-18・23 |
| `public.notification_finish_run(tenant, run, status, counts, error)` | service_role | 記録を閉じる（会社と種類を確かめる） | R-015-18・22 |
| `public.notification_outbox(tenant, limit)` | service_role | 「送る前」の通知・メールの行と、受け取る人の user_id（有効な所属のときだけ） | R-015-18 |
| `public.notification_mark(tenant, id, status, error)` | service_role | `pending` の行だけを `sent`（sent_at を入れる）か `failed`（理由。300 字まで）にする | R-015-19・20 |
| `public.notification_drop_subscription(tenant, id)` | service_role | 届かない端末の登録を行ごと消す | R-015-21 |
| `public.notification_purge(tenant)` → 消した数 | service_role | 作ってから 180 日を過ぎたお知らせと、外して 30 日を過ぎた端末の登録を消す。その会社の分だけ | R-015-25 |

- 後の機能の RPC は `perform app.enqueue_notification(...)` を、自分の変更と同じトランザクションの中で呼ぶ。通知を作る失敗が本体を止めないよう、受け取る人が止められているなどは例外にせず 0 を返す
- 関数の実行権限は `app.lock_functions()` のあと、service_role だけに与える

### Edge Function

| 処理 | 呼ぶ時 | 中身 | 基準 |
|---|---|---|---|
| `send-notifications`（`task: send`） | 1 分ごとの定時（配備で設定）。service_role のキーを持つ呼び出しだけ | 会社ごとに：記録を始める → 送る前の行を取る → 通知は端末ごとに Web Push、メールはメールの送り手で送る → 1行ずつ `sent`・`failed` → 届かない端末を消す → 記録を閉じる。会社の失敗は、その会社の記録だけに残して次へ進む | R-015-18〜24 |
| `send-notifications`（`task: purge`） | 毎日 | 会社ごとに `notification_purge`。記録を残す | R-015-25 |

- 構成：判断のコードは `supabase/functions/_shared/notifications.ts`（外への口を引数で受け、Deno にも Node にも依存しない）。Deno にだけ依存する外への口（Web Push・メール・DB・環境変数）は `_shared/adapters.ts` と `send-notifications/index.ts`。単体のテストは、判断のコードに偽の送り手・偽の DB を渡す（Vitest）
- 外への口：`PushSender`（Web Push。`npm:web-push`、VAPID の鍵は環境変数 `VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT`）、`MailSender`（`MAIL_PROVIDER` で選ぶ。今は登録のない `noop` だけで、送れず理由を返す）、`NotificationStore`（DB の関数を呼ぶ）、`emailOf`（Auth の管理 API でメールを取る）
- 環境変数や鍵は、記録・エラー・戻り値に出さない（`sanitizeError`で、32 字以上の文字列を伏せる）

## 4. 画面（PWA）

| 画面 | パス | 主な操作 | 基準 |
|---|---|---|---|
| お知らせの一覧 | `/notifications/` | 新しい順の一覧、未読の印、読む（既読）、すべて既読、リンクの先へ | R-015-16 |
| 通知の設定 | `/settings/notifications/` | 通知の許可と端末の登録・解除、種類ごと・手段ごとの切り替え | R-015-26・27 |
| ヘッダーの鈴 | 部品 `NotificationBell`（001 の画面の枠に置く） | 未読の件数、一覧へ | R-015-16 |

- 部品：`src/lib/notifications/`（`kinds.ts` 設定の合成、`push.ts` 許可と登録、`api.ts` DB との口、`session.ts` 今の会社と所属）。画面は薄く、判断は部品に置いてテストする
- サービスワーカー：`public/sw-push.js`（`push` で表示、`notificationclick` でリンクの先を開く）を、既存の `public/sw.js` が `importScripts` で読む（共通の1行）。表示は題名・本文・リンクだけ。リンクはアプリの中の道だけ受ける（R-015-28）
- VAPID の公開鍵は `NEXT_PUBLIC_VAPID_PUBLIC_KEY`（ビルド時。公開してよい値）。見本は `apps/web/.env.example`
- 今の会社と権限は、001 の `AuthProvider`（`useSession` 経由）から読む（`useNotificationSession`）。ヘッダーの鈴（`NotificationBell`）は、001 の画面の外枠（`AppShell` のヘッダー）に入れた

## 5. テストの方法

| 基準 | テストの種類 | 置き場所 |
|---|---|---|
| R-015-1〜8・16・17・25 | DB（pgTAP） | `supabase/tests/15_notifications_access.sql` |
| R-015-9〜15・18〜23・25 | DB（pgTAP）。共通の関数と、送る処理が呼ぶ関数 | `supabase/tests/15_notifications_enqueue.sql`、`15_notifications_runs.sql` |
| R-015-18〜24 | 単体（Vitest）。偽の送り手・偽の DB | `apps/web/src/lib/notifications/send.test.ts` |
| R-015-26・27 | 単体（Vitest）。偽のブラウザ・偽の API | `apps/web/src/lib/notifications/push.test.ts`、`kinds.test.ts` |
| R-015-28 | 単体（Vitest）。`sw-push.js` を偽の `self` で動かす | `apps/web/src/lib/notifications/sw-push.test.ts` |
| 画面の流れ（許可 → 登録 → 受け取り） | 画面（Node 版 Playwright）。001 の波 1 のログインのあと | （波 6 の前に足す） |

- 全部の表に流す確かめ（01・02・03）は、`tests.seed_notifications()` に会社ごとの種の行を足して入れる（`00000_helpers.sql` の `tests.seed()` の最後から呼ぶ）
- 実際の送り（実機の通知・実際のメール）は、鍵と送り手がないため、この波では確かめない（報告に書く）

## 6. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 種類の一覧は表（`notification_kinds`、型 M）。波 6 の6つを初めから入れる | 要件に「増やせる形」とある。マイグレーションで1行足せば増える。設定の画面が一覧から作れる | 定数（コードの変更が要る） |
| 受け取りの「初めの値」は、人ごとの行を作らず、種類の `default_push`・`default_email`。行は、本人が切り替えたときに作る | 人が増えても、種類が増えても、行を作る処理が要らない。後から初めの値を変えると、選んでいない人に効く | 所属を作るときに全部の種類の行を作る |
| 初めの値：通知は入、メールは切（`invoice_overdue`・`quote_approved` はメールも入） | 現場の人にメールは多すぎる。金額に関わる知らせは、画面を開かない管理者にメールでも届けたい | すべて入 |
| 一覧の行（`channel = app`）は、手段の設定にかかわらず常に作る。作るとき `sent` | 通知もメールも切っている人にも、見逃しの一覧は残す。設定で切れるのは「外に送る」手段だけ | 一覧も設定で切る |
| 有効な端末がなければ `push` の行を作らない | 送れない行が「失敗」で溜まらない。端末を登録した後の出来事から届く | 失敗として残す |
| 種類の権限（`required_perm`）を、関数の中で確かめる | スタッフに見積の承認が届かない（金額と見積は見せない決まり）。出来事の側で受け取る人を選び間違えても漏れない | 出来事の側だけで選ぶ |
| 同じ会社の送りの二重の実行は、`job_runs` の部分一意の索引で止める。30 分を過ぎた `running` は失敗で閉じる | 行の鍵（`skip locked`）や `run_id` を使うと、`run_id`（作った処理のたどり先。data-model.md の5章）と意味が混ざる。止まったまま残る記録も、30 分で自然に抜ける | 行ごとに「送り中」の状況を足す（仕様の状況は3つ） |
| 端末の登録は RPC で作る（画面から直接 insert させない）。同じ endpoint の他人の登録を消す | 1台のスマホを2人が使うと、前の人の通知が次の人の画面に出てしまう。直接の insert では、他人の行を消せない | 画面から直接 insert（crud.md の「画：本人」。他人の行が残る） |
| 本人が外す端末の登録は `deleted_at`、届かない端末の登録は行ごと消す。外して 30 日を過ぎた行は掃除で消す | 本人の操作は消さない決まりに合わせる。届かない端末は、鍵の入った行を残す意味がない | 常に行ごと消す |
| お知らせの本人の更新は `read_at` の列だけ（列の権限）。作ることはできない | 本人が `status` や題名を書き換えられない（R-015-17）。型 C1 の「本人が書ける」を、列で絞る | policy の条件だけ（列を絞れない） |
| `supervise_perm` を `none` にして、`work.assign` を持つ人にも他人の設定・お知らせを読ませない | 個人あての通知の中身は、本人のもの。型 C1 の既定（全員分を読める）は、この3表では要らない | 既定のまま（crud.md の「本人」に合わない） |
| メールの送り手は、差し替える口（`MailSender`）だけを作り、`MAIL_PROVIDER` が空のとき「失敗（送り手の設定がない）」にする | 外のサービスの契約と登録は人の決定。口があれば、サービスが決まったあとに1ファイルで足せる | 仮のサービスを選んで組み込む |
| 送る処理は、判断のコード（`_shared/notifications.ts`）と Deno 依存の口を分ける | Deno が手元にない・動かないとき（この PC）でも、Vitest で判断のコードを確かめられる | 1ファイルにまとめる（偽の口を渡せない） |
| 会社ごとに分けて回す。会社の中は1行ずつ。1行の失敗は、その行を `failed` にして次へ | 1つの会社・1通の失敗が全体を止めない。書く行の `tenant_id` は、元の行から取る（原則 2章） | 全社を1回の処理にまとめる |
| 送る行の上限は、1回の呼び出しで会社ごとに 100 行。残りは次の回（1 分後） | 1つの会社の大量の通知が、ほかの会社の送りを遅らせない。1 分ごとに回るので滞らない | 上限なし |
| `sw.js` に `importScripts("/sw-push.js")` の1行だけを足す | サービスワーカーは1つしか置けないため。中身は別のファイルに置き、既存の殻のキャッシュの処理を触らない | `sw.js` に直接書く（001・ほかの機能と衝突する） |

## 7. 決まっていないこと

- 実機での確かめ（Android・iOS の PWA、ブラウザごとの通知の許可の出方）。鍵（VAPID）の作成と本番の環境変数の設定は、配備のとき人が行う
- メールの送信のサービス（要件の6章。人が決める）
- 通知を送る定時の設定（`supabase/config.toml` か、配備側のスケジューラ）。この波では Edge Function までを作る

## 8. 出来事ごとの通知（波 6）

マイグレーションは `20261123020000_notification_events.sql`。期限の近い案件（`request_due`）は 003（R-003-24〜26）、見積の承認（`quote_approved`）は 004（R-004-15・17・18）で作ってあり、ここでは足していない。足したのは、予定の変更・明日の作業・出ていない報告書・請求の入金の遅れ。基準は requirements.md の R-015-29〜42。

### 予定の変更（`work_changed`。R-015-29〜32）

012 の RPC を `create or replace` で置き換え、変更のあとに `app.notify_work_assignees`（担当の有効な所属に `enqueue_notification`。操作した本人を除く）を呼ぶ。それ以外の動きは 012 のまま。

| RPC | 作るお知らせ | 重複の印 |
|---|---|---|
| `reschedule_work` | 担当の全員に「予定が変わりました：作業名」。本文は「建物／変更前 → 変更後」。日付・時刻が変わったときだけ | `work_changed:rescheduled:<作業>:<版>` |
| `skip_work` | 担当の全員に「作業は行わないことになりました：作業名」 | `work_changed:skipped:<作業>:<版>` |
| `cancel_work` | 担当の全員に「作業が取り消されました：作業名」 | `work_changed:cancelled:<作業>:<版>` |
| `swap_assignment` | 新しい担当に「担当になりました」、外れた人に「担当から外れました」。ほかの担当には作らない | `work_changed:assigned:<作業>:<新しい担当の行>`・`work_changed:unassigned:<作業>:<外した行>` |

- 通知のリンクは `/schedule/mine/`（自分の予定。スタッフも開ける）。断られた操作（`ok:false`）と `already` は、お知らせを作る前に返るので作らない
- 同じトランザクションの中で作る（`enqueue_notification` は受け取れない人に例外を出さず 0 を返すので、本体は止まらない）

### 毎日の定時の処理（R-015-33〜40）

Edge Function `daily-notifications`（1日1回、朝。service_role のキーを持つ呼び出しだけ）が、会社ごと・処理ごとに、記録を始める → 作る → 記録を閉じる。判断のコードは `supabase/functions/_shared/dailyNotify.ts`（Deno・Node に依存しない。Vitest で偽の口を渡して確かめる）。003 の `request-due` と同じ形。

| DB の関数（すべて service_role だけ） | 中身 |
|---|---|
| `daily_notify_tenants()` | 止めた会社を除く全部の会社 |
| `daily_notify_start(tenant, task)` / `daily_notify_finish(tenant, run, task, status, counts, error)` | `job_runs`（種類 `notify_work_tomorrow`・`notify_report_missing`・`notify_invoice_overdue`）の記録。同じ会社・同じ処理の `running` は部分一意の索引で1つだけ。30 分を過ぎた `running` は失敗（timeout）で閉じて始め直す |
| `work_tomorrow_notify(tenant, run)` | 日本時間の明日が日付の「予定」の作業を持つ担当（有効な所属）ごとに1件。題名「明日の作業：N件」、本文は時刻順（時刻なしは最後）の「時刻 建物 作業名」。本文は 470 字までで、収まらない分は「ほか N 件」。重複の印 `work_tomorrow:<日付>`。リンク `/schedule/mine/` |
| `report_missing_notify(tenant, run, days = 14)` | 完了した作業で、日付が今日より前から `days` 日前までのうち、報告書が提出になっていない（なし・下書き・確認済み。012 の `work_plan_actual.report_missing` と同じ）ものについて、担当と `work.assign` を持つ有効な所属に1作業1人1件。重複の印 `report_missing:<作業>:<作業の日>`。リンクはその作業の報告書 |
| `invoice_overdue_notify(tenant, run)` | 発行・送付・一部入金で、期日が今日より前、入金を引いた残高が 0 より大きい請求書。請求書を作った人（`created_by`）と管理者の有効な所属に（`amount.read` は `enqueue_notification` が確かめる）。重複の印 `invoice_overdue:<請求書>:<期日>`。リンクは請求書の画面 |

- 日付はすべて日本時間（`now() at time zone 'Asia/Tokyo'`）。戻りの `notified` は、お知らせ（一覧の行）を作った人の数
- 定時の設定（1日1回の呼び出し）は、配備のとき人が行う（波 1 の「決まっていないこと」と同じ）

### 画面（R-015-41・42）

- 設定の画面は、`notification_kinds` の行から作るので、種類が増えると自動で出る。波 6 の6種類は初めから載っている（コードの変更なし）
- お知らせの一覧は、既読にしたとき `announceNotificationsChanged()`（`window` の合図）を出し、ヘッダーの鈴（`NotificationBell`）が件数をすぐ取り直す。リンクを開くときは、既読を送り終えてから `router.push` で移る（移ってからだと、送りかけの通信が切れるため）
- 今の会社・権限は、001 の `AuthProvider`（`useSession`）から読む。ヘッダーの鈴は 001 の画面の枠（`AppShell`）に入っている（取り込みで済み）

### 8章のテストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-015-29〜40 | DB（pgTAP。本物の Postgres・Docker） | `supabase/tests/15_notifications_events.sql` |
| R-015-39・40（判断） | 単体（Vitest。偽の口） | `apps/web/src/lib/notifications/daily.test.ts` |
| R-015-26・27・41・42 | 画面（Playwright + Edge。お知らせまわりの表と RPC は、このテストが自分で偽の接続先を受ける。通知の許可・端末の登録は Push API を偽物にする） | `apps/web/e2e/notifications.e2e.ts` |

### 8章で決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 予定の変更は、012 の RPC の中で作る（トリガーにしない） | 担当の付け外しは、毎朝の予定づくり・手で足す作業でも起きる。トリガーだと、それらも「変更」として知らせてしまう。RPC なら、人が変えたときだけ作れる | `works`・`work_assignments` のトリガー |
| 操作した本人には作らない | 自分で動かしたことを知らせる必要がない。ほかの担当にだけ知らせる | 全員に作る |
| 日付・時刻が変わらない変更では作らない | 何も変わっていない知らせは、信頼を下げる | 常に作る |
| 変更のたびに別の印（版・行の ID）にする | 同じ作業を2回動かしたとき、2回目も知らせるため。同じ変更の二重だけを防ぐ | 作業ごとに1回だけ |
| 担当の入れ替えは「担当になった」「外れた」の2通り | 外れた人にも、行かなくてよくなったことを知らせるため | 新しい担当だけ |
| 明日の作業は、人ごと・日ごとに1件にまとめる（作業ごとに作らない） | 通知が1日に何通も来ると読まなくなる。本文に時刻順の一覧を入れる | 作業ごとに1件 |
| 明日の作業は「予定」だけ。実施中・完了・行わず・取消は入れない | 明日の予定として知らせる意味があるのは、まだ行っていない作業 | 取消以外を全部 |
| 出ていない報告書は、日付が今日より前から 14 日前まで | 今日の作業は、今日中に出せる。何か月も前の作業まで毎回さかのぼると、初めて動かしたとき全部の過去の作業が一度に通知される | 今日を含める／期間の制限なし |
| 出ていない報告書の受け取りは、担当と `work.assign`（報告書を確認する権限）を持つ人 | requirements の表（担当と確認する人）。確認する人は、報告書の確認・提出に `work.assign` が要る（009） | 担当だけ |
| 出ていない報告書は、1作業・1人に1回だけ（毎日は繰り返さない） | 毎日同じ通知が来ると読まなくなる。一覧には残る。繰り返しが要るなら、運営者が決める（「確認する人」への再通知など） | 週ごとに繰り返す |
| 入金の遅れは、請求書・期日ごとに1回。期日を直したときは新しい期日として作る | 毎日同じ通知を出さない。期日を延ばしてまた過ぎたときは、新しく知らせる（003 の期限と同じ考え方） | 毎週繰り返す |
| 入金の遅れの受け取りは、請求書を作った人と管理者 | requirements の表のとおり。金額を見る権限（`amount.read`）のない人には、`enqueue_notification` が作らない | 請求の権限を持つ全員 |
| 入金の遅れは、状況が発行・送付・一部入金のものだけ。残高は入金の合計を引く | 下書き・取消は請求していない。状況が「送付」のままでも、入金で残高が 0 なら遅れていない | 状況だけで決める |
| 定時の処理は1つの Edge Function（`daily-notifications`）で、会社ごと・処理ごとに記録を残す | 配備の定時の設定が1つで済む。処理の失敗が、ほかの処理・会社を止めない | 処理ごとに別の Edge Function |
| `request_due`・`quote_approved` は足さない | 003・004 で作ってあり、テストもある（R-003-24〜26・R-004-15〜18）。二重に作ると、同じ出来事が2回知らされる | 015 で作り直す |
