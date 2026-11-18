# 清掃業のシステム（cleaning）

清掃会社向けの業務の管理システム。仕様から作る（job の `job-spec` スキル）。

- 原則：[specs/constitution.md](specs/constitution.md)
- 全体の仕様と機能の一覧：[specs/product.md](specs/product.md)
- 機能ごとの要件・設計・タスク：`specs/NNN-*/`

```bash
# job のフォルダで
python .claude/skills/job-spec/spec.py list cleaning
python .claude/skills/job-spec/spec.py check cleaning --strict
```

作者は shikumikobo（しくみ工房）。

**動くデモ**：https://cleaning-demo-5c9.pages.dev/demo/ （架空の会社のデータ。役割を選んで入れます。Cloudflare Pages + Supabase。置き方は tools/demo/cloudflare/）
デモ環境の作り方は tools/demo/README.md、操作マニュアルは docs/user-manual/。

## 開発

```bash
corepack pnpm@9.15.0 install                 # 初めに
corepack pnpm@9.15.0 --filter web test       # 単体（Vitest）
corepack pnpm@9.15.0 --filter web lint       # lint
corepack pnpm@9.15.0 --filter web typecheck  # 型
corepack pnpm@9.15.0 --filter web build      # 静的な書き出し（apps/web/out）
corepack pnpm@9.15.0 exec supabase start     # 手元の Supabase（Docker）
corepack pnpm@9.15.0 exec supabase test db   # DB のテスト（pgTAP）
node tools/pglite/run.mjs                    # Docker が使えないときの仮の DB の検証（PGlite）
```

- DB の形は `supabase/migrations/` のファイルでだけ変える。表を足したら `app.apply_policy(...)` で型を付け、`tests.seed()` に会社ごとの行を足す（`supabase/tests/00000_helpers.sql`）
- 画面は `apps/web/`。電波のない間の送り直しの部品は `apps/web/src/lib/offline/`
