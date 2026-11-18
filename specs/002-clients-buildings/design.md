# 機能002：取引先・建物・部屋（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（002 の章）が正で、ここは 002 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の `app.apply_policy`。

## 1. 表

共通の列（`id`・`tenant_id`・作成と更新の人と時刻・`deleted_at`）と `unique (tenant_id, id)` は、data-model.md の1章のとおり。親への参照は `(tenant_id, 親の id)` の組。一意の制約は、消していない行だけ。

| 表 | 型 | 列（共通の列を除く） | 制約・索引 | 基準 |
|---|---|---|---|---|
| `clients` | A | kind（`management_company`・`owner`）、name、address、phone、email、closing_day（1〜31。31 は月末）、payment_terms | name は空でない。email は形の check。`(tenant_id, name)` の部分一致（pg_trgm の gin） | R-002-1・2・21 |
| `client_contacts` | A | client_id、name、email、phone | `(tenant_id, client_id)` の外部キーと索引。name は空でない | R-002-3・5 |
| `buildings` | A＋D | client_id（依頼元・必須）、owner_client_id（任意）、name、address、lat、lng、location_fixed（既定 false） | 依頼元・所有者とも組の外部キー。lat・lng は両方か両方空・範囲の check。name の trgm 索引。外部の人は `app.can_external_see_building(tenant_id, id)` の行を読む | R-002-4〜6・9・21 |
| `building_profiles` | A | building_id、entry、key_place、parking、garbage_days、manager_contact、cautions | `unique (tenant_id, building_id) where deleted_at is null`（1対1） | R-002-7・8 |
| `rooms` | A | building_id、room_no、floor、active（既定 true） | `unique (tenant_id, building_id, room_no) where deleted_at is null`。入居者の名前の列は持たない | R-002-10・12 |
| `building_areas` | A | building_id、name、sort（既定 0）、active（既定 true） | `unique (tenant_id, building_id, name) where deleted_at is null` | R-002-11・12 |

- 001 で保留していた外部キーを足す：`memberships (tenant_id, client_id) → clients`、`external_building_access (tenant_id, building_id) → buildings`（R-002-5）。外部キーの列には索引を付ける
- 位置の列（lat・lng・location_fixed）は 013 が書く。ここでは check だけ

## 2. 権限（RLS）

policy は `app.apply_policy` で型から作る（手で書かない）。

| 表 | 呼び方 | 読める人 | 書ける人 |
|---|---|---|---|
| clients・client_contacts・building_profiles・rooms・building_areas | `apply_policy(表, 'A', {"write_perm":"master.edit"})` | 会社の中の人（スタッフを含む）。運営は許可の間 | `master.edit`（管理者・社員） |
| buildings | `apply_policy('buildings', 'A', {"write_perm":"master.edit", "external_read":"app.can_external_see_building(tenant_id, id)"})` | 上に加えて、外部の人は許された建物だけ | 同上 |

- 外部の人は、取引先・担当者・カルテ・部屋・場所を読めない（型 A だけだから）。建物は名前と住所のほか lat・lng の列も読める（RLS は列を隠せない。位置は秘密ではないので許す）。鍵の場所などはカルテ（別の表）にあるので見えない（R-002-8・9）
- **`deleted_at` は画面から書けない**（R-002-20）。型 A は update を全部の列に与えるので、この5つの表は update の権限を作り直し、`deleted_at`・`created_at`・`created_by` を除いた列だけにする（`tenant_id` は残す。更新を試みても行の会社を変えるトリガーが止め、型の漏れのテストも使えるため）。消すのは RPC（security definer）だけ。insert では `deleted_at` を入れられるが、消えた行を作るだけで害はない。`client_contacts` は直接消す（CRUD の表どおり）ので、列を絞らない
- 画面の一覧は `deleted_at is null` で絞る。RLS は消した行も見せる（001 の決まり。子の残りを防ぐ代わりに、親と子を RPC が一緒に消す）

## 3. 使われているものは消さない：`app.usage_refs`

まだ表がない案件・契約・請求書・写真・作業・ひな形を、後の機能が登録するだけで済む形にする。

```
app.usage_refs (parent, action, child_table, where_sql, reason)
  parent  : client | building | room | area
  action  : block（あれば消さない）| cascade（親と一緒に論理削除）| in_use（あれば消さずに「使わない」）
  where_sql: 子の行の条件（子の列は修飾なし、$2 が親の id）。tenant_id と deleted_at is null は自動で足す
```

- 子の表がまだなければ（`to_regclass` が null）、その行は飛ばす。後の機能は自分の migration で、表を作ったあとに `insert into app.usage_refs` を足す
- 002 で登録するもの：

| parent | action | 子 | 条件 | reason |
|---|---|---|---|---|
| client | cascade | client_contacts | `client_id = $2` | |
| client | block | buildings | `client_id = $2 or owner_client_id = $2` | has_buildings |
| client | block | contracts（010） | `client_id = $2` | has_contracts |
| client | block | invoices（011） | `client_id = $2` | has_invoices |
| building | block | contracts（010） | `building_id = $2 and status = 'active'` | has_active_contracts |
| building | block | works（012） | `building_id = $2 and scheduled_date >= (today, Asia/Tokyo) and status in ('scheduled','in_progress')` | has_future_works |
| building | cascade | building_profiles・rooms・building_areas・external_building_access・report_templates（009）・template_items（009。`template_id in (select id from public.report_templates where building_id = $2)`） | `building_id = $2` ほか | |
| room | in_use | requests（003）・photos（008） | `room_id = $2` | used_by_requests・used_by_photos |
| area | in_use | photos（008）・template_items（009） | `area_id = $2` | used_by_photos・used_by_template_items |

- 003・008・009・010・011・012 の design は、自分の表の列名・状況の値が上の条件と合うかを確かめ、違えば `app.usage_refs` の行を直す。それぞれのテストで「使われていれば消せない」を確かめる

## 4. サーバーの処理（RPC）

すべて `security definer`・`search_path` 固定。会社は行から引き、`master.edit` を `app.require_perm` で確かめる（行が見つからない・権限がないは、同じ 42501 で返し、存在を探らせない）。`app.source` は `rpc`。戻りは jsonb。

| RPC | 中身 | 基準 |
|---|---|---|
| `delete_client(p_id)` | block があれば `{ok:false, reason:"in_use", blockers:[{reason, table, count}]}` を返して何もしない。なければ cascade（担当者）して取引先を論理削除し `{ok:true, deleted:true}` | R-002-14・15・19 |
| `delete_building(p_id)` | block があれば同じ形で止める。なければ cascade（カルテ・部屋・場所・外部の見られる建物・ひな形）して建物を論理削除 | R-002-16・17・19 |
| `delete_room(p_id)`・`delete_building_area(p_id)` | in_use があれば消さず `active = false` にして `{ok:true, deleted:false, deactivated:true, blockers}`。なければ論理削除 `{ok:true, deleted:true}` | R-002-18・19 |

- すでに消した行は、権限があれば `{ok:true, deleted:true, already:true}`（二度呼んでも同じ）

## 5. 画面

`apps/web/src/app/` に、静的書き出しに合うよう、パスは固定で行の ID は `?id=` で渡す（動的なルートは使わない）。スマホの幅で使えるよう、一覧はカード、フォームは1列、ボタンは大きく。

| 画面 | パス | 主な操作 | 基準 |
|---|---|---|---|
| 取引先の一覧 | `/clients/` | 名前の検索、種類での絞り込み、新規 | R-002-21・23 |
| 取引先の登録・編集 | `/clients/edit/?id=` | 入力と保存、担当者の追加・直す・消す、取引先を消す（消せない理由を出す） | R-002-1〜3・14・15・24 |
| 建物の一覧 | `/buildings/` | 名前の検索、依頼元での絞り込み、新規 | R-002-21・23 |
| 建物（カルテ・部屋・場所） | `/buildings/edit/?id=` | 基本の情報、カルテ、部屋、場所（並び順・使う／使わない）、建物を消す | R-002-4・7・10〜12・16〜18・23・24 |

- 画面の中身は、`apps/web/src/lib/masters/` の純粋な関数（入力の検査 `validate.ts`、候補と検索と日本語の文面 `format.ts`）と、Supabase を呼ぶ薄い層（`repo.ts`）に分ける。関数は Vitest で確かめる（R-002-23・24）
- 会社（tenant_id）は、001 の `AuthProvider` が持つ「今の会社」（ヘッダーで選んだ会社）を `useSession` 経由で読む。一覧・取得は、その会社の tenant_id で絞る。Supabase のクライアントは 001 の `lib/supabase.ts` の1つ

## 6. テストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-002-1〜22 | DB（pgTAP。PGlite でも流す） | `supabase/tests/20_clients_buildings.sql` |
| 他の会社への漏れ・構造 | DB（登録された全部の表に流す） | `02_leak_all_tables.sql`・`01_structure.sql`（`tests.seed()` に 002 の種を足した） |
| R-002-23・24 | 単体（Vitest） | `apps/web/src/lib/masters/masters.test.ts` |

- 画面そのもの（見た目・実際の Supabase との通信）は、実際の Supabase が動くまで確かめられない。001 の画面の流れのテスト（Playwright）に合わせて、波 1 のあとに確かめる

## 7. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| 取引先の種類は `management_company`・`owner` | data-model.md の「管理会社・オーナー」をコードの値にした | 日本語の値（表記ゆれが怖い） |
| 締め日は 1〜31、31 を月末とする | 月によって末日が違う。「月末」の特別な値を作らない | 0 を月末にする |
| 支払いの条件は自由な文 | 011 の design で構造化するか決める | 先に構造化（早すぎる） |
| 取引先の `email` の check は「@ をはさんで空でない」だけ | 厳密な形の確かめは、メールを送る側（招待・請求）が行う | 厳密な正規表現 |
| 使われているかの確かめは、登録の表 `app.usage_refs` ＋動的な SQL。まだない表は飛ばす | 案件・契約・請求書・写真・ひな形がまだない。各機能が自分の表を登録するだけで済み、002 を直さなくてよい | 各機能が消す RPC を作り直す（取りこぼす）。外部キーの ON DELETE（論理削除では効かない） |
| 取引先・建物の消す RPC は、止めるとき例外ではなく `{ok:false, reason, blockers}` を返す | 画面が理由を日本語で出せる。「理由を返す」（data-model.md） | 例外のメッセージ |
| 使われている部屋・場所は、RPC が自分で `active = false` にして返す | 「消さずに使わないにする」を1回の操作で終える（data-model.md の決まり）。画面が2回呼ばなくてよい | 画面が「使わない」を別に押す |
| `deleted_at` の列権限を外す（5つの表） | 「RPC で消す。子も一緒に消す」を、直接の update で破れないようにする | RLS の with check（`deleted_at is null` を求めると、消す RPC は security definer なので通るが、policy が複雑になる） |
| 外部の人が建物の位置（lat・lng）も読める | RLS は列を隠せない。位置は住所から分かるものなので、別の表にはしない | 位置の別の表 |
| 建物カルテは、画面が「あれば更新、なければ作る」（RPC にしない） | CRUD は画。1対1の一意制約が二重の作成を止める | カルテを建物と同時に作る RPC |
| 建物を消すとき、外部の人の見られる建物の行も一緒に消す | 消した建物を外部の人に見せ続けない（`can_external_see_building` は建物の消えを見ない） | 外部の行は残す |
| `pg_trgm` を `extensions` の schema に入れる。PGlite の道具にも `pg_trgm` を足す（共通の道具の最小の変更） | Supabase の標準。PGlite に同梱の拡張がある | 部分一致の索引なし（遅くなる）。`lower(name)` の btree（前方一致しか効かない） |
| PGlite は `node --liftoff-only tools/pglite/run.mjs` で流す | 複数のセッションが同時に動くと、既定の実行で「Zone のメモリ不足」で落ちた。`--liftoff-only` で通る | 既定のまま（落ちる） |
