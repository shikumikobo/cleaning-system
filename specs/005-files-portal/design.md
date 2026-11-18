# 機能005：ファイルと専用ページ（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（005 の章）が正で、ここは 005 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の `app.apply_policy`。

## 1. 表：`files`

共通の列（`id`・`tenant_id`・作成と更新の人と時刻・`deleted_at`）と `unique (tenant_id, id)` は、data-model.md の1章のとおり。

| 列 | 中身 | 制約 |
|---|---|---|
| `building_id` | 建物 | 必須。`(tenant_id, building_id)` で `buildings` を指す組の外部キー |
| `request_id` | 案件（003） | 任意。**列だけで外部キーなし**（003 を取り込むときに `(tenant_id, request_id)` の外部キーを足す） |
| `quote_id` | 見積（004） | 任意。**列だけで外部キーなし**（004 を取り込むときに足す） |
| `name` | 画面に出す名前 | 空でない・255 字まで |
| `mime` | 種類（例 `application/pdf`） | 空でない |
| `size` | 大きさ（バイト） | 0 以上 |
| `storage_path` | 置き場所のパス | `<tenant_id>/files/` で始まり、その下に1字以上（check）。`unique (tenant_id, storage_path) where deleted_at is null` |
| `shared_external` | 外部の人に見せるか | 既定 false |

- 索引：`(tenant_id, building_id)`、`(tenant_id, request_id) where request_id is not null`、`(tenant_id, quote_id) where quote_id is not null`
- 置き場所のパスは `<tenant_id>/files/<ファイルの uuid>/<名前>`。uuid を含めるので、同じ名前を二度上げても重ならない。置き場所の名前の部分は、画面に出す名前とは別に、ASCII だけに直す（日本語の名前が置き場所の名前の制約に触れないため。R-005-13）

## 2. 権限（RLS）

`apply_policy('public.files', 'A', {"write_perm": "master.edit", "external_read": "shared_external and deleted_at is null and app.can_external_see_building(tenant_id, building_id)"})`。policy は手で書かない。

| 人 | 読める | 書ける |
|---|---|---|
| 管理者・社員 | 会社のファイルの行すべて | 作る・直す（`master.edit`） |
| スタッフ | 会社のファイルの行すべて | 書けない |
| 外部の人 | 許された建物の、共有された、消していない行だけ | 書けない |
| 運営 | 許可の間だけ（読むだけ） | 書けない |

- **直せる列を絞る**：型 A は update をすべての列に与えるので、作り直して `name`・`shared_external`・`request_id`・`quote_id`・`deleted_at`・`tenant_id`（会社の変更はトリガーが止める。型の漏れのテストが使う）・`updated_at`・`updated_by` だけにする。建物・パス・種類・大きさは、作ったあとは直せない（R-005-5）。別の建物へ移すときは、上げ直す
- **消す**は、CRUD の表のとおり画面から `deleted_at` を入れる（RPC にしない。子の行がなく、使われ方の確かめも要らないため）。RLS は消した行も社員には見せる（001 の決まり）ので、画面は `deleted_at is null` で絞る。外部の人は、型 D の条件で消した行を見ない
- **建物を消すとき**：`app.usage_refs` に `building → cascade → files（building_id = $2）` の1行を足す（002 の消す RPC が、建物と一緒にファイルの行を論理削除する。置き場所のファイルは、掃除が消す）

## 3. 置き場所と期限つきの URL

置き場所は 001 の非公開の `tenant-files`。パスの最初のフォルダが会社の ID のときだけ、社内の人が読み、`master.edit` か `field.record` を持つ人が上げられる（001 の policy。005 では変えない）。外部の人は置き場所を直接は読めない（R-005-8）。

### Edge Function `sign-file-urls`

- 呼び方：`POST {"ids": ["<uuid>", …], "expires_in": 600}`（`Authorization: Bearer <ログインの鍵>`）。返り値：`{"urls": {"<id>": "<URL>"}, "not_found": ["<id>", …], "expires_in": 600}`
- 流れ：①ログインの鍵で `files` を `id in (…) and deleted_at is null` で読む（**RLS が、見える行だけを決める**。外部の人は共有されたものだけ）②見えた行の `storage_path` を、まとめて1回の `createSignedUrls(paths, expires_in)` に渡す ③見えなかった ID は `not_found` に入れる（別の会社・共有なし・消した行を区別しない。R-005-10）
- 判断は `supabase/functions/_shared/files.ts` の `handleSignFileUrls`（Deno に依存しない）。ログインの鍵での読み出しと署名は、引数で渡す口（単体のテストでは偽の口）。口は `files_adapters.ts` に置く
- 期限は、指定がなければ 600 秒、最長 3600 秒（長すぎる指定は 3600 に丸める）。ID は 1〜100 個、uuid の形のもの

### 掃除：`sweep-files`（定時。毎日）

DB 側の関数（すべて `security definer`・`search_path` 固定・service_role だけが実行できる。R-005-18）と、Edge Function（service_role。Storage の API で消す）に分ける。Storage の表は DB から直接は消せない（Supabase の決まり）ので、消すのは Edge Function。

| 関数 | 中身 |
|---|---|
| `file_sweep_tenants()` | 消していない会社の ID の一覧 |
| `file_sweep_start_run(tenant)` | `job_runs`（種類 `sweep_files`）に `running` の行を作り、ID を返す。すでに同じ会社で動いていれば null（部分の一意索引。30 分を過ぎた古い `running` は失敗で閉じる） |
| `file_sweep_orphans(tenant, grace, limit)` | 消す対象のファイルのパスの配列（R-005-14・16）。`<tenant>/files/` の下で、`grace`（初めは 1 日）より前に作られ、生きている行も、`grace` の間に消した行も持たないもの |
| `file_sweep_rows(tenant, grace)` | 猶予より前に作った行で、置き場所にファイルがないものを論理削除し、件数を返す（R-005-15。変更の履歴の source は `job`） |
| `file_sweep_finish_run(tenant, run, status, counts, error)` | 記録を閉じる |

流れ（会社ごと）：`start_run` → `orphans` → Storage の `remove(paths)`（まとめて）→ `rows` → `finish_run(success, {removed, rows_deleted})`。例外は `failure` で閉じ、次の会社に進む。エラーの文字は鍵や長い文字列を伏せる（015 の `sanitizeError` と同じ形）。判断は `_shared/files.ts` の `runFileSweep`、口は `files_adapters.ts`。

- 関数は会社を引数にして、その会社の行だけを触る。別の会社の行は触らない
- 置き場所の写真（`photos/`）・レシート（`receipts/`）は、それぞれの機能が掃除する。この掃除は `files/` の下だけ（R-005-16）

### 上げる順（画面）

1. ファイルの uuid を作り、パスを組み立てる
2. `storage.upload(path, file)`
3. 成功したら `files` に行を作る（`id` は手順 1 の uuid）
4. 手順 3 が失敗したら、`storage.remove([path])` を試みる（失敗しても、掃除が拾う）。手順 2 が失敗したら行は作らない

「上げてから行を作る」ことを DB は強制しない（行の作成時に置き場所を見る仕組みは、業務の決まりをトリガーに置くことになるため）。順序の崩れは、掃除（猶予の 1 日の後）が直す。

## 4. 外部の人の専用ページ

### 読む範囲（型 D）

専用ページに新しい表・RPC は作らない。外部の人は、既存の表を**自分の権限（RLS）**のまま読む。

- `buildings`：許された建物の名前・住所（002 の型 D）
- `files`：許された建物の共有された行（上の policy）
- 見積・報告書・作業は、004・009・012 が自分の型 D で足す。足すと、専用ページの区画から読める

読めてはいけないものは、DB のテストで確かめる（`supabase/tests/52_external_portal.sql`）。

- R-005-23：カルテ・部屋・場所・取引先・担当者・小口・レシートなど、今ある表を名前で確かめる。まだ表がない金額・担当・実績・位置の表（`request_charges`・`work_charges`・`work_assignments`・`work_records` など）は、`to_regclass` で表があるものだけ確かめる（ない間は飛ばし、表ができたら自動で入る）
- R-005-24（型 D の決まり）：登録された全部の表（`app.policy_registry`）を回し、外部の人が読めるのは、`+D` の表と、自分の所属・自分に許された建物・自分の会社だけであることを確かめる。`+D` の表のうち `building_id` を持つものは、読めた行がすべて許された建物のものであることも確かめる。後の機能の表は、型を付けて種を足すだけで、この確かめに入る
- 建物の `lat`・`lng` は、002 の決めたとおり建物の表から外部の人にも読める（RLS は列を隠せない）。専用ページの画面は `id`・`name`・`address` の列だけを取り、位置を出さない（R-005-25）。位置を外部にも隠すなら、建物の位置を別の表に分ける必要がある（002 の設計を変える。報告に書いた）

### 画面

- 入口：ホーム（`/`）は、役割が `external` のとき `/portal/` に移す（`homeFor` の純粋な関数で決める。R-005-26）。ホームの社内のメニューは、外部の人には出さない
- `/portal/`：許された建物（名前・住所）を一覧にし、建物ごとに区画を並べる。区画の登録簿 `portalSections`（`apps/web/src/lib/files/portal.ts`）は `{id, title, load(sb, building), render}` の並び。005 は「共有されたファイル」の区画だけを登録する。004・009・012 は、自分の区画をこの並びに1つ足す（足す側のテストは、区画が建物の ID だけで描けることを確かめる。R-005-28）
- 社内の人が `/portal/` を開いたら、外部の人用の画面だと出して、社内のホームへの戻りを出す。専用ページが取る「許された建物」は、`external_building_access` と `buildings` から、その人の権限のまま取る
- ファイルの名前を押すと、`sign-file-urls` で URL を取り、開く

### 外部の人の「承認」を押す形：今は作らない

見積の承認を専用ページで押せるか（crud.md の決まっていないこと 12）。**今は作らず、社員が記録する**（推奨の案）。

| 案 | 中身 | 選んだとき |
|---|---|---|
| A. 作らない（選ぶ） | 取引先から返事（メール・電話・書面）をもらった社員が、004 の承認の RPC で記録する | 外部の人の画面に、書き換える操作が一切ない（R-005-21・29）。型 D は「外部は書けない」のまま。テストも「外部は何も書けない」だけで済む |
| B. 作る | 外部の人が専用ページで「承認」を押すと、RPC 1つ（`approve_quote_as_external`）が見積を承認にする | 外部の人が契約の成立に関わる。本人確認（メールのリンクだけで足りるか）、承認した人の記録（`approved_by` に外部の所属を入れる）、取り消せない承認の誤クリック、契約の自動作成（010）への影響、承認の通知（015）の宛先が決まる前に、書き換えの口を開けることになる |

- 理由：承認は、金額と契約に関わる取り消しにくい操作で、004（見積）・010（契約）の設計がそろってから決める方が安全。今 RPC を足すと、外部の人が書ける唯一の口になり、型 D の「外部は書けない」を崩す。A でも業務は回る（社員が記録する）
- B にするとき：`approve_quote_as_external(p_quote)` を 1 つ。中で `app.is_external` と `can_external_see_building`、見積の状況が「提出」であること、見積が自分に見せる範囲であることを確かめ、承認者に外部の所属を記録し、同じトランザクションで社員への知らせ（`app.enqueue_notification`）を作る。DB のテストは「許された建物の提出の見積だけ」「二度目は何もしない」「別の外部の人・別の会社は 42501」。専用ページの見積の区画（`portalSections`）に承認のボタンを足す

## 5. 社内の画面

`apps/web/src/app/` に、静的書き出しに合うようパスは固定で、建物は `?building=` で渡す。

| 画面 | パス | 主な操作 | 基準 |
|---|---|---|---|
| 建物ごとのファイル | `/files/` | 建物を選ぶ、一覧、上げる、共有のオンとオフ、開く、消す | R-005-30〜36 |
| 専用ページ | `/portal/` | 許された建物と共有されたファイル | R-005-26〜28 |

- 入口のメニュー（`/`）に「ファイル」のリンクを1行足す（社内の人だけ）。ファイルを建物の画面（`/buildings/edit/`）には埋め込まない（002 の画面を直さない）
- 画面の中身は `apps/web/src/lib/files/`：純粋な関数（`format.ts`：名前の検査・大きさと種類の表記・並べ替え、`portal.ts`：入口と区画の登録簿、`upload.ts`：上げる順）と、Supabase を呼ぶ薄い層（`repo.ts`）。会社は 001 の `useSession` の今の会社。一覧の取得は今の会社の `tenant_id` で絞る
- 操作の出し分け（R-005-35）は `session.perms` に `master.edit` があるかで見せ方を決める。判定は DB

## 6. テストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-005-1〜8 | DB | `supabase/tests/50_files.sql` |
| R-005-14〜18 | DB | `supabase/tests/51_files_sweep.sql` |
| R-005-19〜24 | DB | `supabase/tests/52_external_portal.sql`（種は `tests.seed_005()`。`00002_seed_005.sql`） |
| R-005-9〜12 | 単体（Vitest。偽の口） | `apps/web/tests/files-functions.test.ts` |
| R-005-13・17（流れ）・25・26・28・31・36 | 単体 | `apps/web/src/lib/files/files.test.ts`・`apps/web/tests/files-functions.test.ts` |
| R-005-26・27・30〜35 | 画面の流れ（Playwright。偽の接続先に、通信を足して上書き） | `apps/web/e2e/files.e2e.ts` |

## 7. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| ファイルは必ず建物に付ける（`building_id` 必須） | 外部の人に見せる単位が建物。建物のないファイルは、外部に共有できず置き場がない | 建物を任意にする（外部に見せるとき困る） |
| `request_id`・`quote_id` は列だけ（外部キーなし） | 003・004 を並列で作っていて、まだ表がない。取り込みのときに足す（報告に書いた） | 先に仮の表を作る |
| 建物・パス・種類・大きさは作ったあと直せない | 置き場所の実体と行がずれないように。移すときは上げ直す | 直せるが、実体は動かさない（ずれる） |
| 消すのは画面から `deleted_at`（RPC にしない） | CRUD のとおり。使われ方の確かめがない | 消す RPC を作る |
| 期限つきの URL は、ログインの鍵で `files` を読んで見える行を決め、署名だけ service_role | 外部の人は置き場所を直接は読めない決まり（R-005-8）なので、署名はその人の鍵ではできない。見える行の判断は RLS に任せ、署名に渡すのは見えた行のパスだけ。constitution の「service_role は会社をまたぐ定時の処理だけ」の例外になる（報告に書いた） | 外部の人にも置き場所を読ませる（001 の決まりに反する）。署名を作る RPC（DB は署名できない） |
| 期限の初めは 10 分、最長 1 時間。ID は 100 個まで | 開くための URL は短くてよく、使い回されにくい。1回の呼び出しの大きさを抑える | 長い期限 |
| 見えない ID は区別せず `not_found` | 存在を探らせない（002 の消す RPC と同じ考え） | 理由を返す |
| 掃除の猶予は 1 日 | 上げている途中（置き場所には上がったが行がまだ）のファイルを消さない。電波のない端末の遅れも含めて 1 日を目安にする | 猶予なし（上げ直しで困る）。長くする |
| 置き場所の掃除は Edge Function（Storage の API）、洗い出しは DB の関数 | Storage の表は DB から消せない。会社をまたぐ定時の処理は service_role で、会社ごとに分けて回す（constitution の1章） | DB の関数だけ（消せない） |
| 専用ページは、新しい表・RPC を作らず、既存の表を外部の人の権限のまま読む | 型 D の決まりだけで守る。画面の書き漏れが漏れにならない | 専用ページ用の view や RPC |
| 専用ページは区画の登録簿で組み立てる | 004・009・012 が自分の区画を足すだけで、同じページに出る（005 を直さない） | ページごとに作る |
| ホームで外部の人を `/portal/` に移す（画面側） | 外部の人は社内のメニューを使えない。判定ではなく見せ方のため | ログインの直後に移す（AuthProvider を直す） |
| 外部の人の「承認」は今は作らない（4章） | 外部の人の書き込みの口を開ける前に、004・010 の設計と本人確認を決めたい | 今作る |
| 建物の位置が外部の人にも読める件は、002 のままにして報告する | 005 の範囲外。直すなら建物の表の分け方を変える | 位置を別の表にする（002 の変更） |
