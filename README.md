# Antifreeze

Hugo 向け Markdown を WebDAV 上で編集するブラウザエディタ（プロトタイプ）。

## 必要環境

- Node.js 20 以上（18 でも動く想定）

## セットアップ

```bash
git clone <このリポジトリの URL>
cd antifreeze
npm install
```

## 開発（手許の PC など）

クロスオリジンで WebDAV に直接アクセスすると CORS で失敗することがあります。プロジェクト直下に `.env.local` を作成し、例として次を設定します（値は環境に合わせて変更）。

```
VITE_DEV_WEBDAV_TARGET=http://WebDAVサーバのホスト名
```

`.env.example` も参照してください。`npm run dev` を再起動したうえで、アプリの WebDAV ベースURLに `http://localhost:5173/__webdav/（Finder で使っているパス）` の形式を使うと、Vite がプロキシして CORS を避けられます。

## WebDAV と同じマシンで開発する場合

同一ホスト上で動かすとオリジンを揃えやすく、CORS を気にしなくて済むことが多いです。

- **Vite の開発サーバをそのマシン上で動かす:** `npm run dev -- --host 0.0.0.0` で LAN からもアクセス可能にできます（ファイアウォールは適宜開放）。
- **本番に近い動き:** `npm run build` のあと `dist/` を nginx 等で静的配信し、WebDAV と同じ `https://例:ホスト名` 配下に置けば同一オリジンにしやすいです。

設計メモやサーバ側 CORS の例は [PLAN.md](./PLAN.md) を参照してください。

## ライセンス

リポジトリの方針に合わせて `LICENSE` を追加してください。
