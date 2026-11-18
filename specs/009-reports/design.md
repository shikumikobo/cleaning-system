# 機能009：清掃報告書（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（008・009・012 の章）が正で、ここは 009 での実際の形を書く。マイグレーションは `20261121010000_reports_tables.sql`（表・policy・つなぎ）と `20261121010100_reports_rpcs.sql`（RPC）。

## 1. 表

共通の列（`id`・`tenant_id`・作成と更新の人と時刻・`deleted_at`）と `unique (tenant_id, id)` は data-model.md のとおり。親子は `(tenant_id, 親の id)` の組で参照する。

| 表 | 型 | 主な列と決まり |
|---|---|---|
| `report_templates` ひな形 | A | `building_id`（組の外部キー）、`name`（空・空白だけ・100 字超は保存しない）、`active`。同じ建物で同じ名前（消していない）は 1 つ（部分一意）。直せるのは名前・使う使わない・消す |
| `template_items` ひな形の項目 | A | `template_id`、`area_id`（任意。ひな形の建物の場所だけ。`app.template_area_ok`）、`name`、`sort`、`active`。直せるのは場所・名前・並び順・使う使わない・消す（ひな形は付け替えられない） |
| `reports` 報告書 | C2＋D | `work_id`（組の外部キー。消していない行で一意）、`template_id`（写した元。任意）、`status`（draft・checked・submitted）、`remarks`、`checked_by/at`・`submitted_by/at`、`version`、`client_created_at`・`device_id`（届いた時刻は `created_at`）。`reports_state_ck` で、状況と確認・提出の列の組み合わせを縛る |
| `report_items` 項目のチェック | C2＋D | `report_id`、`template_item_id`（任意）、`area_id`（任意）、`name`・`sort`（ひな形から写した値）、`done`、`note`、`client_created_at`・`device_id` |
| `photos` | （008） | `report_item_id` に `(tenant_id, report_item_id)` の外部キーを足した |
| `works`・`contract_services` | （010） | `report_template_id` に `(tenant_id, id)` の外部キーを足した（索引も） |

## 2. 権限

- **ひな形・項目（型 A）**：読むのは会社の中の人（外部の人は読めない）、書くのは `master.edit`。項目の場所の組み合わせは `template_items` の作る・直す policy が `app.template_area_ok` で確かめる
- **報告書（型 C2＋D）**：持ち主の判定は `app.is_my_work`（010 の `app.is_assigned_to_work` を包んだもの。名前を `is_my_` で始めて、構造のテストが権限の関数と見分ける）。読む＝担当の全員と `work.assign`。作る＝`field.record` を持つ担当で、状況は下書き・確認と提出の列は空・版は 1（`tp_insert` を置き換え）。直す＝下書きの間だけ（`lock_sql`）で、列の権限は `remarks`・`version` だけ。**状況の切り替えは RPC だけ**。行は消せない
- **項目（型 C2＋D）**：持ち主の判定は `app.is_my_report`（報告書の作業の担当）。作る＝`field.record`＋担当＋報告書が下書き。直す＝下書きの間だけで、列の権限は `done`・`note` だけ
- **外部の人（型 D）**：報告書は `status = submitted` で `app.work_external_visible`（許された建物の作業）、項目は `app.report_item_external_visible`。書けない
- **写真（008 の置き換え）**：`app.photo_report_locked`＝項目の報告書の状況が下書きでない。`app.photo_external_visible`＝許された建物・提出済みの報告書の項目につく写真（写真の建物と作業の建物が同じ）。写真の作る policy に「固定された報告書の項目には足せない」「項目は写真の作業の報告書の項目」（`app.report_item_of_work`）を足した

## 3. RPC

どれも `security definer`・`search_path` 固定。権限がない・行がない・別の会社は同じ 42501。業務の決まりで断るときは `{ok:false, reason}`。

| RPC | 権限 | 動き |
|---|---|---|
| `check_report(p_id)` | work.assign | 下書き → 確認済み。確認した人（所属）・時刻・版 +1。二度目は `already`。提出済みは `reason: submitted` |
| `reopen_report(p_id)` | work.assign | 確認済み → 下書き（確認の人・時刻を消す）。版 +1。下書きは `already`。提出済みは `reason: submitted` |
| `submit_report(p_id)` | work.assign | 確認済み → 提出。提出した人・時刻・版 +1。下書きは `reason: not_checked`。二度目は `already` |
| `delete_report_template(p_id)` | master.edit | 作業・契約の中身・報告書が使っていれば、消さずに `active = false`（`blockers` に理由）。使っていなければ項目も一緒に論理削除 |
| `delete_template_item(p_id)` | master.edit | 報告書の項目に写されていれば `active = false`、なければ論理削除 |

建物を消すときのひな形・項目の道連れの論理削除と、場所を「使わない」にする決まりは、002 の `app.usage_refs` に既にある（表ができたので効く）。

## 4. 端末（PWA）

`apps/web/src/lib/reports/`。
- `format.ts`：状況の表記・固定・進み具合・**下書きの組み立て**（`buildReportDraft`）・押せるボタン・文面・並べ替え
- `queue.ts`：端末の入れ物（IndexedDB。`cleaning-reports`）。**報告書ごとに 1 件**で、保存し直すと置き換える。`rev` で「送っている間に直された」を見分ける。送る口（`ReportSender`）を渡して送る（`flushReports`。同時に 2 回呼んでも 1 つ）
- `repo.ts`：Supabase の薄い層と、送る口の本物（`createReportSender`）
- `portal.ts`：専用ページの区画（報告書・報告書の写真）
- `useReportData.ts`：確認・提出と印刷の画面が使う、報告書 1 件の読み込み

送る順は 報告書（`upsert … ignoreDuplicates`）→ 項目（同じ）→ 項目のチェックとメモ（`update`）→ 報告書のメモ（`update … where version = 送る前の版`）。電波がない・ログインが切れていれば止めて残す。写真は 008 の入れ物に、`work_id`・`report_item_id` を足して、**項目の行がサーバーに届くまで待つ**（`PhotoSender.ready`。断られた扱いにしない）。報告書の画面は、写真より先に報告書を送る（`usePhotoEnv` に送る前の処理を渡す口を足した）。

## 5. 画面

| 画面 | 中身 |
|---|---|
| `/reports/` | 作業（2週間前〜明日）を、報告書の状況・進み具合つきで一覧。スタッフは担当の作業、`work.assign` は全員分。「報告書を作る・開く」「確認・提出」 |
| `/reports/edit/?work=` | スマホ。項目のチェック・メモ・前と後の写真・全体のメモ・気づきの写真。変えるたびに端末にため、送る。固定のあとは読むだけ |
| `/reports/review/?id=` | 確認する・下書きに戻す・提出する。写真（小さな画像）を見る。印刷へ |
| `/reports/print/?id=` | A4 の印刷（`window.print`。操作とヘッダーは印刷に出ない） |
| `/reports/templates/` | 建物を選び、ひな形と項目を作る・名前・並べ替え・使わない・消す |
| `/portal/` | 005 の登録簿に「清掃報告書」「報告書の写真」の区画を足した。写真は期限つきの URL（`sign-file-urls`）を新しいタブで開く |

## 6. 決めたこと

- **提出の流れ**：スタッフが作る（下書き）→ 社員が確認（確認済み）→ 社員が提出（提出）。提出は確認のあとだけ。理由：data-model の状況（下書き・確認済み・提出）と、crud の「RPC：確認（work.assign）・提出」を、そのまま 3 段にした。確認を省く短縮は作らない（推奨の案。短縮が要るなら、後から足せる）
- **差し戻し**：確認済みから下書きへ戻す RPC（`reopen_report`）を足した。理由：確認で間違いが見つかったとき、戻せないと直せない（仕様に明記がない。提出のあとは戻せない）
- **報告書の項目に名前・並び順・場所を写して持つ**：data-model の列（`report_id`・`template_item_id`・`done`・`note`）に、`name`・`sort`・`area_id`（と `client_created_at`・`device_id`）を足した。理由：あとでひな形を直しても、出した報告書が変わらないようにする。印刷が、ひな形を読まずに済む
- **ひな形のない作業・使う項目が 0 の作業**：端末が項目「清掃全体」を 1 つ作る。理由：写真は項目につけて外部の人に見せるので、付け先が要る
- **気づきの写真**：項目に付けず、作業だけに付ける（`report_item_id` は空）。理由：気づきは案件にもなる社内の記録で、外部の人には見せない（外部の人が読めるのは項目つきの写真だけ）
- **版（version）**：報告書のメモは `where version = 送る前の版` で直す（画面から。DB の policy は版を比べない）。確認・差し戻し・提出は RPC が版を上げる。サーバーのメモが自分のものと同じなら、メモは送らない（版を無駄に上げない）。食い違ったら端末に残して「ほかの人が直しています」を出す。項目は 1 行ごとに直すので、版は持たない（最後に書いた人が残る）
- **同じ作業に別の端末が別の uuid で作った報告書**：2つめは `reports_work_uq` で断られ、端末に残って理由が出る。画面は、開くときに先にサーバーの報告書を読む（あればそれを開く）ので、ふつうは起きない
- **お知らせ**：「出ていない報告書」は 015 に `report_missing` が既にあるので、種類は足さない。作る処理は波 6
- **外部の人に見せる名前**：確認・提出した人の名前（`profiles`）は、見せ方が決まっていないので、今は見せない
- **送るタイミング**：008 と同じく、報告書・写真の画面を開いている間（変えたとき・電波が戻ったとき・30 秒ごと）。画面を閉じている間は送らない（背景の同期は、波のあとで検討）
