# 機能003：案件（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（003 の章）が正で、ここは 003 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の `app.apply_policy`、使われ方の登録は [../002-clients-buildings/design.md](../002-clients-buildings/design.md) の `app.usage_refs`、お知らせは [../015-notifications/design.md](../015-notifications/design.md) の `app.enqueue_notification`。

## 1. 表

どちらも `tenant_id` と共通の列（`id`・作成と更新の人と時刻・`deleted_at`）、`unique (tenant_id, id)` を持つ。親への参照は `(tenant_id, 親の id)` の組。

| 表 | 型 | 列（共通の列を除く） | 制約・索引 | 基準 |
|---|---|---|---|---|
| `requests` | A | client_id（依頼元）、building_id、room_id、source、category、title、detail、due_date、assignee_id、status | 取引先・建物・部屋・担当（所属）は組の外部キー。source は `manual`・`phone`・`email`・`field`・`import`、category は `cleaning`・`repair`・`complaint`・`inquiry`・`other`、status は `new`・`in_progress`・`done`・`cancelled`（check）。title は空でなく 100 字まで、detail は 2000 字まで。索引は `(tenant_id, status, due_date)`・建物・取引先・部屋・担当 | R-003-1〜7 |
| `request_charges` | B | request_id、amount（円・0 以上）、billable（既定 true） | `(tenant_id, request_id)` の外部キー。`unique (tenant_id, request_id) where deleted_at is null`（1案件に1つ） | R-003-18〜22 |

- 「見積から作った」「作業を作った」のつなぎは、見積（004）・作業（012）の側が `request_id` を持つ。この機能の表は他の表を指すだけで、指される側（`photos.request_id`・`works.request_id`・`quotes.request_id`・`invoice_lines.request_id`）は後の機能が組の外部キーを足す

## 2. 権限（RLS）

policy は `app.apply_policy` で型から作り、003 の決まりに合わせて insert・update を作り直す（名前は型の関数と同じ `tp_` から始める）。

| 表 | 操作 | だれが | 条件 | 基準 |
|---|---|---|---|---|
| requests | 読む | `request.edit`（管理者・社員）は全部、スタッフは担当の案件だけ | 型 A：`read_bypass = request.edit`、`read_scope = app.is_owner_membership(tenant_id, assignee_id)`。外部の人・運営（許可なし）は読めない | R-003-7 |
| requests | 作る | `request.edit` | status は `new`、`deleted_at` は空、担当は社内の人（`app.request_assignee_ok`） | R-003-1〜4 |
| requests | 直す | `request.edit` | 列の権限で `status`・`deleted_at`・`id`・`created_*` は書けない。担当は社内の人 | R-003-4・5 |
| requests | 消す | ― | delete の権限なし。取消は RPC で status を変える | R-003-5 |
| request_charges | 読む | `amount.read` | 型 B | R-003-19 |
| request_charges | 作る | `request.edit` と `amount.read` の両方 | `deleted_at` は空 | R-003-18・19 |
| request_charges | 直す・消す（論理） | 同じ | `app.request_charge_locked` が偽（請求書の明細に載っていない）。列の権限で `request_id`・`tenant_id` は書けない（付け替え不可） | R-003-20・21 |

- 変更の履歴は、2つの表とも付く（型 A・B の既定）
- スタッフ（`field.record`）は案件を直接作れない。気づきから作る RPC を通す（担当が本人になるので、本人が読める）

## 3. 使われているものは消さない（`app.usage_refs`）

- 002 の行：`room`・`in_use`・`requests`・`room_id = $2`・`used_by_requests` が、003 の列名と合う（テストで確かめた）
- 003 が足す行：`building`・`block`・`requests`・`building_id = $2 and status in ('new', 'in_progress')`・`has_open_requests`（終わっていない案件のある建物は消さない。完了・取消の案件は、建物が消えても履歴として残る）
- 請求書に載った金額は、`app.request_charge_locked(tenant, request)`：`to_regclass('public.invoice_lines')` が null なら偽。あれば `invoice_lines` の `tenant_id = $1 and request_id = $2 and deleted_at is null` の行があるかを動的な SQL で確かめる（`app.usage_blockers` と同じ「表が無ければ飛ばす」形）。011 は、`invoice_lines` の列名（`tenant_id`・`request_id`・`deleted_at`）がこの条件と合うかを確かめ、取り消しで明細に `deleted_at` を入れる（data-model.md の 011 の章）

## 4. サーバーの処理

DB の関数（`security definer`・`search_path` 固定。中で権限と、行の会社・状況を確かめる。見つからない・権限がないは同じ 42501）：

| 関数 | 呼ぶ人 | 中身 | 基準 |
|---|---|---|---|
| `set_request_status(p_id, p_status)` → jsonb | ログインした人 | 案件の会社を行から引く。`request.edit` を持つ人、または担当のスタッフ（`field.record`）だけ。同じ状況なら `{ok:true, changed:false}`。切り替えの表（要件 R-003-8・11）に合えば更新して `{ok:true, changed:true, status}`。合わなければ `{ok:false, reason}`（`invalid_transition`・`forbidden_transition`・`billed`）。取消は、請求書に載った金額があれば `billed` | R-003-8〜13 |
| `create_request_from_observation(p_id, p_building_id, p_title, p_detail, p_room_id, p_category)` → jsonb | `field.record` | 建物の会社・依頼元を引く（消した建物は 42501）。同じ uuid が同じ人・同じ会社のものなら `{ok:true, already:true}`、別の人・会社なら 42501。部屋は同じ建物のものだけ（22023）。入口 `field`・状況 `new`・担当は本人で作る | R-003-14〜16 |
| `request_assignees(p_tenant)` → (membership_id, display_name, role_code) | `request.edit` | 同じ会社の有効な社内の所属（外部を除く）と表示名 | R-003-32 |
| `request_due_tenants()` → uuid の集合 | service_role | 期限のある、終わっていない案件を持つ会社（止めた会社を除く） | R-003-26 |
| `request_due_start(p_tenant)` → run の ID か null | service_role | 30 分を過ぎた `running` を失敗で閉じ、動いていれば null。`job_runs` に種類 `request_due` で作る | R-003-26 |
| `request_due_notify(p_tenant, p_run, p_days)` → {requests, notified} | service_role | 受付・対応中で、期限が（日本時間の）今日から `p_days` 日後まで（切れも含む）の案件ごとに、担当者（有効なら）か、いなければ `request.edit` を持つ有効な所属の全員へ、`app.enqueue_notification`（種類 `request_due`、リンク `/requests/detail/?id=<id>`）。重複の印は `request_due:<案件>:<期限>:<soon・overdue>` | R-003-24・25 |
| `request_due_finish(p_tenant, p_run, p_status, p_counts, p_error)` → boolean | service_role | 記録を閉じる（会社と種類を確かめる） | R-003-26 |

Edge Function：

| 処理 | 呼ぶ時 | 中身 | 基準 |
|---|---|---|---|
| `request-due` | 1日1回（朝）の定時（配備で設定）。service_role のキーを持つ呼び出しだけ | 会社の一覧 → 会社ごとに 記録を始める → `request_due_notify` → 記録を閉じる。会社の失敗は、その会社の記録だけに残して次へ進む。判断のコードは `supabase/functions/_shared/requestDue.ts`（Deno・Node に依存しない） | R-003-26 |

- 作るのは「送る前」のお知らせだけ。送るのは 015 の `send-notifications`（1 分ごと）。担当者が通知を切っていても、一覧の行は常に作られる（015 の決まり）
- 期限の判定の決まり（R-003-23）は DB（`request_due_notify`）と画面の部品（`apps/web/src/lib/requests/due.ts`）の2か所にあるが、同じ決まりを単体のテスト・DB のテストの両方で、同じ境界（今日・3日後・4日後・昨日）で確かめる

## 5. 画面

`apps/web/src/app/requests/` に、静的書き出しに合うよう、パスは固定で行の ID は `?id=` で渡す。スマホの幅で使えるよう、一覧はカード、フォームは1列、ボタンは大きく。

| 画面 | パス | 主な操作 | 基準 |
|---|---|---|---|
| 案件の一覧 | `/requests/` | 状況・期限・建物・担当で絞り込み（初めは終わっていないものだけ）、期限切れ・近い件数の警告、金額（`amount.read` の人だけ）、登録へ | R-003-23・27・29 |
| 案件の登録 | `/requests/new/` | `request.edit`：建物・依頼元・題名・内容・期限・担当・分類・受けた方法・部屋・金額。スタッフ：建物・題名・内容・部屋・分類の「気づきから案件を作る」（電波がなければ端末にためる） | R-003-1・14・15・28・29 |
| 案件の詳細 | `/requests/detail/?id=` | 状況の変更（許された切り替えだけ出す）、中身の編集（`request.edit`）、金額の保存・消す（`amount.read`）、スタッフは読むだけ＋状況 | R-003-8〜13・18・21・29 |

- 画面の中身は `apps/web/src/lib/requests/`：期限の判定 `due.ts`、入力の検査 `validate.ts`、ラベル・絞り込み・並び・状況の出し分け `format.ts`、Supabase を呼ぶ薄い層 `repo.ts`、気づきの端末へのため方 `observation.ts`。判断の部品は Vitest で確かめる
- 会社と権限は 001 の `AuthProvider`（`useSession` 経由）。`components/requests/Shell.tsx` の `useRequestsSession` が読む。一覧・取得は今の会社の `tenant_id` で絞る。Supabase のクライアントは 001 の `lib/supabase.ts` の1つ
- 気づきの端末へのため方は、001 の送り箱の「RPC」（`kind: rpc`、`p_id` に端末の uuid）。ためたあと、すぐ送ってみる。送れなければ自動で送る

## 6. テストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-003-1〜22・24〜26・30〜32 | DB（pgTAP。PGlite でも流す） | `supabase/tests/21_requests.sql`（種は `tests.seed_003()`＝`00002_seed_003.sql`） |
| 他の会社への漏れ・構造 | DB（登録された全部の表に流す） | `02_leak_all_tables.sql`・`01_structure.sql`・`03_policy_types.sql`（`tests.seed()` に 003 の種を足した） |
| R-003-23・27〜29 | 単体（Vitest） | `apps/web/src/lib/requests/requests.test.ts` |
| R-003-15（端末にためる）・26（定時の処理の判断） | 単体（Vitest） | `requests.test.ts`・`due-run.test.ts` |

- 画面そのもの（見た目・実際の Supabase との通信）は、実際の Supabase が動くまで確かめられない。001 の画面の流れのテスト（Playwright）の偽の接続先に、案件を足してから確かめる
- 002 のテスト `20_clients_buildings.sql` は、案件の代わりの仮の表を作っていた。本物の表ができたので、その1行を本物の行に置き換えた

## 7. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 状況の値は英語（`new`・`in_progress`・`done`・`cancelled`）、分類・入口も英語の値 | 002 と同じ。表記ゆれを防ぐ | 日本語の値 |
| 状況の切り替えは表で決める（受付 ⇄ 対応中、完了・取消への切り替え、完了 → 対応中、取消 → 受付）。完了 ⇄ 取消はさせない | 間違えて完了にしたときは戻せる。完了を取消に変えると、実績の意味が変わる | 自由に切り替え |
| 担当のスタッフは、進める切り替え（受付 → 対応中・完了、対応中 → 完了）だけできる。取消・戻しは `request.edit` | crud.md の「RPC：status」。スタッフに現場で進める手段を与え、取り消しは事務に残す | スタッフは変えられない／全部できる |
| 請求書の明細に載った金額がある案件は、取消にさせない（`billed`） | 取消にすると、出した請求書と案件が食い違う | 取消を許し、請求書を別に直す |
| 担当は、同じ会社の社内の人（外部の人でない）。止められた人も、既存の案件の編集のために、列の値としては許す | 止められた人が担当のままの案件を、期限を直すだけで直せなくなるのを避ける。通知とスタッフの読みは「有効な所属」だけなので害はない | 有効な人だけ（止めた人が担当だと、案件を直せなくなる） |
| 気づきから作る案件の担当は、作った本人 | スタッフが、自分の作った案件を読めるようにする（スタッフが読めるのは担当の案件だけ）。事務が後で付け替える | 担当なし（作ったスタッフが読めなくなる） |
| 気づきから作る案件の依頼元は、建物の依頼元 | スタッフは取引先を選べない（読めるが、現場で選ぶ手間が増える）。事務が直せる | 取引先も選ばせる |
| 案件の依頼元は、建物の依頼元と一致を求めない | オーナーからの依頼など、依頼元が建物の依頼元と違うことがある | 一致を求める |
| 部屋が建物に属するかは、RPC だけで確かめる（直接の insert では組の外部キー＝同じ会社までを DB が守る） | 部屋の表に `(tenant_id, id, building_id)` の一意を足すと 002 の表を直すことになる。別の建物の部屋を指しても、会社をまたぐ漏れにはならない | 002 の表を直す |
| 金額の「付け替え」を列の権限で止める（`request_id`・`tenant_id` を更新の権限から外す） | 別の案件へ金額を動かせないようにする | RLS の with check |
| 金額の「消す」は論理削除（update）。delete の権限は与えない | data-model.md の1章・01 のテスト（delete の policy なし）。請求書に載った行は、update の policy と同じ条件で止まる | delete を与える |
| 期限の「近い」は 3 日（今日を含む）。判定は日本時間の日付。完了・取消・期限なしは警告しない | 週末をまたぐ前に気づける。終わったものに警告を出さない | 7 日 |
| 期限のお知らせは、案件・期限・段階ごとに1人1件。担当がいない（または止められている）案件は `request.edit` を持つ全員 | 毎朝同じ案件を何度も知らせると読まなくなる。期限を直したときと、近い → 切れ に変わったときは、新しく知らせる。担当者がいない案件が、だれにも届かないのを避ける | 毎日知らせる／担当なしは知らせない |
| 定時の処理は、会社ごとに DB の関数 3 つ（開始・お知らせ・終了）に分け、Edge Function がつなぐ | 015 と同じ形。会社の失敗がほかを止めない。1つの関数にすると、失敗したとき記録も一緒に戻ってしまう | 1つの関数 |
| 案件の `assignee_id` の一覧用に `request_assignees` を作る（所属の表は管理者だけが読める） | 社員が担当を選ぶために、名前が要る。006 の `cash_holder_names` と同じ形 | 所属の表の policy を広げる（001 の決まりを変える） |
| 終わっていない案件のある建物は消さない（`has_open_requests`） | 案件の建物が消えると、案件の一覧で建物名が出せなくなる。完了・取消の案件だけなら消せる | 常に消せる／常に消せない |
| 気づきの案件を作る RPC に、写真の引数は付けない | 写真の表は 008 で作る。008 が引数（`p_photo_ids`）を足して作り直す | 先に空の引数を置く |

## 8. まだのこと

- 写真と案件のつなぎ（008）。見積・作業・請求書との行き来（004・012・011）
- `invoice_lines`（011）ができたら、列名（`tenant_id`・`request_id`・`deleted_at`）が `app.request_charge_locked` の条件と合うかを確かめ、請求書に載った案件でこの機能のテスト（R-003-13・21）を、本物の表で流す
- 画面の流れ（Playwright）。001 の波 1 の偽の接続先に案件の表と RPC を足してから
- 定時の処理を動かす設定（配備側）。Edge Function の実機の確認（この PC に Deno がない）
