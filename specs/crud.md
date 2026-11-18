# 機能ごとの表と CRUD（cleaning：清掃業のシステム）

[data-model.md](data-model.md) の表を、機能ごとに「だれが・どこから」作る（C）・読む（R）・直す（U）・消す（D）かで整理したもの。機能の design.md は、ここを元に RLS と RPC を決める。

書き方：

- どこから：**画**＝画面から直接、**RPC**＝DB の関数、**EF**＝Edge Function、**T**＝トリガー、**M**＝マイグレーションだけ、**―**＝しない
- だれ：管理＝管理者、社員、スタ＝スタッフ、外部、本人＝その行の持ち主、運営。権限の名前は data-model.md の 3章
- D はすべて論理削除（`deleted_at`）。「取消」は status を変えるだけで、行は残す

## 001 会社と利用者

| 表 | C | R | U | D |
|---|---|---|---|---|
| tenants | EF（運営） | 所属する全員（自分の会社だけ） | RPC：管理（名前・住所・登録番号）／RPC・EF：status | ―（退会は 007） |
| offices | 画：管理 | 会社の中の人 | 画：管理 | 画：管理 |
| profiles | EF（招待の受け入れ） | 同じ会社の人と本人（外部の人は、自分に見せる見積・報告書を作った・確かめた人だけ） | 画：本人（表示名） | ― |
| roles・permissions・role_permissions | M | 全員 | M | M |
| memberships | RPC（招待の受け入れ） | 管理／本人の行 | RPC：管理（役割・止め） | ―（止めるだけ） |
| invitations | EF：管理（メールを送る） | 管理 | RPC（受け入れ） | RPC：管理（取り消し） |
| external_building_access | RPC：管理 | 管理／外部の本人 | ― | RPC：管理 |
| support_access_grants | RPC：管理 | 管理・運営 | RPC：管理（取り消し） | ― |
| audit_logs | T | 管理（運営は許可の間） | ― | ― |
| job_runs | EF | 管理・運営 | EF | EF（1年） |
| client_error_logs | 画：本人 | 本人・work.assign（運営は許可の間） | ― | EF（90日） |
| document_counters | RPC（初めての番号） | ― | RPC（提出・発行の中） | ― |

## 002 取引先・建物・部屋（カルテ）

| 表 | C | R | U | D |
|---|---|---|---|---|
| clients | 画：master.edit／EF（014） | 会社の中の人 | 画：master.edit | RPC：master.edit（建物・契約・請求があれば消せない） |
| client_contacts | 画：master.edit | 会社の中の人 | 画：master.edit | 画：master.edit |
| buildings | 画：master.edit／EF（014） | 会社の中の人／外部（許された建物の名前と住所） | 画：master.edit／EF：位置（013） | RPC：master.edit（先の予定・有効な契約があれば消せない。カルテ・部屋・場所・ひな形も一緒に消す） |
| building_profiles（カルテ） | 画：master.edit | 会社の中の人（外部は読めない） | 画：master.edit | RPC（建物と一緒に） |
| rooms | 画：master.edit／EF（014） | 会社の中の人 | 画：master.edit（「使わない」もここ） | RPC：master.edit（案件・写真が使っていれば、消さずに「使わない」にする） |
| building_areas | 画：master.edit | 会社の中の人 | 画：master.edit（「使わない」もここ） | RPC：master.edit（rooms と同じ） |

## 003 案件

| 表 | C | R | U | D |
|---|---|---|---|---|
| requests | 画：request.edit／RPC：field.record（気づきの写真から。スタも作れる） | 社員以上／スタ（担当のもの） | 画：request.edit（中身）／RPC：status | ―（取消） |
| request_charges | 画：request.edit＋amount.read | amount.read | 画：同じ（請求書に載ったら直せない） | 画：同じ（請求書に載ったら消せない） |

## 004 見積

| 表 | C | R | U | D |
|---|---|---|---|---|
| items | 画：quote.edit | amount.read | 画：quote.edit | 画：quote.edit |
| quotes | 画：quote.edit | amount.read／外部（提出・承認のもの） | 画：quote.edit（下書きだけ）／RPC：提出・承認・不成立（合計と番号もここ） | 画：quote.edit（下書きだけ） |
| quote_lines | 画：quote.edit（下書きだけ） | quotes と同じ | 画：同じ | 画：同じ |
| document_counters | | | RPC（提出） | |

## 010 清掃の契約（定期・単発）

| 表 | C | R | U | D |
|---|---|---|---|---|
| contracts | RPC：contract.edit（承認された見積から）／EF（014） | amount.read | RPC：終了 | ― |
| contract_services | RPC（契約の作成・変更） | amount.read | RPC（変更＝今の行を閉じて新しい行） | ― |
| contract_service_staff | 画：contract.edit | 会社の中の人（スタは自分の行） | 画：contract.edit | 画：contract.edit |
| works | EF（定時の予定の作成）／RPC（契約の変更で作り直し） | 012 を見る | RPC（作り直しで取消） | ― |
| work_charges | EF（回ごとの請求の予定） | amount.read | 画：contract.edit＋amount.read（請求書に載ったら直せない） | ― |

## 008 現場の写真

| 表 | C | R | U | D |
|---|---|---|---|---|
| photos | 画：field.record（電波がなければ端末にためて後で） | 作業の担当・work.assign／外部（提出した報告書の写真） | 画：作業の担当（作業のない写真は撮った本人。種類・場所。報告書が下書きの間）／RPC：案件とのつなぎ | 画：同じ／EF：ファイルの掃除 |
| （置き場所のファイル） | 画：field.record | 期限つきの URL（EF か関数） | ― | EF（行のないファイル） |
| requests | RPC（気づきの写真から） | | | |

## 009 清掃報告書

| 表 | C | R | U | D |
|---|---|---|---|---|
| report_templates・template_items | 画：master.edit | 会社の中の人 | 画：master.edit（「使わない」もここ） | RPC：master.edit（使っている作業があれば消さずに「使わない」） |
| reports | 画：作業の担当（端末で、ひな形から写す） | 作業の担当・work.assign／外部（提出したもの） | 画：作業の担当（下書きの間）／RPC：確認（work.assign）・提出 | ― |
| report_items | 画：作業の担当 | reports と同じ | 画：作業の担当（下書きの間） | ― |

## 012 作業の予定と実績

| 表 | C | R | U | D |
|---|---|---|---|---|
| works | 010 のほか、RPC：work.assign（手で足す。案件か契約の中身を選ぶ） | work.assign／スタ（担当のもの）／外部（許された建物の日と状況） | 画：work.assign（日時）／RPC：開始・終了・行わず・取消（status） | ―（取消） |
| work_assignments | 画：work.assign | work.assign／スタ（自分の行） | ― | 画：work.assign |
| work_records | RPC：作業の担当（開始。端末の uuid で二度目は何もしない） | 本人・work.assign | RPC：本人（終了） | ―／EF：位置の列を 90 日で消す |

## 005 ファイルと専用ページ

| 表 | C | R | U | D |
|---|---|---|---|---|
| files | 画：master.edit | 会社の中の人／外部（shared_external で許された建物） | 画：master.edit（共有のオンとオフ） | 画：master.edit／EF：ファイルの掃除 |

## 006 小口現金・レシート

| 表 | C | R | U | D |
|---|---|---|---|---|
| cash_accounts | 画：cash.manage | 持ち手の本人・cash.manage | 画：cash.manage | 画：cash.manage（残高が0のときだけ） |
| cash_entries | 画：持ち手の本人（出金）・cash.manage（渡す） | 本人・cash.manage | 画：本人（確認まで）／RPC：確認・月の締め（cash.manage） | 画：本人（確認まで） |
| receipts | 画：持ち手の本人 | 本人・cash.manage | EF：読み取りの金額と日／画：本人（直す） | 画：本人（確認まで） |

## 011 請求

| 表 | C | R | U | D |
|---|---|---|---|---|
| invoices | RPC：invoice.edit（下書きの作成） | amount.read | 画：invoice.edit（下書きの期日など）／RPC：発行・送付・取消（合計と番号もここ） | RPC：invoice.edit（下書きだけ） |
| invoice_lines | RPC（下書きの作成） | amount.read | 画：invoice.edit（下書きの間の品名・数量） | RPC（取消で一緒に消す）／画：下書きの間 |
| payments | RPC：invoice.edit（入金の記録。請求書の status も変える） | amount.read | RPC：同じ | RPC：同じ |
| request_charges・work_charges・contract_services | | | ―（請求書に載ったものは直せない） | |

## 013 地図

| 表 | C | R | U | D |
|---|---|---|---|---|
| buildings（lat・lng） | | 会社の中の人 | EF（住所から位置）／画：master.edit（地図で直す） | |
| work_records（位置） | 012 の開始・終了 | 本人・work.assign | | EF（90日） |

## 014 データの取り込み

| 表 | C | R | U | D |
|---|---|---|---|---|
| import_jobs | 画：master.edit（ファイルを上げる） | master.edit | EF（読み込みの結果） | ― |
| clients・buildings・rooms・contracts・contract_services | EF（確かめの画面で OK のあと、取り込んだ人の権限で RPC を呼ぶ） | | | |

## 015 お知らせ

| 表 | C | R | U | D |
|---|---|---|---|---|
| notification_settings | 画：本人 | 本人 | 画：本人 | 画：本人 |
| push_subscriptions | 画：本人（端末ごと） | 本人 | ― | 画：本人／EF（届かない端末） |
| notifications | RPC（出来事のとき）・EF（定時）。送るのは EF | 本人 | 画：本人（read_at）／EF（送った・失敗） | EF（180日） |

## 016 売上と粗利

| 表 | C | R | U | D |
|---|---|---|---|---|
| costs | 画：invoice.edit | amount.read | 画：invoice.edit | 画：invoice.edit |
| （集計の view） | ― | amount.read | ― | ― |

## 007 課金と自分での登録

| 表 | C | R | U | D |
|---|---|---|---|---|
| tenants・memberships | EF（自分での登録） | | | |
| subscriptions | EF（決済の知らせ） | 管理 | EF（決済の知らせ） | ― |

## CRUD から見つけた課題（14件とも data-model.md に入れた）

上の CRUD の表は、直した後の形で書いてある。

| # | 課題 | 直し方の案 |
|---|---|---|
| 1 | 型 E（管理）は「読めるのは管理者だけ」だが、すべての人が自分の所属・会社を読めないと、画面が自分の会社と役割を知れない | 型 E の読む人に「自分の行」を足す（tenants は所属する会社、memberships は本人の行） |
| 2 | 型 C（現場の記録）の「本人」は作った人だが、1つの作業に担当が2人いると、もう1人が報告書や写真を直せない・見られない | 報告書・項目・写真の持ち主を「作業の担当」にする。型 C を「本人」と「作業の担当」の2つの形に分ける（実績・小口・お知らせは本人のまま） |
| 3 | 電波のない間は RPC を呼べない。開始・終了を RPC にすると、端末にためて後で送るとき、二度呼ばれるおそれがある | 端末にためるのは「呼ぶ RPC と引数」。RPC は端末の uuid を受け取り、同じ uuid の二度目は何もしない（実績の行の id に使う） |
| 4 | 取り込み（014）と定時の処理を `service_role` で動かすと、RLS を通らない。会社の ID の付け間違いが漏れになる | 会社のデータを書く EF は、操作した人のログインの鍵で RPC を呼ぶ（RLS を通す）。`service_role` を使うのは、会社をまたぐ定時の処理（予定の作成・お知らせ・掃除）だけにし、その処理は会社ごとに分けて回し、DB のテストで確かめる |
| 5 | 取り込んだ契約には見積がない。契約は「承認された見積から」としていた | `contracts.quote_id` は空でもよいことにし、`source`（見積・取り込み）を持つ |
| 6 | 案件の金額・作業の金額・契約の中身は、請求書に載ったあとも直せた（請求書は写しなので変わらないが、画面の数字と合わなくなる） | 請求書に載ったものは、RLS で直せなくする（「消していない明細から指されていない行だけ直せる」） |
| 7 | 部屋・場所・ひな形を消すと、使っている案件・写真・作業が宙に浮く | 使われているものは消さずに「使わない」（`active = false`）にする。消す操作は RPC で、使われていれば止める |
| 8 | 建物や取引先を消しても、部屋や担当者が見えたまま残る（RLS は親が消えたかを見ない） | 消す RPC が、子（部屋・場所・担当者）も一緒に論理削除する |
| 9 | 小口の出入りに、確かめと締めの状況がない。渡したあとに金額を直せる | `cash_entries` に status（下書き・確認済み・締め済み）を持ち、確認のあとは RLS で直せなくする |
| 10 | 入金を記録したら請求書の status も変わる。画面から入金だけを書くと、status が古いまま | 入金の記録・直し・消しは RPC にし、請求書の status も同じ中で変える |
| 11 | ファイル（005）と費用（016）を書く権限が決まっていなかった | ファイルは `master.edit`、費用は `invoice.edit` にする（新しい権限は作らない） |
| 12 | 外部の承認：見積の「承認」を、外部の人が専用ページで押せる形にするか決まっていない（型 D は外部は書けない） | 最初は社員が承認を記録する。外部が押す形は、005 の design で RPC 1つとして決める |
| 13 | 変更の履歴を、写真や項目のチェックのように数の多い表にも付けると、履歴がとても増える | 変更の履歴は型 A・B・E の表だけに付ける。型 C の表は、作った時刻・届いた時刻・version で追う |
| 14 | 外部の人にも、同じ会社の全員の名前（profiles）が見える | 外部の人が見られる名前は、自分あての報告書と見積を作った人だけにする |
