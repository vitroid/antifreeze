## 処方箋：WebDAV直結型「Hugo専用」ブラウザエディタの構築（Antifreeze）

### 1. プロジェクトの目的と背景
* **ターゲット:** 非プログラマーの執筆者。
* **課題:** Markdown内のYAML FrontMatterの構文エラー（インデント、引用符等）によるビルド失敗の防止。
* **環境:** Webサーバ側でWebDAVとして公開しているディレクトリ（本プロジェクトでは **`chem-web`** という名前で呼ぶ）内のファイルを、ブラウザから直接読み書きする。
* **ゴール:** 「入力フォーム（メタデータ）」と「テキストエディタ（本文）」を分離し、保存時に安全に結合するWebベースのUIを構築する。
* **スコープの考え方:** 利用者が**混乱なく編集できること**を最優先する。このエディタだけでGitやサーバ上のあらゆる操作を完結させる必要はない。想定外のファイルや壊れたYAMLは**エラーとして明示**し、別途（Git・エディタ等）で対応してもよい。

### 2. 技術スタック（推奨）
* **Runtime:** ブラウザ完結（HTML/JS）。
* **Editor:** **CodeMirror 6**（モダンで拡張性が高く、行単位の制御が容易）。
* **WebDAV通信:** **webdav-client** (npm) を使用し、`fetch` ベースで `GET/PUT/PROPFIND` を実行。
* **Parser:** **js-yaml** または **gray-matter**。FrontMatterをJSオブジェクトに変換するために必須。
* **UI Framework:** **Alpine.js**（軽量・学習コスト低）または **React**（高機能なフォーム作成用）。

#### 未決（実装フェーズで選択）
* **配布形態:** npm＋バンドラ（例: Vite）か、CDN中心の単一HTMLか——利用者の理解の及ばない詳細のため、**実装時に決める**。いずれにせよWebDAVクライアントとYAMLパースは満たすこと。
* **最初のスコープ:** 「1ファイルを開いて読み・保存する」までにするか、**PROPFINDでディレクトリ一覧**まで含めるか——同様に**実装時に決める**。

### 3. 実装すべきコア機能

#### A. FrontMatterの「UI分離」ロジック（Hugo前提）
1.  WebDAVから `.md` ファイルを文字列として取得。
2.  正規表現 `^---([\s\S]*?)---` で冒頭のYAMLを抽出。
3.  YAMLをパースし、タイトル、日付、タグなどを **HTMLの`<input>`や`<select>`** にバインド。
4.  ユーザーは「生のYAML」を直接触れず、フォーム経由でのみメタデータを更新する。
5.  **Hugo向けの想定フィールドでよい。** YAMLの**キー名を編集者が増やしたり変えたりするUIは不要**（固定フォームで十分）。

#### 入力・検証の扱い（エラー方針）
* Front Matter が無い、区切りが不正、YAMLがパース不能などは**エラーとして表示**し、通常の編集・保存フローに進めない（利用者を曖昧な状態に置かない）。
* 上記は「このエディタですべてを救済する」より**混乱防止**を優先する。

#### B. 編集箇所の確認（プレビュー・同期ハイライト）
* **優先度は低く後回しでよい。** 全文をまとめてレンダリングしたプレビューは必須ではない。
* **目的:** 入力中に、特に**数式や修飾を含む行**など、該当**行**の見え方を確認できること。
* **最低ラインの例:** 全文を（簡易に）プレビュー表示し、その上で**カーソル位置（行）に対応する部分だけ**をハイライトする——程度でもよい。
* 実装する場合の参考案（当初の構想）:
  1.  **Editor側:** CodeMirrorの `cursorActivity` 等で現在の行番号を取得。
  2.  **Preview側:** MarkdownをHTMLに変換する際、各ブロックにソースの行番号（`data-line="10"`）を付与する。
  3.  **同期:** カーソル行に対応するPreview側のDOMにスタイルを付与し、`scrollIntoView` で追従させる。

#### C. 安全な保存プロセス
1.  「保存」実行時に、フォームの値をYAML文字列に再シリアライズ。
2.  CodeMirror内の本文と結合（`---` で挟む）。
3.  WebDAVへ `PUT` リクエストを送信。この際、一時ファイルを作ってからリネームする等のアトミックな処理を検討。

### 4. サーバー側の準備（重要）

#### 4.1 なぜ CORS が必要か
* エディタを **手許の PC** で動かす場合、ページのオリジン（例: Vite 開発サーバの `http://localhost:5173`）と WebDAV の URL（別ホストまたは別ポート）が一致せず、ブラウザは **クロスオリジン** として扱う。
* その状態で `GET` / `PUT` / `PROPFIND` を行うには、**WebDAV を応答している側**が適切な **CORS ヘッダ** を返す必要がある（エディタ用の静的ファイルを配信しているサーバではなく、**WebDAV リクエストを処理しているサーバ／`Location`** に付ける）。
* 完成後に **エディタと WebDAV を同一オリジン**（同じ `https://ホスト` 配下）にまとめれば CORS は不要になるが、**開発中はローカルからサーバの WebDAV に触る**前提なので、サーバ側に CORS を書いておく。

#### 4.2 許可すべき内容（目安）
* **メソッド:** 少なくとも `GET`, `PUT`, `PROPFIND`。プリフライト用に **`OPTIONS`** も応答できるようにする。
* **ヘッダ（`Access-Control-Allow-Headers`）:** 少なくとも `Content-Type`。WebDAV では **`Depth`**（PROPFIND 等）が使われることがある。将来 Basic 認証等を足すなら **`Authorization`** も許可リストに含める。
* **`Access-Control-Allow-Origin`:** 開発時は `http://localhost:5173`（Vite のデフォルト）など **エディタのオリジンを明示**するのが安全。本番で別 URL にしたら **そのオリジンを追加**するか、運用に合わせて切り替える（`*` は検証には楽だが、認証付きやクッキーと併用する場合は使えない）。

#### 4.3 設定例（コピー用・要パス・オリジン調整）

**Nginx（`location` は WebDAV の実パスに合わせる）**

```nginx
# 例: オリジンを開発用に固定（本番 URL に差し替え or 複数行で追加）
set $cors_origin "http://localhost:5173";

if ($request_method = OPTIONS) {
    add_header Access-Control-Allow-Origin $cors_origin;
    add_header Access-Control-Allow-Methods "GET, PUT, PROPFIND, OPTIONS";
    add_header Access-Control-Allow-Headers "Authorization, Content-Type, Depth";
    add_header Access-Control-Max-Age 86400;
    return 204;
}

add_header Access-Control-Allow-Origin $cors_origin always;
add_header Access-Control-Allow-Methods "GET, PUT, PROPFIND, OPTIONS" always;
add_header Access-Control-Allow-Headers "Authorization, Content-Type, Depth" always;
```

**Apache（`mod_headers` が有効であること）**

```apache
# 例: 開発用オリジン（VirtualHost または WebDAV の Directory 内で調整）
SetEnvIf Origin "^http://localhost:5173$" CORS=1
Header always set Access-Control-Allow-Origin "http://localhost:5173" env=CORS
Header always set Access-Control-Allow-Methods "GET, PUT, PROPFIND, OPTIONS" env=CORS
Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Depth" env=CORS
```

* 実環境では **TLS 終端・リバースプロキシ・既存の `Location` / `Alias`** と競合しないよう、上記は **WebDAV が実際に応答するコンテキスト** にだけ載せること。
* 設定変更後は **ブラウザのキャッシュや 204 応答**もあるので、動かないときは開発者ツールの Network で **プリフライト（OPTIONS）と本リクエスト**のステータス・ヘッダを確認する。

#### 4.4 認証（現時点）
* **エディタ側では実装しない。** アクセスは**IPアドレスで到達可能範囲を限定**している。万一改ざんされても**GitHubに原本がある**前提で、当面はBasic認証等は不要とする。
* 将来サーバ側に認証を足す場合、**4.2 の `Authorization` 許可**と合わせ、`Access-Control-Allow-Credentials` 等が必要になる（`*` オリジンとは併用できない）ので、そのときに CORS を見直す。

---

### Agentへの指示用プロンプト案
> 「上記の処方箋に基づき、まずは **『WebDAV上の1つのファイルを読み込み、YAML部分をフォームに、本文をテキストエリアに分離して表示し、再度結合して保存する』** 最小構成のHTML/JavaScriptコードを書いてください。Hugo向けの固定フィールドでよい。WebDAV通信は `webdav-client` またはCDN利用のWebDAVクライアントのいずれかでよい。UIはシンプルに、カスタマイズしやすいVanilla JSまたはAlpine.jsでお願いします。認証は不要。」
