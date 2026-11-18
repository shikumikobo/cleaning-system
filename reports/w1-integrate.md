# 波 1 の取り込みのあとの「つなぎ」（w1-integrate）の報告

ブランチ `w1-integrate`（main の e9e9a37 から）。

## 画面のテスト（e2e）が 14 件とも TimeoutError だった原因

- 再現：worktree で `corepack pnpm@9.15.0 -r test:e2e` を、接続先の環境変数なしで流すと、1 件目（ログイン）から 15 秒の待ちを超えて落ちた
- 仮説：`NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY` が空のまま書き出すと、Supabase のクライアントが作られず、画面は「接続の設定なし」のまま。テストが待つ画面の要素が出ない。`test:e2e` は `next build` を含むが環境変数を入れておらず、CI の workflow だけが入れていた
- 確かめ：同じ環境変数を入れて書き出し直して流すと 14 件通った（取り込みの中身の食い違いではない）
- 直し：`apps/web/scripts/e2e.mjs` を足し、`test:e2e` はそれを呼ぶ。環境変数が空なら偽物の接続先（127.0.0.1:54321・`e2e-anon`）を入れて、書き出しとテストを流す。環境変数を外した状態で、もう一度 14 件通ることを確かめた

## 直したこと

1. Supabase のクライアントを `lib/supabase.ts` の 1 つに（`getClient()` は未設定なら null、`getSupabase()` は例外）。`lib/masters/client.ts`・`lib/cash/supabase.ts`・`lib/notifications/session.ts` を削除
2. 今の会社を 001 の `AuthProvider` の `current` だけに。`cleaning.currentTenant`・`cleaning.activeTenant` は廃止（キーは `cleaning.currentMembership` だけ）。`AuthProvider` に今の役割の権限（`perms`）を足し、`components/useSession.ts`（ログインしていなければログインの画面へ）を 002・006・015 の画面が使う
3. 取引先・建物の一覧と取得は、今の会社の `tenant_id` で絞るように直した（以前は RLS だけに頼っていて、2 つの会社に入っている人には両方が混ざって見えた）。e2e で確かめ
4. `NotificationBell` を `AppShell` のヘッダーに入れた（リンクは next/link）。e2e で件数と移動を確かめ
5. 006 `cash_entries.building_id` に、`(tenant_id, building_id)` で 002 の `buildings` を指す外部キー（`20261117030000_cash_entries_building_fk.sql`。部分索引つき）。`work_id` は 012 まで保留。DB のテストを 4 件足した（自分の会社の建物・別の会社の建物・存在しない建物・空）
6. `globals.css` の `.list`・`.list li` の重複を 1 つにまとめ、小口の一覧は `.list.compact` に分けた
7. `specs/data-model.md` に、`app.policy_registry`・`app.apply_policy`、型 M・P、`app.usage_refs`、`notification_kinds`、`app.enqueue_notification` を書き足した（決まりは変えていない）。あわせて 006 の列（holder_id・確認と締めの列など）と 015 の列（body・dedupe_key）も、実装の形に直した。002・006・015 の design の、仮の入口の記述を今の形にした

## `app.usage_refs` の仮の状況の値の確かめ（直していない）

- 列名（client_id・building_id・room_id・area_id・template_id・scheduled_date）は、data-model.md の表の定義と全部合う
- 契約：data-model.md の状況は「有効・終了」。`active` は「有効」の仮の英語の値。意味は食い違わない
- 作業：「予定・実施中・完了・行わず・取消」。`scheduled`・`in_progress` は「予定」「実施中」に当たり、完了・行わず・取消は数えない。意味は食い違わない
- data-model.md は状況の英語の値を決めていない。010・012 の design で値を決めるとき、この 3 つに合わせるか、`usage_refs` の行を直す（data-model.md の仕組みの項にも書いた）
- 気づき（推測）：契約が `active` のまま終了日を過ぎた場合も建物は消せない側に倒れる（安全側）。010 で、終了日の過ぎた契約の状況をどう扱うかを決める

## 残ったこと

- Supabase の本物の環境での確認（画面・Edge Function・本物の pgTAP）は未
- 建物の選択（小口の出入りに建物を付ける画面）と、`work_id` の外部キーと作業の選択は残り
- 006 の古い migration（20261116160000）の列のコメントを 1 行だけ直した（中身は変えていない）
- 001 の招待の流れの `signInWithOtp` と `forbid_password` の両立（w1-001ui の報告の未確認）は、そのまま
- `.github/workflows/ci.yml` は、環境変数を入れる段をそのまま残した（スクリプトも同じ値を入れる）

## 確かめた件数（worktree）

- DB（`node tools/pglite/run.mjs`）：ok 789、not ok 0、ファイルのエラー 0
- Vitest：15 ファイル 168 件
- lint・typecheck・build：エラーなし
- e2e（`test:e2e`）：16 件（既存 14 ＋ 鈴・会社の切り替えの 2 件）
- `spec.py check --strict`：基準 122 件、テストあり 122 件、問題なし
