# 機能001：会社と利用者（設計）

要件は [requirements.md](requirements.md)。基準の番号（R-001-n）で対応を書く。表と policy の型は [../data-model.md](../data-model.md) が正で、ここは 001 での実際の形を書く。

波 0（土台と DB）と波 1（画面と招待のメール）で作った。

## 1. 表

どの表も `tenant_id` を持つ（原則の2章）。例外は、会社そのもの（`tenants`。`id` が会社の ID）、共通のマスタ（`roles`・`permissions`・`role_permissions`）、人（`profiles`）。共通の列（`id`・作成と更新の人と時刻・`deleted_at`）は data-model.md の1章のとおり。

| 表 | 型 | 列（共通の列を除く） | 説明 | 基準 |
|---|---|---|---|---|
| `tenants` | E | name、address、phone、invoice_reg_no（`T` ＋13桁の check）、status（trial・active・suspended）、trial_ends_at | `id` が会社の ID。運営が `create_tenant` で作る | R-001-1・5 |
| `offices` | A | name、address | 書けるのは `user.manage`。名前は、消していない行で会社の中で一意 | R-001-5 |
| `profiles` | P | id（= auth.users の id）、display_name | メールは持たない。見られるのは本人と、同じ会社の有効な所属を持つ人（双方とも外部を除く） | R-001-8 |
| `roles` | M | code（admin・member・staff・external）、name | 共通のマスタ。マイグレーションだけが書く | R-001-24 |
| `permissions` | M | code、name | 権限の10個 | R-001-24 |
| `role_permissions` | M | role_id、permission_id | 役割 × 権限（data-model.md の表のとおり） | R-001-24 |
| `memberships` | E | user_id、role_id、office_id、client_id、status（invited・active・suspended） | `unique (tenant_id, user_id)`。権限の判定は毎回ここを見る。`client_id` の外部キーは 002 で足す | R-001-8・14〜18 |
| `invitations` | E | email（小文字）、role_id、office_id、token_hash（sha256 の16進）、expires_at、accepted_at | 鍵はハッシュだけ持つ。取り消しは `deleted_at`。同じ会社・同じメールの有効な招待は1つ | R-001-7〜12 |
| `external_building_access` | E | membership_id、building_id | 外部の人が見られる建物。`building_id` の外部キーは 002 で足す | R-001-18 |
| `support_access_grants` | E | granted_by、reason、starts_at、ends_at、revoked_at | 管理者が期間つきで許す | R-001-2〜4 |
| `audit_logs` | E | table_name、row_id、action、changed、actor、source、request_id、at | トリガーだけが書く。update・delete・truncate はデータベースの持ち主でも拒否する | R-001-26〜28 |
| `job_runs` | E | kind、started_at、ended_at、status、counts、error | 会社ごと・1回ごと | R-001-29 |
| `client_error_logs` | C1 | membership_id、device_id、app_version、kind、message、context、at、received_at | 端末が書き足すだけ（`id` は端末の uuid） | R-001-33 |
| `document_counters` | E | kind、year、last_no | `unique (tenant_id, kind, year)`。画面からは読めない | （004・011 が使う）|

- 親は `unique (tenant_id, id)` を持ち、子は `(tenant_id, 親の id)` の組で外部キーを張る（`memberships`→`offices`、`external_building_access`→`memberships`、`client_error_logs`→`memberships`、`invitations`→`offices`）。DB のテストが、すべての表でこの組と索引を確かめる（R-001-20）
- 追加した仕組み（表ではない）：`app.policy_registry`（どの表に何の型を付けたか。「付け忘れ」を止めるテストが使う）

## 2. 権限（RLS）

policy は、表ごとに書かず、`app.apply_policy(表, 型, 項目)` から作る。名前はすべて `tp_` で始まる（`tp_select`・`tp_insert`・`tp_update`・`tp_support_select`・`tp_external_select`）。判定の関数は `has_perm`（`public`、stable）と、`app` の `is_internal`・`is_external`・`is_support_viewer`・`is_owner_membership`・`my_tenant_ids`。

| 型 | 読める人 | 書ける人 | 項目 |
|---|---|---|---|
| A 業務 | 会社の中の人（外部を除く）。`read_scope` があれば、それを満たす行か `read_bypass` の権限を持つ人 | `write_perm` を持つ人。`lock_sql` を満たす行だけ（直したあとの行も） | `write_perm`・`lock_sql`・`read_scope`・`read_bypass` |
| B 金額 | `amount.read` を持つ人 | `write_perm` を持つ人 | `write_perm`・`lock_sql` |
| C1 本人 | 持ち主の本人と `supervise_perm`（既定 `work.assign`）を持つ人 | 持ち主の本人（`write_perm` があればその人も）。`insert_only` なら書き足すだけ | `owner_col`・`supervise_perm`・`write_perm`・`lock_sql`・`insert_only` |
| C2 作業の担当 | `scope_fn` が真の人（その作業の担当）と `supervise_perm` を持つ人 | `scope_fn` が真の人 | `scope_fn`・`scope_col`・`lock_sql` |
| D 外部に見せる | A・B・C に足す。外部の人は `external_read` を満たす行だけ | 外部の人は書けない | `external_read` |
| E 管理 | `read_perm`（既定 `user.manage`）を持つ人と、`own_row_sql` を満たす自分の行 | RPC と Edge Function だけ（policy を作らず、authenticated から insert・update の権限を外す） | `read_perm`・`own_row_sql` |

すべての型で共通：

- 運営は `app.is_support_viewer(tenant)`（JWT の `app_metadata.operator` ＋ 期間内で取り消されていない許可）のときだけ、すべての表を読める（`tp_support_select`）。書けない（R-001-2〜4）
- authenticated に delete の権限と policy を付けない（論理削除は update）。anon には何も付けない（R-001-19・23）
- 行の会社（`tenant_id`）を変えるトリガー `tp_no_tenant_change`（2つの会社に入っている人が行を別の会社へ移せないように）（R-001-19）
- 型 A・B・E には変更の履歴のトリガー `tp_audit`（`audit: false` で外す。履歴の表自身だけ）。型 C には付けない（R-001-26）
- `updated_at`・`updated_by` を更新するトリガー `tp_touch`

001 の表への割り当て：

| 表 | 操作 | だれが | 条件 | 基準 |
|---|---|---|---|---|
| tenants | 読む | 所属する全員（自分の会社）、管理者、運営（許可の間） | 型 E の `own_row_sql`（`id in my_tenant_ids()`） | R-001-17 |
| tenants | 直す | 管理者 | RPC `update_tenant_info` だけ | R-001-5・6 |
| offices | 読む | 会社の中の人 | 型 A | R-001-19 |
| offices | 作る・直す | `user.manage` | 型 A | R-001-23 |
| profiles | 読む | 本人、同じ会社の人（外部を除く） | `app.can_see_profile` | R-001-19 |
| profiles | 直す | 本人（表示名だけ） | 列の権限と policy | |
| roles・permissions・role_permissions | 読む | ログインした人 | 型 M | R-001-24 |
| memberships | 読む | 管理者、本人の有効な行、運営（許可の間） | 型 E | R-001-17 |
| memberships | 作る・直す | 招待の受け入れ・役割の変更・止めの RPC だけ | | R-001-8・14〜16 |
| invitations | 読む | 管理者 | 型 E | R-001-12 |
| external_building_access | 読む | 管理者、外部の本人 | 型 E | R-001-18 |
| support_access_grants | 読む | 管理者、運営（許可の間） | 型 E | R-001-2〜4 |
| audit_logs | 読む | 管理者、運営（許可の間） | 型 E | R-001-28 |
| job_runs | 読む | 管理者、運営（許可の間） | 型 E | R-001-29 |
| client_error_logs | 読む | 持ち主の本人、`work.assign` を持つ人 | 型 C1 | R-001-33 |
| client_error_logs | 作る | 持ち主の本人 | 型 C1（`insert_only`） | R-001-33 |
| document_counters | 読む・書く | だれも（RPC の中の `app.next_doc_no` だけ） | 型 E（`read_perm: none`） | |
| storage.objects（`tenant-files`） | 読む | 会社の中の人（外部を除く）、運営（許可の間） | パスの最初のフォルダ = 会社の ID | R-001-21 |
| storage.objects（`tenant-files`） | 上げる・直す・消す | `master.edit` か `field.record` を持つ人 | 同上 | R-001-21・23 |

## 3. 画面

波 1 で作った。

| 画面 | パス | 主な操作 | 基準 |
|---|---|---|---|
| ログイン | `/login` | メールを入れてリンクを送る（パスワードなし） | R-001-13 |
| 招待を受ける | `/invite` | 鍵のリンクを開き、表示名を入れて所属する | R-001-8・9 |
| 利用者の管理 | `/settings/users` | 招待、役割の変更、止める、取り消し、外部の人の建物 | R-001-7・11・12・14〜16・18 |
| 会社の情報 | `/settings/tenant` | 名前・住所・電話・登録番号を直す。運営の閲覧を許す・取り消す | R-001-3〜6 |
| 会社の切り替え | ヘッダー | 所属する会社を選ぶ | R-001-17 |
| 送れていない件数 | ヘッダー（`PendingBadge`） | 件数を出す（波 0 で作った） | R-001-32 |

## 4. サーバーの処理

DB の関数（RPC。すべて `security definer`・`search_path` 固定。中で `has_perm` を確かめる）：

| RPC | 呼ぶ人 | 中身 | 基準 |
|---|---|---|---|
| `create_tenant(name, admin_email, trial_days)` | 運営（service_role だけ） | 試用の会社と、最初の管理者の招待（鍵を一度だけ返す） | R-001-1 |
| `create_invitation(tenant, email, role_code, office)` | `user.manage` | 7日の招待を作り、鍵を一度だけ返す。DB にはハッシュだけ | R-001-7・10・12 |
| `revoke_invitation(id)` | `user.manage` | 使われていない招待を取り消す | R-001-11 |
| `accept_invitation(token, display_name)` | ログインした本人 | 鍵とメールが合えば、profile と所属を作る。理由によらず同じ答えで断る | R-001-8・9 |
| `change_member_role(membership, role_code)` | `user.manage` | 役割を変える。最後の管理者は変えない | R-001-14・16 |
| `set_member_status(membership, status)` | `user.manage` | 止める・戻す。最後の管理者は止めない | R-001-15・16 |
| `update_tenant_info(tenant, …)` | `user.manage` | 会社の情報を直す | R-001-5・6 |
| `grant_support_access`・`revoke_support_access` | `user.manage` | 運営の閲覧を期間つきで許す・取り消す | R-001-3・4 |
| `set_external_building_access(membership, building_ids)` | `user.manage` | 外部の人が見られる建物を、まとめて決める | R-001-18 |
| `app.next_doc_no(tenant, kind, year)` | 見積・請求の RPC の中だけ | 番号を振る（`on conflict` で足す） | |

Edge Function（波 1）：

| 処理 | 呼ぶ時 | 中身 | 基準 |
|---|---|---|---|
| 会社を作る道具 | 運営がコマンドで | `create_tenant` を service_role で呼び、返った鍵で招待のメールを送る | R-001-1 |
| 招待のメール | 管理者が招待したとき | 操作した人の鍵で `create_invitation` を呼び、鍵つきのリンクをメールで送る | R-001-7 |

## 5. テストの方法

| 基準 | テストの種類 | 置き場所 |
|---|---|---|
| R-001-1・5〜12 | DB（pgTAP） | `supabase/tests/10_tenants_invitations.sql` |
| R-001-13 | DB（pgTAP）・設定 | `10_tenants_invitations.sql`（`auth.users` のトリガー）、`supabase/config.toml` |
| R-001-14〜18・24・25 | DB（pgTAP） | `11_members_permissions.sql`、`03_policy_types.sql` |
| R-001-2〜4・19 | DB（pgTAP）。登録された全部の表に流す | `02_leak_all_tables.sql`、`13_storage.sql` |
| R-001-20・22・23 | DB（pgTAP）。全部の表の構造 | `01_structure.sql`、`03_policy_types.sql` |
| R-001-21 | DB（pgTAP） | `13_storage.sql` |
| R-001-26〜29 | DB（pgTAP） | `12_audit_jobs.sql` |
| R-001-30〜33 | 単体（Vitest）。DB の側は pgTAP | `apps/web/src/lib/offline/offline.test.ts`、`14_offline_idempotency.sql` |
| 画面の流れ（ログイン、招待から所属まで、利用者の管理、会社の情報、運営の閲覧、会社の切り替え、送れていない件数） | 画面（Node 版 Playwright。Edge）。接続先は偽物に差し替える | `apps/web/e2e/screens.e2e.ts` |
| 画面から呼ぶ層・エラーの文言・送り箱と所属 | 単体（Vitest） | `apps/web/src/lib/api.test.ts`・`errors.test.ts`・`offline/membership.test.ts` |
| Edge Function（招待のメール・会社を作る） | 単体（Vitest。Deno に依存しない `_shared/handlers.ts`） | `apps/web/tests/functions.test.ts` |

- DB のテストの共通の部品は `supabase/tests/00000_helpers.sql`（`tests.run_as(利用者, SQL)` ほか）。後の機能は `tests.seed()` に自分の表の会社ごとの行を足すと、`02_leak_all_tables.sql` の全表の確かめに自動で入る（行がない表は、テストが失敗して知らせる）
- 本物の実行は `supabase test db`（pgTAP。CI）。Docker が動かないときの仮の検証として `node tools/pglite/run.mjs`（PGlite で migration とテストを流す。pgTAP の代わりに最小の版を使う）

## 6. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 運営の印は、JWT の `app_metadata.operator = "true"`（利用者が自分では書き換えられない領域）。許可の期間の判定は DB の関数 | 運営を所属や役割にしない決まりを守りつつ、DB の中で判定できる。データ側に運営の表を作らなくて済む | 運営の利用者を表に持つ（表が増える） |
| policy は `app.apply_policy` で型から作り、`app.policy_registry` に登録する。登録の型は A・B・C1・C2・E（＋D）と、共通のマスタ M・人 P | 付け忘れ・手書きの policy を、テストで止められる。M と P は表が少なく型にしないが、登録は要る | 型の登録なしで、テストが `pg_policies` だけを見る |
| 書き込みを許さない型 E は、policy を作るだけでなく、authenticated から insert・update の権限も外す | policy の書き漏れがあっても書けない（二重の守り） | policy だけ |
| authenticated に delete を与えない | 業務のデータは論理削除だけ（原則）。消す policy を作らなければ、書き漏れも起きない | 型ごとに delete の policy |
| 行の `tenant_id` を変えるトリガーを全部の型の表に付ける | 2つの会社に入っている人が、`with check` を両方の会社で満たして行を移せてしまうため | RLS だけで防ぐ（できない） |
| 履歴の `request_id` は、トランザクションごとに1つ。`source` は設定 `app.source`（RPC が `rpc` にする）か、service_role なら `job`、それ以外は `ui` | 1つの操作の変更をまとめて追える。表ごとに書き分けない | 呼び出しごとに引数で渡す |
| 履歴は、データベースの持ち主・service_role も update・delete・truncate できない（トリガーで拒否） | 「だれであっても直させず消させない」（R-001-27） | RLS だけ（持ち主には効かない） |
| 招待の鍵は DB の中で作ってハッシュを持ち、元の鍵は返すときだけ。受け入れは、ログインのメールと招待のメールが同じ場合だけ。期限切れ・使用済み・取り消し・別のメール・知らない鍵は同じ答え | 鍵は保存しない（R-001-10）。リンクが漏れても別の人は使えない。招待があるかを探れない | 鍵を Edge Function で作る |
| 受け入れで、すでにある表示名は上書きしない | 2つ目の会社に入るとき、名前が勝手に変わらないように | 招待のたびに更新 |
| `memberships.status` の `invited` は、001 では使わない（招待は `invitations` が持つ）。値は data-model.md のとおり check に残す | 利用者がまだいない時点では所属の行を作れない | 招待の時点で所属を作る |
| 会社の作成は RPC `create_tenant`（service_role だけ）。試用は 30 日（引数で変えられる） | 運営は Edge Function から呼ぶ（requirements の 5章の推奨）。試用の長さは仕様にないため、変えられる引数にした | 画面から作る（007） |
| ログインがパスワードを使わないことを、`auth.users` のトリガーでも守る（パスワードのある行を作らせない） | 「常に使わない」を設定の漏れに関係なく守る。メールのリンクの利用者は空のパスワードで作られる | 設定だけ。Edge Function だけで守る |
| 最後の管理者の守りは、管理者の行を鍵で押さえてから数える | 2人の管理者が同時に互いを外す競合を防ぐ | 数えるだけ |
| インボイスの登録番号は `T` ＋13桁を check にする | 帳票（011）が使う形。空は null にそろえる | 形を問わない |
| 置き場所は `tenant-files`（非公開）の1つ。外部の人は直接読めず、期限つきの URL（Edge Function）で渡す | 外部に見せるファイルは `shared_external` の行で決まり、置き場所の policy は行を知らない | 外部にも読む policy を付ける |
| 二度目は何もしない RPC の形は、端末の uuid を行の `id` にして `on conflict (id) do nothing` ＋既にある行を返す。専用の重複の表は作らない | data-model.md の決まり。表を増やさず、行そのものが重複の防ぎになる | 呼び出しの記録の表 |
| 端末のエラーは、サーバーに断られたときだけ、同じ送り箱に `client_error_logs` の行として入れる。電波がない・ログインが切れているだけのときは記録しない。同じ中身は繰り返さない。記録そのものが断られても、さらには作らない | 電波がない間は失敗が当たり前で、記録が溢れる。記録が記録を作る暴走を止める | 失敗のたびに記録 |
| 送り箱は IndexedDB（`items`・`meta`）。順は作った順。1つが断られても次を送る。つながらなければそこで止める | 要件 5章の推奨。1件の不具合が全体を止めないが、電波がないときに全部を試して無駄にしない | localStorage |
| 関数の実行権限は `app.lock_functions()` で anon・public から外し、必要なものだけ明示的に grant する。テストが「anon・public が実行できる関数がない」ことを確かめる | PostgreSQL は新しい関数に public の実行を付けてしまう。新しい migration でも、テストで気づける | 関数ごとに手で revoke（漏れる） |
| Docker が動かないときの仮の検証として PGlite の道具を置く（`tools/pglite`）。本物は `supabase test db` | この PC では、Supabase の CLI が署名なしで止められ、Docker も起動しなかった。仮の検証でも同じ SQL とテストを流せる | 検証しない |
| 招待のメールは、Supabase のログインのメール（`signInWithOtp`）で送る。招待の鍵は、リンク `/invite/?token=…` の中だけに入れ、メールの送り先を `Mailer` に隠す | 試用の間は送信の専用のサービスが要らない。受け取った人はリンク1つでログインと招待の画面に着く。本番の前に `Mailer` の実装だけを替える。Edge Function は鍵を呼び元に返さない | 専用のメールのサービスをすぐ使う（費用と設定が要る） |
| 招待のメールの Edge Function は、操作した人の `Authorization` で DB を呼び、service_role を持たない。会社を作る Edge Function だけが service_role を使い、先に JWT の `app_metadata.operator` をサーバー側で確かめる | `create_tenant` は service_role だけが呼べる（DB の決まり）。招待は RPC の中の権限の判定（`user.manage`）に任せる | 招待も service_role で呼ぶ（権限の判定が Edge Function に移る） |
| ログイン画面は `shouldCreateUser: false`。招待のメールだけが、まだ利用者のいない人のログインを作る | 招待されていない人が、勝手に利用者になれない | 画面からも作れるようにする |
| 画面は静的な書き出しで、Supabase のクライアント（anon の鍵）が直接 RLS つきで読む。会社ごとの絞り込み（`tenant_id`）を、API の層で必ず付ける | 静的な配信の決まり。RLS が最後の守りで、2社に入っている人にも選んだ会社の分だけを見せる | 画面の専用のサーバー |
| 選んだ会社は、この端末の localStorage に覚える（見つからなければ最初の所属） | 次に開いたとき同じ会社で始まる | 毎回選ぶ |
| 管理者の判定の画面側は、所属の役割が `admin` かどうか。権限は `has_perm` が正で、画面は見せる・見せないだけ（R-001-12・23） | 画面の隠しは便利のためで、守りは DB。今の権限の割り当てでは `user.manage` は管理者だけ | 権限の一覧を取って判定（呼び出しが増える） |
| 外部の人の建物は、建物の登録（002）ができるまで、建物の ID（uuid）を1行に1つ入れる形にした | 建物の表がまだない。002 で建物を選ぶ画面に替える | 外部の人の画面を 002 まで作らない |
| 画面のテストは、Node 版 Playwright（Edge）で、書き出した画面を小さなサーバーで配り、Supabase への通信（auth・rest・rpc・functions）を偽の接続先に差し替える。DB の中身は PGlite と pgTAP が確かめる | Docker が動かない。画面のテストは画面の流れと、渡す引数・出す文言を確かめるのが役目 | 本物の Supabase（Docker が動いてから CI で足せる） |
| PGlite の道具は、Node 24 では `node --liftoff-only` で動かす（既定だと WASM のコンパイルで落ちる） | この PC の Node 24 で確かめた回避 | Node の版を替える |
