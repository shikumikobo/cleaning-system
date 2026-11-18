# 機能014：データの取り込み（設計）

要件は [requirements.md](requirements.md)。表と policy の型は [../data-model.md](../data-model.md)（013・014 の章）が正で、ここは 014 での実際の形を書く。policy の付け方は [../001-tenants-users/design.md](../001-tenants-users/design.md) の `app.apply_policy`、取引先・建物・部屋の表は [../002-clients-buildings/design.md](../002-clients-buildings/design.md)、契約を作る RPC は [../010-contracts/design.md](../010-contracts/design.md) の3章（`create_contract_import`）。

## 1. 全体の流れ

```
ファイルを選ぶ（ブラウザの中）
  → 読み込み（CSV／.xlsx → 行と列の表）          lib/import/csv.ts・xlsx.ts・table.ts   … 純粋な関数
  → 今の会社の登録済みデータを読む（読み取りだけ）  lib/import/repo.ts（loadExisting）
  → 確かめ（検査・重なり・契約のまとめ）           lib/import/plan.ts                     … 純粋な関数
  → 確かめの画面（件数・エラーの行・重なり）。ここまでは何も書かない
  → 「この内容で取り込む」                        RPC import_rows（取り込んだ人のログインの鍵）
  → 結果の画面・取り込みの履歴（import_jobs）
```

- **ファイルはブラウザの中で読む**。サーバーに送るのは、確かめを通った行（と、外した行の記録）だけ。ファイルそのもの（お客さんの名前・住所を含む）は保存しない（`import_jobs.file_path` は空のまま。data-model.md の列は置いてある）
- **データの書き込みは、取り込んだ人のログインの鍵で RPC を呼ぶ**（crud.md の課題4）。`service_role` も Edge Function も使わない。RPC は `security definer` だが、中で `app.require_perm` を必ず通し、会社は呼び出しの `p_tenant`（権限で確かめる）に固定する。名前の解決は、その会社の行だけで探す
- crud.md の 014 の行は「EF（確かめの画面で OK のあと、取り込んだ人の権限で RPC を呼ぶ）」と書いてある。読み込みは、画面（ブラウザ）で行うので、Edge Function は作らない（「決めたこと」に理由）

## 2. 表：`import_jobs`（型 E）

共通の列（`id`・`tenant_id`・作成と更新の人と時刻・`deleted_at`）と `unique (tenant_id, id)` は、data-model.md の1章のとおり。

| 列 | 意味 |
|---|---|
| `kind` | `clients`・`buildings`・`rooms`・`contracts` |
| `file_name` | 選んだファイルの名前（空でない） |
| `file_path` | ファイルの保存先。今は空（保存しない） |
| `status` | `done`（エラーの行なし）・`partial`（エラーの行あり）。重なりで飛ばしただけなら `done` |
| `total_rows` | ファイルの行の数（空の行を除く） |
| `created_count` | 取り込んだ数（契約は、契約の数） |
| `skipped_count` | 重なりで飛ばした数 |
| `error_rows` | エラーの行の数 |
| `details` | 取り込まなかった行の一覧 `[{row, status(error・duplicate), messages[], by(client・server)}]` |

- policy：`app.apply_policy('public.import_jobs', 'E', '{"read_perm": "master.edit"}')`。読めるのは `master.edit` を持つ人（管理者・社員）。書く policy は作らない（RPC だけ）。変更の履歴は型 E の既定で付く
- 記録は、`import_rows` が1回の取り込みごとに1行、同じ transaction の中で書く（取り込みと記録は一緒に確定する）

## 3. RPC：`import_rows`

`public.import_rows(p_tenant uuid, p_kind text, p_file_name text, p_total_rows int, p_excluded jsonb, p_rows jsonb) returns jsonb`。`security definer`・`search_path` 固定。`authenticated` だけが実行できる。

1. `app.require_perm(p_tenant, 'master.edit')`。契約なら `contract.edit` も。権限のない人・別の会社・どこにも属さない人・運営は 42501（`anon` は実行の権限がなく 42501）
2. 種類・ファイル名・行の形を確かめ、正しくなければ `{ok:false, reason}`（`invalid_kind`・`invalid_file_name`・`invalid_total`・`invalid_rows`）
3. `app.source` を `import` にする（変更の履歴の source。R-014-16）
4. 画面が外した行（`p_excluded`）を、記録の `details` に入れる（`by: client`）
5. 取り込む行を1つずつ、**サーバーで検査と重なりの確かめをやり直して**書く。1行ずつ副 transaction（`begin … exception`）で囲み、1行の失敗が全体を止めない。42501 だけは外に出す
   - **名前の解決**：`app.import_key(名前)`（`lower`・NFKC・空白を1つに）で、呼ぶ人の会社の消していない行から探す。0 件は `*_not_found`、2 件以上は `*_ambiguous`
   - **重なり**：取引先は名前、建物は（取引先・名前）、部屋は（建物・部屋番号）、契約は（建物・種類・開始日・今の清掃の名前の組）。同じ取り込みの中の2回目も、1つ目が先に書かれているので重なりになる。DB の一意制約に当たった行（競合）も重なりとして飛ばす
   - **契約**：`public.create_contract_import(client, building, kind, start, end, services)`（010）を呼ぶ。見積なし・元は取り込み・中身も同時。010 が返した `reason`（`invalid_amount` など）をそのままエラーにする。契約の作成の履歴の source は、010 の RPC が `rpc` にするので `import` にならない
6. `import_jobs` に1行を書き、`{ok, job_id, status, created, skipped, errors, details}` を返す

サーバーの理由（コード）は、画面（`lib/import/format.ts`）が日本語にする。

## 4. 読み込みと確かめ（`apps/web/src/lib/import/`）

| ファイル | 中身 | 基準 |
|---|---|---|
| `columns.ts` | 種類ごとの列（見出し・必須・別名）・ひな形の例・入れ方の説明 | R-014-1・4 |
| `csv.ts` | `decodeCsvBytes`（UTF-8／BOM／Shift_JIS の判別）、`parseCsv`（引用符・改行・CRLF）、`toCsv` | R-014-2 |
| `xlsx.ts` | `readXlsx`（`read-excel-file`。種類の名前のシート、なければ最初）、`buildXlsx`（ひな形用の小さな .xlsx。fflate） | R-014-1・3 |
| `table.ts` | 見出しの名前で項目に割り当て、行番号つきの行にする。必須の見出しの不足・知らない見出し・空行 | R-014-4 |
| `values.ts` | 日付・時刻・金額・階・締め日・頻度（日本語の言い方 → RRULE）・言葉 → DB の値 | R-014-5〜8 |
| `normalize.ts` | `importKey`（名前の比べ方。DB の `app.import_key` と同じ）、セルの値の文字化 | R-014-9 |
| `plan.ts` | `planImport`：種類ごとの検査・名前の解決・重なり・契約のまとめ。サーバーに渡す行・外した行・件数を返す | R-014-5〜9 |
| `template.ts` | ひな形（CSV・Excel） | R-014-1 |
| `repo.ts` | 登録済みデータの読み取り（1000 行ずつ全部）・`import_rows` の呼び出し・履歴の読み取り | R-014-11・12・19 |
| `format.ts` | 理由の日本語・履歴の日時の表示 | R-014-17・19 |

- **ひな形の列**：取引先（名前・種類・住所・電話・メール・締め日・支払い条件）、建物（取引先名・建物名・住所・所有者名）、部屋（取引先名・建物名・部屋番号・階）、契約（取引先名・建物名・契約の種類・開始日・終了日・清掃の名前・清掃の種類・金額・請求・頻度・開始時刻・終了時刻）
- **契約のまとめ方**：（建物・種類・開始日・終了日）が同じ行を1つの契約の中身としてまとめる。まとめた中の1行でも間違いがあれば、その契約の行は全部エラー（ほかの行には「同じ契約の◯行目にエラーがあるため」と出す）
- 登録済みデータは、確かめのために画面が読む（今の会社の `tenant_id` で絞る）。契約の重なりの確かめには契約と中身を読むので、`amount.read` のない人では空になる（そのときの重なりは、サーバーの確かめが拾う）

## 5. 画面

| 画面 | パス | 内容 | 基準 |
|---|---|---|---|
| データの取り込み | `/import/` | 取り込むものの選択、ひな形のダウンロード（Excel・CSV）、ファイルを選ぶ、確かめ（件数・エラーの行・重なり・取り込む内容の先頭）、「この内容で取り込む」、結果、履歴 | R-014-10・11・17〜19 |

- 入口のメニューに「データの取り込み」の1項目を足した。契約は `contract.edit` を持つ人だけが選べる。`master.edit` がなければ、権限がない旨だけを出す（出し分けのためだけ。判定は DB が行う）
- 接続・今の会社・権限は `components/useSession.ts`。新しいクライアントや「今の会社」の仕組みは作っていない

## 6. テストの方法

| 基準 | 種類 | 置き場所 |
|---|---|---|
| R-014-12〜16 | DB（pgTAP。Docker の本物の Postgres） | `supabase/tests/23_import.sql` |
| 他の会社への漏れ・構造・型の付け忘れ | DB（登録された全部の表に流す） | `02_leak_all_tables.sql`・`01_structure.sql`（`tests.seed()` に 014 の種を足した。`00002_seed_014.sql`） |
| R-014-1〜9 | 単体（Vitest。.xlsx は、ひな形を書き出して本物のライブラリで読み戻す） | `apps/web/src/lib/import/import.test.ts` |
| R-014-1・10・11・17〜19 | 画面（Playwright + Edge。取り込みの表と RPC は、このテストが自分で偽の接続先を受ける） | `apps/web/e2e/import.e2e.ts` |

- 画面と実際の Supabase との通信は、実際の Supabase が動くまで確かめられない

## 7. 決めたこと

| 決めたこと | 理由 | ほかの案 |
|---|---|---|
| ファイルの読み込みと確かめは、ブラウザの中で行う（Edge Function は作らない） | 確かめは、書く前に何度でも直して選び直す。ファイルをサーバーに置かず、個人情報を残さない。書くのは RPC なので、課題4（`service_role` を使わない）も守れる。純粋な関数にしたので Vitest で確かめられる | Edge Function で読む（ファイルを送る・保存する必要が出る。Deno で確かめられない） |
| 書き込みは1つの RPC `import_rows`（種類を引数に取る） | 取り込みの記録・件数・外した行を、書き込みと同じ transaction で確定できる。権限・会社の確かめが1か所 | 種類ごとの RPC（記録を書く処理が4か所に散る）。画面が表に直接 insert（重なりの競合・記録が合わない） |
| 画面で確かめた行も、サーバーで検査と重なりをやり直す | 画面を通らない呼びでも、壊れた行・重なりを書かない（権限・会社と同じ考え方） | 画面を信じる |
| エラーの行があっても、取り込める行だけを取り込める（エラーと重なりは飛ばして記録に残す） | 数百行のファイルで1行の間違いのために全部やり直しになるのは使いにくい。何が飛ばされたかは確かめの画面と記録に出る | 1行でもエラーがあれば全部止める |
| 重なりは、エラーとは別に数えて飛ばす（上書き・更新はしない） | 取り込みは「登録」だけ。既存を黙って変えない（取り消せない）。同じものを2回上げても増えない | 上書きする／重なりをエラーにする |
| 取引先 → 建物 → 部屋 → 契約を、種類ごとに別のファイル（1回ずつ）で取り込む。建物は登録済みの取引先、契約は登録済みの建物の名前で探す | CSV は1ファイル1表。順に取り込めば、名前で確実に結びつく。同じファイルの中の新しい取引先は参照できないことをひな形の説明に書く | 1つのファイルに全部（CSV で表せない）。ID を書かせる（人が分からない） |
| 名前の結びつけは（取引先名・建物名）。同じ名前が2つあれば「決まらない」でエラー | 違う建物に取り込む事故を防ぐ。決まらないものは人が直す | 最初の1件を使う |
| 契約の1行は清掃の中身1つ。（建物・種類・開始日・終了日）が同じ行を1つの契約にまとめる | Excel で自然な形（1行1品目）で、複数の中身を持つ契約を書ける | 契約と中身を別のシートにする |
| 契約の重なりは、（建物・種類・開始日・清掃の名前の組）が同じ。終了日・金額・頻度は見ない | 同じ契約を二度上げたとき（金額を直して上げ直した場合も）を拾う。違う契約と同じ組になるのはまれ | 全部の項目が同じとき |
| 頻度は RRULE のほか、日本語の言い方（毎週月曜・隔週・毎月第2水曜・毎月◯日・毎月末・◯か月に1回・単発）も読む | 現場の人は RRULE を書けない。読める形だけを許し、読めなければエラーにする（黙って違う予定を作らない） | RRULE だけ |
| 締め日は「月末」も 31 として受ける。階は「2階」「3F」も受ける | Excel でよく書かれる言い方。DB の値（整数）に直す | 整数だけ |
| 日付・時刻は、Excel の日付・時刻のセル、`2026/12/1`、`2026年12月1日`、`9:00`、`9時30分` を読む | Excel が日付に変えてしまうことが多い。.xlsx は、画面に見えるとおりの文字にして読む | 1つの形だけ |
| CSV は UTF-8 を試し、読めなければ Shift_JIS | Excel の「CSV」の保存は、Shift_JIS になることが多い | UTF-8 だけ |
| 数は文字のまま読む（`read-excel-file` の `parseNumber`）。電話番号・部屋番号の頭の 0 や桁を壊さない | 浮動小数点の丸めや、数値化による 0 落ちを避ける | 数にする |
| `import_jobs.file_path` は空のままにする | ファイルは保存しない（個人情報を残さない）。data-model.md の列は置いた | 列を作らない／ファイルを保存する |
| 新しい依存：`read-excel-file`（.xlsx の読み込み）、`fflate`（ひな形の .xlsx の zip） | .xlsx は zip の XML で、自作は危ない。`xlsx`（SheetJS）は npm の最終版に既知の脆弱性があるため選ばない。`fflate` は `read-excel-file` が使っていて、同じ版 | `xlsx`・`exceljs`（大きい）。ひな形は CSV だけ |
| 契約の履歴の source は `rpc`（010 の RPC が決める）。取引先・建物・部屋は `import` | 010 の RPC を変えない（並列の機能の確定したもの）。契約が取り込みで作られたことは `contracts.source = 'import'` で分かる | 010 の RPC を直して `import` にする |
