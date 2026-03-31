import yaml from "js-yaml";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type { StorageProvider, DirEntry } from "./storage";
import { WebDavProvider } from "./webdav-provider";

const FM_BLOCK =
  /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;

type HugoMeta = Record<string, unknown>;
type FieldKind = "string" | "number" | "boolean" | "array" | "json" | "date";
type FieldSpec = {
  key: string;
  kind: FieldKind;
};
type PreviewChunk = {
  startLine: number;
  endLine: number;
  source: string;
  isBlank: boolean;
};
type TreeNode = {
  path: string;
  name: string;
  isDir: boolean;
  expanded: boolean;
  loaded: boolean;
  children: TreeNode[];
  loading: boolean;
  loadError?: string;
};

const mdRenderer = new MarkdownIt({
  // Hugo (Goldmark) では単改行は段落分割にならないため breaks=false を維持
  breaks: false,
  // Goldmark 寄せ: URL 自動リンク化は行わない
  linkify: false,
  typographer: false,
  html: true,
});

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "#0f766e", fontWeight: "700" },
  { tag: tags.emphasis, color: "#7c3aed", fontStyle: "italic" },
  { tag: tags.strong, color: "#b91c1c", fontWeight: "700" },
  { tag: tags.link, color: "#1d4ed8", textDecoration: "underline" },
  { tag: tags.url, color: "#1d4ed8" },
  { tag: tags.monospace, color: "#111827", backgroundColor: "#f3f4f6" },
  { tag: tags.quote, color: "#475569" },
  { tag: tags.list, color: "#0f172a" },
  { tag: tags.comment, color: "#6b7280" },
]);

function parseFrontMatter(raw: string): { body: string; data: HugoMeta } {
  const m = raw.match(FM_BLOCK);
  if (!m) {
    throw new Error(
      "Front Matter が見つかりません。ファイル先頭が `---` で始まり、2つ目の `---` の後に本文がある必要があります。"
    );
  }
  const yamlText = m[1];
  const body = m[2] ?? "";
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

function parseMaybeFrontMatter(
  raw: string
): { hasFrontMatter: boolean; body: string; data?: HugoMeta } {
  const looksLikeFrontMatter = /^\uFEFF?---\r?\n/.test(raw);
  if (!looksLikeFrontMatter) {
    return { hasFrontMatter: false, body: raw };
  }
  const parsed = parseFrontMatter(raw);
  return { hasFrontMatter: true, body: parsed.body, data: parsed.data };
}

function inferFieldKind(value: unknown): FieldKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) {
    const scalarOnly = value.every(
      (v) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
    );
    return scalarOnly ? "array" : "json";
  }
  if (value !== null && typeof value === "object") return "json";
  return "string";
}

function isDateLikeKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === "date";
}

function toJstDateInputValue(raw: string): string | null {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const day = get("day");
  const h = get("hour");
  const min = get("minute");
  if (!y || !m || !day || !h || !min) return null;
  return `${y}-${m}-${day}T${h}:${min}`;
}

function jstDateInputToIso(input: string): string {
  // datetime-local の値を JST として固定化して保存する
  return `${input}:00+09:00`;
}

function scalarArrayToInput(v: unknown[]): string {
  return v.map((item) => String(item)).join(", ");
}

function parseScalarArray(input: string): string[] {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
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

function normalizeTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

function normalizeFilePath(input: string): string {
  let p = input.trim();
  if (!p) throw new Error("ファイルパスを入力してください。");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p === "/") {
    throw new Error(
      "ルート `/` だけではファイルを開けません。実在する .md ファイルのパスを指定してください。"
    );
  }
  return p;
}

function normalizePreviewBaseUrl(input: string): string {
  const u = input.trim().replace(/\/+$/, "");
  if (!u) return "http://www.chem.okayama-u.ac.jp:1313";
  return u;
}

function parsePreviewSourceRoots(raw: string | undefined): string[] {
  const fromEnv = (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const roots =
    fromEnv.length > 0
      ? Array.from(new Set(fromEnv))
      : // 既定: 既存 content 配下に加え、exampleSite/content 配下も扱う
        ["content", "exampleSite/content", "exampleSite"];
  // より具体的な（長い）ルートを先に試す
  return roots.sort((a, b) => b.length - a.length);
}

const PREVIEW_SOURCE_ROOTS = parsePreviewSourceRoots(
  import.meta.env.VITE_PREVIEW_SOURCE_ROOTS
);

function derivePreviewUrl(filePath: string, previewBase: string): string | null {
  const normalized = stripBasePrefix(filePath).replace(/^\/+|\/+$/g, "");
  let rel: string | null = null;
  for (const root of PREVIEW_SOURCE_ROOTS) {
    if (normalized === root) {
      rel = "";
      break;
    }
    if (normalized.startsWith(`${root}/`)) {
      rel = normalized.slice(root.length + 1);
      break;
    }
  }
  if (rel == null) return null;
  // 運用上 `exampleSite/content/...` を扱うため、先頭 content はURL投影時に除去する
  if (rel === "content") rel = "";
  else if (rel.startsWith("content/")) rel = rel.slice("content/".length);
  if (!rel.toLowerCase().endsWith(".md")) return null;
  const isEnglish = /\.en\.md$/i.test(rel);
  rel = rel.replace(/\.md$/i, "");
  rel = rel.replace(/\.(ja|en)$/i, "");
  if (rel.endsWith("/index")) rel = rel.slice(0, -"/index".length);
  if (rel.endsWith("/_index")) rel = rel.slice(0, -"/_index".length);
  rel = rel.replace(/^\/+|\/+$/g, "");
  const langPrefix = isEnglish ? "/en" : "";
  return rel ? `${previewBase}${langPrefix}/${rel}` : `${previewBase}${langPrefix}/`;
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

function createProvider(baseUrl: string): StorageProvider {
  return new WebDavProvider(baseUrl);
}

// --- DOM ---
const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <header>
    <h1>Antifreeze <span style="font-weight:400;color:#71717a;font-size:0.85em">prototype</span></h1>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <section class="panel" id="browser-panel">
        <div class="row-actions" style="margin-top:0">
          <h2 style="margin:0;flex:1">ファイルブラウザ（階層）</h2>
          <button type="button" id="btnBrowse">再読込</button>
        </div>
        <div id="browser-tree" class="browser-tree"></div>
      </section>

      <details class="panel panel--connection">
        <summary>接続設定（通常は変更不要）</summary>
        <label>WebDAV ベースURL（例: <code>https://example.com/chem-web</code>）</label>
        <input type="url" id="baseUrl" autocomplete="url" placeholder="https://サーバ/chem-web" />
        <label style="margin-top:0.5rem">ファイルパス（手動指定時のみ）</label>
        <input type="text" id="filePath" placeholder="/content/posts/hello.md" spellcheck="false" />
        <label style="margin-top:0.5rem">ブラウザ開始パス（ディレクトリ）</label>
        <input type="text" id="browseRoot" placeholder="/content/" spellcheck="false" />
        <label style="margin-top:0.5rem">プレビューサイトURL（任意）</label>
        <input type="url" id="previewBaseUrl" placeholder="http://www.chem.okayama-u.ac.jp:1313" />
        <div class="row-actions">
          <button type="button" class="primary" id="btnLoad">パスを開く</button>
        </div>
        <p class="hint">
          <strong>Failed to fetch</strong> が出る場合は CORS が原因のことが多いです。
          <code>.env.local</code> に <code>VITE_DEV_WEBDAV_TARGET=…</code> を書き、ベースURLを
          <code>http://localhost:5173/__webdav/chemweb</code> のようにするとプロキシで回避できます（<code>.env.example</code> 参照）。
        </p>
      </details>
    </aside>

    <main class="main">
      <div id="error" role="alert" hidden></div>
      <section class="panel panel--editor" id="editor-panel" hidden>
        <div class="split">
          <div class="split__left">
            <h2>本文（Markdown）</h2>
            <div class="editor-wrap" id="editor-root"></div>
          </div>
          <aside class="split__right" aria-label="プレビュー">
            <h2>プレビュー</h2>
            <div id="preview" class="preview-pane"></div>
          </aside>
        </div>
      </section>
      <div class="row-actions row-actions--sticky top-right-actions">
        <button type="button" class="btn-meta" id="btnMeta" disabled>メタデータ</button>
        <button type="button" class="btn-previewsite" id="btnPreviewSite" disabled>サイトで確認</button>
        <button type="button" class="btn-save" id="btnSave" disabled>保存</button>
        <button type="button" class="btn-saveas" id="btnSaveAs" disabled>別名で保存</button>
        <button type="button" class="btn-delete" id="btnDelete" disabled>削除</button>
      </div>
    </main>
  </div>
  <dialog id="metaDialog" class="meta-dialog">
    <form method="dialog" class="meta-dialog__inner">
      <div class="meta-dialog__head">
        <h2>メタデータ（既存 Front Matter の全項目）</h2>
        <button type="submit" class="meta-dialog__close" aria-label="閉じる">閉じる</button>
      </div>
      <div id="meta-form" class="meta-dialog__body"></div>
    </form>
  </dialog>
`;

const el = {
  baseUrl: app.querySelector<HTMLInputElement>("#baseUrl")!,
  filePath: app.querySelector<HTMLInputElement>("#filePath")!,
  browseRoot: app.querySelector<HTMLInputElement>("#browseRoot")!,
  previewBaseUrl: app.querySelector<HTMLInputElement>("#previewBaseUrl")!,
  btnLoad: app.querySelector<HTMLButtonElement>("#btnLoad")!,
  btnBrowse: app.querySelector<HTMLButtonElement>("#btnBrowse")!,
  btnMeta: app.querySelector<HTMLButtonElement>("#btnMeta")!,
  btnPreviewSite: app.querySelector<HTMLButtonElement>("#btnPreviewSite")!,
  btnSave: app.querySelector<HTMLButtonElement>("#btnSave")!,
  btnSaveAs: app.querySelector<HTMLButtonElement>("#btnSaveAs")!,
  btnDelete: app.querySelector<HTMLButtonElement>("#btnDelete")!,
  browserPanel: app.querySelector<HTMLElement>("#browser-panel")!,
  browserTree: app.querySelector<HTMLDivElement>("#browser-tree")!,
  error: app.querySelector<HTMLDivElement>("#error")!,
  metaDialog: app.querySelector<HTMLDialogElement>("#metaDialog")!,
  editorPanel: app.querySelector<HTMLElement>("#editor-panel")!,
  metaForm: app.querySelector<HTMLDivElement>("#meta-form")!,
  editorRoot: app.querySelector<HTMLDivElement>("#editor-root")!,
  preview: app.querySelector<HTMLDivElement>("#preview")!,
};

let provider: StorageProvider | null = null;
let currentPath = "";
let metaSnapshot: HugoMeta = {};
let metaFields: FieldSpec[] = [];
let view: EditorView | null = null;
let previewDebounce: number | undefined;
let activePreviewBlock: HTMLElement | null = null;
let treeRoot: TreeNode | null = null;
let currentHasFrontMatter = true;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function replaceShortcodesForPreview(md: string): string {
  return md.replace(/\{\{[%<]\s*([\s\S]*?)\s*[>%]\}\}/g, (_m, inner: string) => {
    const label = inner.replace(/\s+/g, " ").trim();
    const display = label.length > 90 ? `${label.slice(0, 90)}...` : label;
    return `<span class="shortcode-pill">SHORTCODE: ${escapeHtml(display)}</span>`;
  });
}

function schedulePreviewRefresh() {
  window.clearTimeout(previewDebounce);
  previewDebounce = window.setTimeout(() => void refreshPreview(), 120);
}

function getCursorLineNumber(): number | null {
  if (!view) return null;
  return view.state.doc.lineAt(view.state.selection.main.head).number;
}

function splitMarkdownChunks(md: string): PreviewChunk[] {
  const lines = md.split("\n");
  const chunks: PreviewChunk[] = [];
  let startLine = 1;
  let buffer: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  const flushBuffer = (endLine: number) => {
    if (buffer.length === 0) return;
    chunks.push({
      startLine,
      endLine,
      source: buffer.join("\n"),
      isBlank: false,
    });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

    if (!inFence && fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
    } else if (inFence && fenceMatch) {
      const c = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      if (c === fenceChar && len >= fenceLen) inFence = false;
    }

    if (!inFence && trimmed === "") {
      flushBuffer(lineNo - 1);
      chunks.push({
        startLine: lineNo,
        endLine: lineNo,
        source: "",
        isBlank: true,
      });
      startLine = lineNo + 1;
      continue;
    }

    if (buffer.length === 0) startLine = lineNo;
    buffer.push(line);
  }

  flushBuffer(lines.length);
  if (chunks.length === 0) {
    chunks.push({
      startLine: 1,
      endLine: 1,
      source: "",
      isBlank: true,
    });
  }
  return chunks;
}

function updatePreviewHighlight() {
  if (!view) return;
  const lineNo = getCursorLineNumber();
  if (lineNo == null) return;

  activePreviewBlock?.classList.remove("is-active");
  const blocks = el.preview.querySelectorAll<HTMLElement>(".preview-block");
  let node: HTMLElement | null = null;
  for (const block of blocks) {
    const start = Number(block.dataset.startLine);
    const end = Number(block.dataset.endLine);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (start <= lineNo && lineNo <= end) {
      node = block;
      break;
    }
  }
  if (node) {
    node.classList.add("is-active");
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  activePreviewBlock = node;
}

async function refreshPreview() {
  if (!view) return;
  const md = view.state.doc.toString();
  try {
    const chunks = splitMarkdownChunks(md);
    const rendered = chunks.map((chunk) => {
      if (chunk.isBlank) {
        return `<div class="preview-block preview-block--blank" data-start-line="${chunk.startLine}" data-end-line="${chunk.endLine}"><br></div>`;
      }
      const htmlWithShortcode = DOMPurify.sanitize(
        mdRenderer.render(replaceShortcodesForPreview(chunk.source))
      );
      return `<div class="preview-block" data-start-line="${chunk.startLine}" data-end-line="${chunk.endLine}">${htmlWithShortcode}</div>`;
    });
    el.preview.innerHTML = rendered.join("");
    activePreviewBlock = null;
    updatePreviewHighlight();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    el.preview.innerHTML = `<p class="preview-error">${escapeHtml(msg)}</p>`;
    activePreviewBlock = null;
  }
}

function showError(message: string | null) {
  if (!message) {
    el.error.hidden = true;
    el.error.textContent = "";
    return;
  }
  el.error.hidden = false;
  el.error.textContent = message;
}

function setLoadedUi(loaded: boolean, hasFrontMatter: boolean) {
  el.editorPanel.hidden = !loaded;
  el.btnMeta.disabled = !loaded || !hasFrontMatter;
  const previewUrl = loaded
    ? derivePreviewUrl(currentPath, normalizePreviewBaseUrl(el.previewBaseUrl.value))
    : null;
  el.btnPreviewSite.disabled = !loaded || !previewUrl;
  el.btnSave.disabled = !loaded;
  el.btnSaveAs.disabled = !loaded;
  el.btnDelete.disabled = !loaded;
}

function setBrowserUi(loaded: boolean) {
  if (!loaded) {
    el.browserTree.innerHTML = `<div class="tree-empty">（読込失敗）接続設定を確認してください。</div>`;
  }
}

function renderMetaForm(data: HugoMeta) {
  el.metaForm.innerHTML = "";
  metaFields = Object.keys(data).map((key) => {
    const v = data[key];
    if (isDateLikeKey(key) && (typeof v === "string" || v == null)) {
      return { key, kind: "date" } as FieldSpec;
    }
    return { key, kind: inferFieldKind(v) } as FieldSpec;
  });

  for (const field of metaFields) {
    const wrapper = document.createElement("label");
    wrapper.textContent = field.key;
    const current = data[field.key];

    if (field.kind === "boolean") {
      wrapper.className = "checkbox-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.fmKey = field.key;
      checkbox.dataset.fmKind = field.kind;
      checkbox.checked = current === true;
      wrapper.textContent = "";
      wrapper.append(checkbox, document.createTextNode(field.key));
    } else if (field.kind === "json") {
      const textarea = document.createElement("textarea");
      textarea.dataset.fmKey = field.key;
      textarea.dataset.fmKind = field.kind;
      textarea.spellcheck = false;
      textarea.rows = 5;
      textarea.value = JSON.stringify(current, null, 2);
      wrapper.appendChild(textarea);
    } else if (field.kind === "date") {
      const row = document.createElement("div");
      row.className = "date-row";
      const dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.dataset.fmKey = field.key;
      dateInput.dataset.fmKind = field.kind;
      dateInput.dataset.fmPart = "date";
      const timeInput = document.createElement("input");
      timeInput.type = "time";
      timeInput.step = "60";
      timeInput.dataset.fmKey = field.key;
      timeInput.dataset.fmKind = field.kind;
      timeInput.dataset.fmPart = "time";
      timeInput.value = "00:00";
      if (typeof current === "string" && current.trim()) {
        const jst = toJstDateInputValue(current);
        if (jst) {
          const [d, t] = jst.split("T");
          dateInput.value = d ?? "";
          timeInput.value = t ?? "00:00";
        }
      }
      row.append(dateInput, timeInput);
      wrapper.appendChild(row);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.dataset.fmKey = field.key;
      input.dataset.fmKind = field.kind;
      input.spellcheck = false;
      if (field.kind === "array" && Array.isArray(current)) {
        input.value = scalarArrayToInput(current);
      } else if (current != null) {
        input.value = String(current);
      }
      wrapper.appendChild(input);
    }
    el.metaForm.appendChild(wrapper);
  }
}

function readFormIntoMeta(base: HugoMeta): HugoMeta {
  const next = { ...base };
  for (const field of metaFields) {
    const key = field.key;
    const node = el.metaForm.querySelector<HTMLElement>(
      `[data-fm-key="${CSS.escape(key)}"]`
    );
    if (!node) continue;
    if (field.kind === "boolean") {
      next[key] = (node as HTMLInputElement).checked;
      continue;
    }
    const raw = (node as HTMLInputElement | HTMLTextAreaElement).value;
    if (field.kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new Error(`Front Matter の ${key} は数値で入力してください。`);
      }
      next[key] = n;
      continue;
    }
    if (field.kind === "array") {
      next[key] = parseScalarArray(raw);
      continue;
    }
    if (field.kind === "date") {
      const dateNode = el.metaForm.querySelector<HTMLInputElement>(
        `[data-fm-key="${CSS.escape(key)}"][data-fm-part="date"]`
      );
      const timeNode = el.metaForm.querySelector<HTMLInputElement>(
        `[data-fm-key="${CSS.escape(key)}"][data-fm-part="time"]`
      );
      const d = dateNode?.value ?? "";
      const t = timeNode?.value ?? "";
      if (!d) {
        next[key] = "";
      } else {
        next[key] = jstDateInputToIso(`${d}T${t || "00:00"}`);
      }
      continue;
    }
    if (field.kind === "json") {
      try {
        next[key] = JSON.parse(raw);
      } catch {
        throw new Error(`Front Matter の ${key} は JSON として正しい形式で入力してください。`);
      }
      continue;
    }
    next[key] = raw;
  }
  return next;
}

function destroyEditor() {
  window.clearTimeout(previewDebounce);
  if (view) {
    view.destroy();
    view = null;
  }
  el.preview.innerHTML = "";
}

function isMarkdownFile(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function sortTreeEntries(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, "ja");
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function shouldDisplayEntry(entry: DirEntry): boolean {
  const n = entry.name;
  if (n === "." || n === "..") return false;
  if (n.startsWith("._")) return false;
  if (entry.isDir && n.toLowerCase() === "chemweb") return false;
  if (!entry.isDir && !isMarkdownFile(entry.path)) return false;
  return true;
}

function dirEntryToTreeNode(entry: DirEntry): TreeNode {
  return {
    path: entry.path,
    name: entry.name,
    isDir: entry.isDir,
    expanded: false,
    loaded: false,
    children: [],
    loading: false,
  };
}

async function fetchChildren(node: TreeNode): Promise<void> {
  if (!provider || !node.isDir) return;
  node.loading = true;
  node.loadError = undefined;
  renderBrowserTree();
  try {
    const entries = await provider.listDirectory(node.path);
    node.children = entries
      .filter(shouldDisplayEntry)
      .map(dirEntryToTreeNode)
      .sort(sortTreeEntries);
    node.loaded = true;
  } catch (e) {
    node.loadError = formatError(e);
    node.loaded = false;
    showError(node.loadError);
    throw e;
  } finally {
    node.loading = false;
    renderBrowserTree();
  }
}

async function toggleNode(node: TreeNode): Promise<void> {
  if (!node.isDir) return;
  node.expanded = !node.expanded;
  renderBrowserTree();
  if (node.expanded && !node.loaded) {
    try {
      await fetchChildren(node);
    } catch {
      // エラーは fetchChildren 内で表示済み
    }
  }
}

async function loadFilePath(path: string): Promise<void> {
  el.filePath.value = path;
  await handleLoad();
}

function renderTreeNode(node: TreeNode, container: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.path = node.path;
  const icon = node.isDir ? (node.expanded ? "📂" : "📁") : "📄";
  const label = document.createElement("button");
  label.type = "button";
  label.className = "tree-button";
  label.textContent = `${icon} ${node.name}`;

  if (node.isDir) {
    label.addEventListener("click", () => void toggleNode(node));
  } else if (isMarkdownFile(node.path)) {
    label.addEventListener("click", () => void loadFilePath(node.path));
  } else {
    label.disabled = true;
    label.classList.add("tree-button--muted");
  }
  row.appendChild(label);
  container.appendChild(row);

  if (node.isDir && node.expanded) {
    const childrenWrap = document.createElement("div");
    childrenWrap.className = "tree-children";
    if (node.loading) {
      const loading = document.createElement("div");
      loading.className = "tree-loading";
      loading.textContent = "読み込み中...";
      childrenWrap.appendChild(loading);
    } else if (node.loadError) {
      const err = document.createElement("div");
      err.className = "tree-empty";
      err.textContent = `（読込失敗）${node.loadError}`;
      childrenWrap.appendChild(err);
    } else if (node.children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "（空）";
      childrenWrap.appendChild(empty);
    } else {
      node.children.forEach((child) => renderTreeNode(child, childrenWrap));
    }
    container.appendChild(childrenWrap);
  }
}

function renderBrowserTree() {
  el.browserTree.innerHTML = "";
  if (!treeRoot) {
    const msg = document.createElement("div");
    msg.className = "tree-empty";
    msg.textContent = "「一覧読込」を押すと表示されます。";
    el.browserTree.appendChild(msg);
    return;
  }
  renderTreeNode(treeRoot, el.browserTree);
}

function normalizeBrowseRoot(input: string): string {
  let p = input.trim();
  if (!p) p = "/";
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

async function handleBrowse() {
  showError(null);
  try {
    const base = el.baseUrl.value.trim();
    if (!base) {
      showError("WebDAV ベースURL を入力してください。");
      return;
    }
    provider = createProvider(base);
    const rootPath = normalizeBrowseRoot(el.browseRoot.value || "/");
    treeRoot = {
      path: rootPath,
      name: rootPath === "/" ? "/" : basename(rootPath),
      isDir: true,
      expanded: true,
      loaded: false,
      children: [],
      loading: false,
    };
    setBrowserUi(true);
    renderBrowserTree();
    await fetchChildren(treeRoot);
  } catch (e) {
    setBrowserUi(false);
    treeRoot = null;
    renderBrowserTree();
    showError(formatError(e));
  }
}

function createEditor(content: string) {
  destroyEditor();
  const state = EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(markdownHighlightStyle),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) schedulePreviewRefresh();
        if (update.selectionSet && !update.docChanged) updatePreviewHighlight();
      }),
    ],
  });
  view = new EditorView({ state, parent: el.editorRoot });
  void refreshPreview();
}

async function handleLoad() {
  showError(null);
  try {
    if (!provider) {
      const base = el.baseUrl.value.trim();
      if (!base) {
        showError("WebDAV ベースURL を入力してください。");
        return;
      }
      provider = createProvider(base);
    }
    const inputPath = normalizeFilePath(el.filePath.value);
    const loaded = await provider.readFile(inputPath);
    currentPath = loaded.path;
    const text = loaded.text;
    el.filePath.value = loaded.path;
    const parsed = parseMaybeFrontMatter(text);
    currentHasFrontMatter = parsed.hasFrontMatter;
    if (parsed.hasFrontMatter && parsed.data) {
      metaSnapshot = { ...parsed.data };
      renderMetaForm(parsed.data);
    } else {
      metaSnapshot = {};
      metaFields = [];
      el.metaForm.innerHTML = "";
    }
    createEditor(parsed.body);
    setLoadedUi(true, currentHasFrontMatter);
  } catch (e) {
    setLoadedUi(false, true);
    destroyEditor();
    showError(formatError(e));
  }
}

async function handleSave() {
  showError(null);
  if (!provider || !currentPath || !view) {
    showError("先にファイルを開いてください。");
    return;
  }
  try {
    const body = view.state.doc.toString();
    let out: string;
    if (currentHasFrontMatter) {
      const merged = readFormIntoMeta(metaSnapshot);
      out = buildDocument(merged, body);
      parseFrontMatter(out);
      metaSnapshot = { ...merged };
    } else {
      out = normalizeTrailingNewline(body);
    }
    await provider.writeFile(currentPath, out, true);
    showError(null);
    el.btnSave.textContent = "保存した";
    setTimeout(() => {
      el.btnSave.textContent = "保存";
    }, 1200);
  } catch (e) {
    showError(formatError(e));
  }
}

async function handleSaveAs() {
  showError(null);
  if (!provider || !currentPath || !view) {
    showError("先にファイルを開いてください。");
    return;
  }
  const proposal = currentPath.replace(/\.md$/i, "-new.md");
  const nextPathRaw = window.prompt("別名保存先のパス（.md）", proposal);
  if (!nextPathRaw) return;
  const nextPath = normalizeFilePath(nextPathRaw);
  if (!nextPath.toLowerCase().endsWith(".md")) {
    showError("別名で保存するパスは .md を指定してください。");
    return;
  }
  try {
    const body = view.state.doc.toString();
    let out: string;
    if (currentHasFrontMatter) {
      const merged = readFormIntoMeta(metaSnapshot);
      out = buildDocument(merged, body);
      parseFrontMatter(out);
      metaSnapshot = { ...merged };
    } else {
      out = normalizeTrailingNewline(body);
    }
    await provider.writeFile(nextPath, out, false);
    currentPath = nextPath;
    el.filePath.value = nextPath;
    showError(null);
    el.btnSaveAs.textContent = "別名保存した";
    setTimeout(() => {
      el.btnSaveAs.textContent = "別名で保存";
    }, 1200);
    await handleBrowse();
  } catch (e) {
    showError(formatError(e));
  }
}

async function handleDelete() {
  showError(null);
  if (!provider || !currentPath) {
    showError("先にファイルを開いてください。");
    return;
  }
  const ok = window.confirm(`このファイルを削除しますか?\n${currentPath}`);
  if (!ok) return;
  try {
    await provider.deleteFile(currentPath);
    destroyEditor();
    setLoadedUi(false, false);
    currentPath = "";
    el.filePath.value = "";
    showError("削除しました。");
    await handleBrowse();
  } catch (e) {
    showError(formatError(e));
  }
}

function handleOpenMetaDialog() {
  if (el.btnMeta.disabled) return;
  if (!el.metaDialog.open) el.metaDialog.showModal();
}

function handleOpenPreviewSite() {
  if (!currentPath) return;
  const base = normalizePreviewBaseUrl(el.previewBaseUrl.value);
  const url = derivePreviewUrl(currentPath, base);
  if (!url) {
    showError("このファイルは preview 対象外です（content 配下の .md のみ）。");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

el.btnLoad.addEventListener("click", () => void handleLoad());
el.btnBrowse.addEventListener("click", () => void handleBrowse());
el.btnMeta.addEventListener("click", () => handleOpenMetaDialog());
el.btnPreviewSite.addEventListener("click", () => handleOpenPreviewSite());
el.btnSave.addEventListener("click", () => void handleSave());
el.btnSaveAs.addEventListener("click", () => void handleSaveAs());
el.btnDelete.addEventListener("click", () => void handleDelete());

// localStorage に接続情報のみ保存（認証なし前提のため注意書きは UI にある）
const LS_BASE = "antifreeze.baseUrl";
const LS_PATH = "antifreeze.filePath";
const LS_BROWSE_ROOT = "antifreeze.browseRoot";
const LS_PREVIEW_BASE = "antifreeze.previewBaseUrl";
const DEFAULT_WEBDAV_BASE_URL =
  import.meta.env.VITE_DEFAULT_WEBDAV_BASE_URL?.trim() ?? "";
const DEFAULT_BROWSE_ROOT =
  import.meta.env.VITE_DEFAULT_BROWSE_ROOT?.trim() || "/";
try {
  el.baseUrl.value = localStorage.getItem(LS_BASE) ?? DEFAULT_WEBDAV_BASE_URL;
  el.filePath.value = localStorage.getItem(LS_PATH) ?? "";
  el.browseRoot.value = localStorage.getItem(LS_BROWSE_ROOT) ?? DEFAULT_BROWSE_ROOT;
  el.previewBaseUrl.value =
    localStorage.getItem(LS_PREVIEW_BASE) ?? "http://www.chem.okayama-u.ac.jp:1313";
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
el.browseRoot.addEventListener("change", () => {
  try {
    localStorage.setItem(LS_BROWSE_ROOT, el.browseRoot.value);
  } catch {
    /* ignore */
  }
});
el.previewBaseUrl.addEventListener("change", () => {
  try {
    localStorage.setItem(LS_PREVIEW_BASE, el.previewBaseUrl.value);
  } catch {
    /* ignore */
  }
  setLoadedUi(Boolean(currentPath), currentHasFrontMatter);
});

if (el.baseUrl.value.trim()) {
  void handleBrowse();
}
