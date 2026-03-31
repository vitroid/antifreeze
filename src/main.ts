import { createClient, type WebDAVClient } from "webdav";
import yaml from "js-yaml";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";

const FM_BLOCK =
  /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

type HugoMeta = Record<string, unknown>;

function parseFrontMatter(raw: string): { body: string; data: HugoMeta } {
  const m = raw.match(FM_BLOCK);
  if (!m) {
    throw new Error(
      "Front Matter が見つかりません。ファイル先頭が `---` で始まり、2つ目の `---` の後に本文がある必要があります。"
    );
  }
  const yamlText = m[1];
  const body = m[2];
  let data: HugoMeta;
  try {
    const loaded = yaml.load(yamlText);
    if (loaded === null || loaded === undefined) {
      throw new Error("YAML が空です。");
    }
    if (typeof loaded !== "object" || Array.isArray(loaded)) {
      throw new Error("Front Matter のルートはオブジェクト（マッピング）である必要があります。");
    }
    data = loaded as HugoMeta;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`YAML の解析に失敗しました: ${msg}`);
  }
  return { body, data };
}

function tagsToString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter(Boolean).join(", ");
  }
  return String(v);
}

function parseTagsInput(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function formatDraft(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

function buildDocument(data: HugoMeta, body: string): string {
  const front = yaml.dump(data, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  }).trimEnd();
  return `---\n${front}\n---\n${body}`;
}

function normalizeBaseUrl(input: string): string {
  const u = input.trim().replace(/\/+$/, "");
  if (!u) throw new Error("WebDAV ベースURL を入力してください。");
  return u;
}

function normalizeFilePath(input: string): string {
  let p = input.trim();
  if (!p) throw new Error("ファイルパスを入力してください。");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p === "/") {
    throw new Error(
      "ルート `/` だけではファイルを開けません。Finder で見える階層に合わせ、`content/posts/hello.md` のように **実在する .md ファイル**のパスを指定してください。"
    );
  }
  return p;
}

function formatError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const lower = raw.toLowerCase();
  const isFetchBlocked =
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    (typeof e === "object" &&
      e !== null &&
      "name" in e &&
      (e as { name?: string }).name === "TypeError" &&
      raw === "Failed to fetch");

  if (isFetchBlocked) {
    return [
      "ブラウザが通信を完了できませんでした（多くの場合は CORS のため、レスポンスが届いていません）。",
      "",
      "手許で開発するときの対処:",
      "1) プロジェクト直下に `.env.local` を作り `VITE_DEV_WEBDAV_TARGET=http://www.chem.okayama-u.ac.jp` のように転送先を書く（例は .env.example 参照）。",
      "2) `npm run dev` を再起動し、ベースURLを次の形にする: `http://localhost:5173/__webdav/chemweb`（パスは Finder と同じ階層のファイル）。",
      "3) または WebDAV サーバ側で `http://localhost:5173` を CORS 許可する。",
      "",
      `（技術メッセージ: ${raw}）`,
    ].join("\n");
  }
  return raw;
}

function makeClient(baseUrl: string): WebDAVClient {
  return createClient(normalizeBaseUrl(baseUrl));
}

// --- DOM ---
const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <header>
    <h1>Antifreeze <span style="font-weight:400;color:#71717a;font-size:0.85em">prototype</span></h1>
  </header>
  <section class="panel panel--connection" aria-label="接続">
    <label>WebDAV ベースURL（例: <code>https://example.com/chem-web</code>）</label>
    <input type="url" id="baseUrl" autocomplete="url" placeholder="https://サーバ/chem-web" />
    <label style="margin-top:0.5rem">ファイルパス（WebDAV ルートからの絶対パス）</label>
    <input type="text" id="filePath" placeholder="/content/posts/hello.md" spellcheck="false" />
    <div class="row-actions">
      <button type="button" class="primary" id="btnLoad">開く</button>
      <button type="button" id="btnSave" disabled>保存</button>
    </div>
    <p class="hint">
      <strong>Failed to fetch</strong> が出る場合は CORS が原因のことが多いです。
      <code>.env.local</code> に <code>VITE_DEV_WEBDAV_TARGET=…</code> を書き、ベースURLを
      <code>http://localhost:5173/__webdav/chemweb</code> のようにするとプロキシで回避できます（<code>.env.example</code> 参照）。
      ファイルパスは <code>/</code> ではなく、実際の <code>.md</code> まで指定してください。
    </p>
  </section>
  <div id="error" role="alert" hidden></div>
  <section class="panel" id="meta-panel" hidden>
    <h2>メタデータ（Hugo・固定項目）</h2>
    <div id="meta-form">
      <label>title <input type="text" id="fm-title" autocomplete="off" /></label>
      <label>date（文字列のまま保存。例: 2026-03-31T12:00:00+09:00） <input type="text" id="fm-date" /></label>
      <label class="checkbox-row"><input type="checkbox" id="fm-draft" /> draft</label>
      <label>tags（カンマ区切り） <input type="text" id="fm-tags" placeholder="foo, bar" /></label>
    </div>
  </section>
  <section class="panel" id="editor-panel" hidden>
    <h2>本文（Markdown）</h2>
    <div class="editor-wrap" id="editor-root"></div>
  </section>
`;

const el = {
  baseUrl: app.querySelector<HTMLInputElement>("#baseUrl")!,
  filePath: app.querySelector<HTMLInputElement>("#filePath")!,
  btnLoad: app.querySelector<HTMLButtonElement>("#btnLoad")!,
  btnSave: app.querySelector<HTMLButtonElement>("#btnSave")!,
  error: app.querySelector<HTMLDivElement>("#error")!,
  metaPanel: app.querySelector<HTMLElement>("#meta-panel")!,
  editorPanel: app.querySelector<HTMLElement>("#editor-panel")!,
  fmTitle: app.querySelector<HTMLInputElement>("#fm-title")!,
  fmDate: app.querySelector<HTMLInputElement>("#fm-date")!,
  fmDraft: app.querySelector<HTMLInputElement>("#fm-draft")!,
  fmTags: app.querySelector<HTMLInputElement>("#fm-tags")!,
  editorRoot: app.querySelector<HTMLDivElement>("#editor-root")!,
};

let client: WebDAVClient | null = null;
let currentPath = "";
let metaSnapshot: HugoMeta = {};
let view: EditorView | null = null;

function showError(message: string | null) {
  if (!message) {
    el.error.hidden = true;
    el.error.textContent = "";
    return;
  }
  el.error.hidden = false;
  el.error.textContent = message;
}

function setLoadedUi(loaded: boolean) {
  el.metaPanel.hidden = !loaded;
  el.editorPanel.hidden = !loaded;
  el.btnSave.disabled = !loaded;
}

function applyMetaToForm(data: HugoMeta) {
  el.fmTitle.value = data.title != null ? String(data.title) : "";
  el.fmDate.value = data.date != null ? String(data.date) : "";
  el.fmDraft.checked = formatDraft(data.draft);
  el.fmTags.value = tagsToString(data.tags);
}

function readFormIntoMeta(base: HugoMeta): HugoMeta {
  const next = { ...base };
  next.title = el.fmTitle.value.trim() || undefined;
  next.date = el.fmDate.value.trim() || undefined;
  if (el.fmDraft.checked) next.draft = true;
  else delete next.draft;
  const tags = parseTagsInput(el.fmTags.value);
  if (tags.length) next.tags = tags;
  else delete next.tags;
  if (next.title === undefined) delete next.title;
  if (next.date === undefined) delete next.date;
  return next;
}

function destroyEditor() {
  if (view) {
    view.destroy();
    view = null;
  }
}

function createEditor(content: string) {
  destroyEditor();
  const state = EditorState.create({
    doc: content,
    extensions: [basicSetup, markdown()],
  });
  view = new EditorView({ state, parent: el.editorRoot });
}

async function handleLoad() {
  showError(null);
  try {
    const base = normalizeBaseUrl(el.baseUrl.value);
    const path = normalizeFilePath(el.filePath.value);
    client = makeClient(base);
    currentPath = path;
    const raw = await client.getFileContents(path, { format: "text" });
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
    const { body, data } = parseFrontMatter(text);
    metaSnapshot = { ...data };
    applyMetaToForm(data);
    createEditor(body);
    setLoadedUi(true);
  } catch (e) {
    setLoadedUi(false);
    destroyEditor();
    showError(formatError(e));
  }
}

async function handleSave() {
  showError(null);
  if (!client || !currentPath || !view) {
    showError("先にファイルを開いてください。");
    return;
  }
  try {
    const merged = readFormIntoMeta(metaSnapshot);
    const body = view.state.doc.toString();
    const out = buildDocument(merged, body);
    parseFrontMatter(out);
    await client.putFileContents(currentPath, out, { overwrite: true });
    metaSnapshot = { ...merged };
    showError(null);
    el.btnSave.textContent = "保存した";
    setTimeout(() => {
      el.btnSave.textContent = "保存";
    }, 1200);
  } catch (e) {
    showError(formatError(e));
  }
}

el.btnLoad.addEventListener("click", () => void handleLoad());
el.btnSave.addEventListener("click", () => void handleSave());

// localStorage に接続情報のみ保存（認証なし前提のため注意書きは UI にある）
const LS_BASE = "antifreeze.baseUrl";
const LS_PATH = "antifreeze.filePath";
try {
  el.baseUrl.value = localStorage.getItem(LS_BASE) ?? "";
  el.filePath.value = localStorage.getItem(LS_PATH) ?? "";
} catch {
  /* ignore */
}
el.baseUrl.addEventListener("change", () => {
  try {
    localStorage.setItem(LS_BASE, el.baseUrl.value);
  } catch {
    /* ignore */
  }
});
el.filePath.addEventListener("change", () => {
  try {
    localStorage.setItem(LS_PATH, el.filePath.value);
  } catch {
    /* ignore */
  }
});
