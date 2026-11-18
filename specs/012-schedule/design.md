# 機能012：作業の予定と実績（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（008・009・012 の章）が正で、ここは 012 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の `app.apply_policy`、使われ方の登録は [../002-clients-buildings/design.md](../002-clients-buildings/design.md) の `app.usage_refs`、作業・担当・予定の作成は [../010-contracts/design.md](../010-contracts/design.md)、報告書は [../009-reports/design.md](../009-reports/design.md)。マイグレーションは `20261122010000_schedule_tables.sql`（表・view）と `20261122010100_schedule_rpcs.sql`（RPC）。

## 1. 表と view

| もの | 型 | 中身 | 基準 |
|---|---|---|---|
| `work_records` 実績 | C1（RPC だけが書く） | work_id・membership_id（組の外部キー）、started_at、ended_at（開始以後）、start_lat・start_lng・end_lat・end_lng・distance_m・distance_warning（**列だけ**。013 が入れる）、client_created_at・device_id・received_at。ID は端末の uuid。`unique (tenant_id, work_id, membership_id) where ended_at is null and deleted_at is null`（終わっていない実績は1人1つ） | R-012-1・6 |
| `works.moved_from`（010 の表に足した列） | ― | 定時の処理が作った作業の日を動かしたとき、元の日（作り直さない日）を持つ `date[]`。画面からは書けない（列の権限に入れない） | R-012-9 |
| view `work_overlaps` | `security_invoker` | 同じ人・同じ日で時刻が重なる2つの作業（各作業から見た相手）。時刻のない・取消・行わず・隣り合うだけは数えない | R-012-16 |
| view `work_plan_actual` | `security_invoker` | 取消でない作業ごとに、予定・実績（最初の開始・最後の終了・実績の分）・ずれ（分）・報告書の状況・項目の数・印（`not_done`・`unfinished`・`report_missing`）。日付の比べは日本時間。社内の人だけ（`app.is_internal`）。金額は出さない | R-012-18〜22・24 |
| view `work_monthly` | `security_invoker` | 月・建物ごとの件数（予定・完了・行わず・取消・行っていない・出ていない報告書）と時間（予定・実績の分） | R-012-23 |

- 表 `works`・`work_assignments`・`work_charges` は 010 が作った。012 は RPC と画面を足すだけで、policy は変えない（`works` の直接の書き込みは、予定の間の時刻だけのまま）
- `work_records` の policy は `app.apply_policy('public.work_records', 'C1')`（読む：本人と `work.assign`）。010 と同じく、型が作る insert・update の policy と権限は取り除く（書くのは RPC だけ）
- view は `security_invoker = true`：読む人の権限の RLS をそのまま通す（スタッフは自分の担当の作業だけ。外部の人は `is_internal` で止まる）。`anon` と `public` の権限は取り、`authenticated` に select だけ
- **並列の相手（016 売上と粗利）への外部キー**：付けていない。012 の表・view は 016 の表を指さない。016 は 012 の `work_plan_actual`・`works` を読めるが、012 から 016 への依存はない

## 2. サーバーの処理（RPC）

すべて `security definer`・`search_path` 固定。会社は行から引き、権限を `app.require_perm` で確かめる（行が見つからない・消えている・権限がないは、同じ 42501）。`app.mark_rpc()` で履歴の source を `rpc` にする。作業の行は `for update` で押さえる。戻りは jsonb。業務の決まりで断るときは、例外ではなく `{ok:false, reason}`。

| RPC | 権限 | 中身 | 断る理由（reason） | 基準 |
|---|---|---|---|---|
| `start_work(p_id, p_work_id, p_started_at, p_device_id, p_client_created_at)` | `field.record` かつ作業の担当 | 実績を作り、予定なら実施中・版 +1。同じ uuid の二度目は `already` | `not_startable`・`already_started` | R-012-2・3 |
| `finish_work(p_id, p_work_id, p_ended_at)` | 同上 | 自分の終わっていない実績を終える。開いた実績がなくなれば完了・版 +1。`p_id` は送り箱の印（実績の uuid とは別） | `not_started`・`end_before_start` | R-012-4・5 |
| `skip_work(p_work_id, p_version)` | `work.assign` | 予定 → 行わず・版 +1 | `not_scheduled`・`conflict` | R-012-7・10 |
| `cancel_work(p_work_id, p_version)` | `work.assign` | 予定 → 取消・版 +1。行は残す | `not_scheduled`・`conflict`・`invoiced` | R-012-8・10 |
| `reschedule_work(p_work_id, p_version, p_date, p_start, p_end)` | `work.assign` | 日付と時刻を動かす・版 +1 | `not_scheduled`・`date_required`・`invalid_time`・`conflict`・`duplicate_date` | R-012-9・10 |
| `create_work(p_id, p_date, p_start, p_end, p_contract_service_id, p_request_id, p_title, p_members)` | `work.assign` | 手で作業を足す。同じ uuid の二度目は `already` | `source_required`・`date_required`・`invalid_time`・`invalid_member`・`contract_ended`・`out_of_contract`・`request_closed` | R-012-11・12 |
| `swap_assignment(p_work_id, p_from, p_to)` | `work.assign` | 外す・付けるを1つの処理で | `work_closed`・`not_assigned`・`invalid_member`・`already_assigned`・`has_record` | R-012-14 |
| `work_staff(p_tenant)` | `work.assign` | 担当にできる人（所属・表示名・役割）。社内の人だけ | ― | R-012-15 |
| `assign_conflicts(p_work, p_membership)` | `work.assign` | その人の同じ日の、時刻が重なる別の作業 | ― | R-012-17 |

- **開始・終了の担当の判定**：`app.my_assignment(tenant, work)`（その作業の担当で、自分の有効な所属を返す）。担当でなければ（社員でも）42501。実績の持ち主は担当した本人
- **同じ uuid の二度目**：開始は、同じ人・同じ作業の実績なら前の結果、それ以外の uuid は 42501（ほかの人の uuid を使い回して触れない）。終了は、開いた実績がなければ `already`（実績が終わっている）
- **取消は行を残す**：010 の「契約の変更で取り消した予定」は `deleted_at` も入れて同じ日に作り直せるが、012 の取消は「その日は行かない」と人が決めたこと。`deleted_at` を入れず、010 の一意の索引が日を押さえる（定時の処理は `on conflict do nothing` で作り直さない）
- **動かした予定**：`reschedule_work` は、定時の処理が作った作業（`run_id` あり）の日を動かすとき、元の日を `moved_from` に覚える（すでに覚えがあれば、途中の日は覚えない。元の日に戻したら消す）。010 の `schedule_insert` に「覚えのある日は作らない」条件を1つ足した（`create or replace`。ほかは 010 のまま）
- **請求書に載った作業の取消**：`app.work_charge_locked`（010・011）で断る
- **版**：開始（予定のとき）・終了（完了にするとき）・行わず・取消・日時の変更が版を 1 上げる。`p_version` を渡す RPC は、古ければ `conflict`（行わず・取消・日時の変更）。担当の付ける・外す・入れ替えは版を上げない（作業の行は変わらない）

## 3. 予実の決め方

- **行っていない作業**：日付が今日（日本時間）より前で、状況が「予定」。**終わっていない作業**：日付が今日より前で「実施中」のまま
- **時刻のずれ**：実績の最初の開始 − 予定の開始（日付と時刻をつなげて、日本時間で比べる。日をまたいでも合う）、最後の終了 − 予定の終了（開いた実績がないときだけ）。分。画面は 30 分以上を「ずれ」とする（`GAP_MINUTES`）
- **行わなかった項目**：報告書の項目のうち、チェック（`done`）のないもの。報告書がなければ 0
- **出ていない報告書**：完了した作業で、報告書が提出になっていない（なし・下書き・確認済み）。015 の `report_missing` の元になる
- **月ごとの集計**：予定の時間は、予定の開始・終了のある作業の差。実績の時間は、終わった実績の差の合計。スタッフごとの労働時間は集計しない（勤怠・給与は範囲の外）

## 4. 端末の入れ物（電波のない間）

- 開始・終了は、**送り箱（`lib/offline` の `Outbox`）に、呼ぶ RPC と引数をためる**（`kind: "rpc"`）。008 の写真・009 の報告書は専用の入れ物だが、012 は「書く行」ではなく「呼ぶ RPC」なので、003 の気づき・006 の小口と同じ送り箱を使う（data-model.md の「電波のない間の操作」）
- 開始の送り箱の印（`id`）は、実績の uuid（端末で作る）。`createSupabaseSender` が `p_id` に渡す。終了の印は別の uuid（開始と終了を同じ送り箱に入れても、同じ ID ではぶつからない）
- 二度押しても1回：同じ作業の開始（終了）がすでに送信待ちなら、新しくためない（`enqueueStart`・`enqueueFinish`）。サーバーでも、同じ uuid は `already`
- 送る順は作った順（開始 → 終了）。電波がなければ止めて残し、戻ったら（`online`・画面が戻ったとき・30 秒おき）自動で送る
- 送った RPC が業務の決まりで断った結果（`ok:false`）は、送り箱の送り手には見えない（送り手は通信の成否だけを見る）。画面は送ったあとに読み直し、サーバーの状況を出す。008・009 の背景の同期の扱いと同じく、画面を開いている間だけ送る

## 5. 画面

| 画面 | 場所 | 内容 | 基準 |
|---|---|---|---|
| 自分の予定 | `/schedule/mine/` | 自分が担当の今日以降の作業。「開始」「終了」（大きなボタン）、送信待ち、報告書への行き来 | R-012-27〜29 |
| 予定表 | `/schedule/` | 日・週・月、スタッフごと・建物ごと、重なりの警告。`work.assign` のない人は自分の予定へ移る | R-012-30・34 |
| 作業の画面 | `/schedule/work/?id=` | 担当の付ける・外す・入れ替え、日付・時刻の変更、行わず・取消、実績 | R-012-31 |
| 作業を足す | `/schedule/new/` | 契約の中身か案件を選んで足す | R-012-32 |
| 予実 | `/schedule/review/` | 月を選び、種類で絞った一覧と、月ごとの集計 | R-012-33 |

- 入口のメニューには、`/schedule/` の1行（予定と実績）だけを足した。010 の `/contracts/works/`（予定の簡単な一覧）は、そのまま残す
- 一覧の取得は、今の会社の `tenant_id` で絞る。接続・権限は `components/useSession.ts` のものを使う。権限の出し分けは見せ方のためだけ（判定は DB）
- 外部の人の専用ページには、012 の区画を足さない（外部の人が読めるのは、010 が登録した「作業の日と状況」だけ）

## 6. 使われているものは消さない

002 の `app.usage_refs`（作業 `scheduled`・`in_progress`）は 012 の状況の値と合っているので、行は足していない。実績は作業に付くだけで、建物・取引先を直接は指さない（R-012-25）。

## 7. テストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-012-1〜26 | DB（pgTAP。本物の Postgres・Docker） | `supabase/tests/25_schedule.sql`、種 `00002_seed_012.sql`（`tests.seed()` から `tests.seed_012()`） |
| 他の会社への漏れ・構造・型の付け忘れ | DB（登録された全部の表に流す） | `01_structure.sql`・`02_leak_all_tables.sql`・`03_policy_types.sql`（`work_records` が自動で入る） |
| R-012-27〜34 の部品 | 単体（Vitest。端末の入れ物は fake-indexeddb） | `apps/web/src/lib/schedule/schedule.test.ts` |
| R-012-27〜34 の画面の流れ | 画面（Playwright + Edge。作業まわりの表と RPC は、このテストが自分で偽の接続先を受ける） | `apps/web/e2e/schedule.e2e.ts` |

- 画面と実際の Supabase との通信は、実際の Supabase が動くまで確かめられない（DB は Docker の本物で確かめた）

## 8. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 状況の変更・開始・終了・足す・入れ替えは RPC だけ。実績は直接書けない | 状況・版・実績・履歴を1つの処理で守るため（010 と同じ） | 表に直接書く（途中で食い違う） |
| 開始・終了の権限は「作業の担当」。担当でない社員も開始・終了できない | crud.md「RPC：作業の担当」と、009 の報告書（R-009-8）と同じ。管理は担当の入れ替えで行う | `work.assign` の人は代わりに押せる（実績の持ち主が曖昧になる） |
| 作業の完了は「開いた実績がなくなったとき」。担当が2人で1人だけ開始・終了した場合は、その人の終了で完了 | 担当の全員の終了を待つと、行かなかった人のせいで完了しない | 担当全員が終えるまで実施中 |
| 終了は「自分の終わっていない実績」を終える（`p_id` は印だけ） | 送り箱は `p_id` を端末の uuid として固定で渡し、開始と同じ ID ではぶつかる。実績の ID を終了で使わない | 終了にも実績の uuid を渡す（開始がまだ届いていない間に、終了がぶつかる） |
| 取消は `deleted_at` を入れず、行を残す | crud.md「取消は status を変えるだけで行は残す」。行を残すと、010 の一意の索引で、定時の処理が同じ日に作り直さない | `deleted_at` も入れる（毎朝の処理が、取り消した日に作業を作り直してしまう） |
| 動かした予定は `moved_from` に元の日を持つ。`schedule_insert` に条件を1つ足す | 動かすと一意の索引から元の日が空き、毎朝の処理が作り直してしまう | 動かした作業の `run_id` を空にする（それでも元の日が空く） |
| 行わず・取消・日時の変更は版を条件にできる（`p_version`） | data-model.md の1章「2人が直すことがある表は版」。画面は版を渡し、`conflict` で読み直す | 版なし（最後の書き込みが勝つ） |
| 重なりは「両方に時刻がある」ものだけ。隣り合う（終わり＝始まり）は重ならない | 時刻のない作業は終日か不明で、警告が多すぎる。隣り合うのは普通の連続 | 時刻のない作業は終日として警告 |
| 重なりは警告で、止めない（付ける前に確かめ、人が決める） | 仕様は「重なりの警告」。同じ現場の掛け持ちなど、重なってよいことがある | 重なるなら断る |
| 予実の「出ていない報告書」は、完了した作業で、提出になっていないもの | 015 の `report_missing` は「担当と確認する人」に知らせる。下書き・確認済みも、外にはまだ出ていない | 報告書が1つもない作業だけ |
| 時刻のずれは 30 分以上を「ずれ」（画面の定数） | 現場の前後は普通に起きる。人が見直す基準として、30 分は妥当（推測。試用で聞く） | 10 分・15 分 |
| 月ごとの集計は建物ごと。スタッフごとの時間は出さない | 勤怠・給与は範囲の外（product.md）。スタッフごとの時間は労働時間の集計になる | スタッフごとも出す |
| 開始・終了の送り先は、送り箱（RPC をためる）。専用の入れ物は作らない | 「呼ぶ RPC と引数」をためる仕組みが送り箱にあり、003・006 が使っている | 009 のような専用の入れ物（RPC のためには作りが重い） |
| 手で足した作業は、元の中身の時刻（`start_time`・`end_time`）を、時刻を渡さなかったときの初めの値にする | 契約の中身の時刻のまま作る作業が多い。渡せば上書きできる | 常に空 |
| 位置の列は置くが、RPC は受け取らない・書かない | 013 が了承の確かめ・距離・警告とあわせて作る（product.md の013）。012 が先に口を開けると、了承なしの位置が入る恐れがある | 位置も受け取る |
