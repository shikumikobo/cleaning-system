# 手元のデモ環境

Supabase の CLI は Smart App Control で動かないため、Docker で各部品（DB・ログイン・データの API・ファイル・メール受け）を直接動かす。デモだけに使う。

| 部品 | 場所 |
|---|---|
| 入り口（画面が呼ぶ。ログイン・データ・ファイルへ振り分け） | http://127.0.0.1:54321 |
| 画面（開発サーバー） | http://127.0.0.1:3000 |
| デモの入り口（役割を選んで入る） | http://127.0.0.1:3001 |
| 届いたメール（ログインのリンク） | http://127.0.0.1:54324 |
| DB（直接） | 127.0.0.1:54322（ユーザー postgres、パスワードは `.env` の PGPASSWORD） |

## 起動

```bash
node tools/demo/keys.mjs                                   # 初回だけ。.env に鍵を作る
docker compose -f tools/demo/docker-compose.yml --env-file tools/demo/.env up -d
```

初回だけ、DB に次を入れる（README の下の「初回の準備」）。

## 初回の準備

1. 役割のパスワード：`authenticator`・`supabase_auth_admin`・`supabase_storage_admin` に、`.env` の PGPASSWORD を設定する（`alter role … with login password`、`supabase_admin` で）
2. 拡張 `pgcrypto`・`pg_trgm` を `extensions` に作る
3. `supabase/migrations/` を名前の順に流す（`…0500_storage.sql` だけ `supabase_admin` で、ほかは `postgres` で。`set search_path to public, extensions`）
4. `node tools/demo/seed.mjs` でデモの利用者とデータを入れる（会社「サンプル清掃株式会社（デモ）」）

デモの利用者はパスワードを持たない（このシステムはパスワードを禁止している）。入り口（3001）か、`node tools/demo/login-link.mjs admin` で、ログインのリンクを作って入る。

## 入っていないもの

- Edge Functions（invite-user・create-tenant・sign-file-urls・通知の定時処理など）。画面のうち、これを呼ぶ操作（招待・ファイルの共有 URL・通知の送信）は動かない
- 現場の写真・ファイル・レシートのデータ（ファイルの置き場所は動くが、デモの画像は入れていない）
