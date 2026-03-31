import { createClient, type WebDAVClient } from "webdav";
import type { StorageProvider, DirEntry } from "./storage";

function normalizeBaseUrl(input: string): string {
  const u = input.trim().replace(/\/+$/, "");
  if (!u) throw new Error("WebDAV ベースURL を入力してください。");
  return u;
}

function extractBasePathPrefix(baseUrl: string): string {
  try {
    const p = new URL(baseUrl).pathname || "/";
    const trimmed = p.replace(/\/+$/, "");
    return trimmed ? `${trimmed}/` : "/";
  } catch {
    return "/";
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function normalizeDirPath(input: string): string {
  let p = input.trim();
  if (!p) p = "/";
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
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

export class WebDavProvider implements StorageProvider {
  readonly kind = "webdav";
  private client: WebDAVClient;
  private basePathPrefix: string;

  constructor(baseUrl: string) {
    const url = normalizeBaseUrl(baseUrl);
    this.client = createClient(url);
    this.basePathPrefix = extractBasePathPrefix(url);
  }

  private stripBasePrefix(path: string): string {
    let s = path.trim().replace(/"/g, "").replace(/\\/g, "/");
    if (/^https?:\/\//i.test(s)) {
      try {
        s = new URL(s).pathname;
      } catch {
        /* ignore */
      }
    }
    if (!s.startsWith("/")) s = `/${s}`;
    const segs = s.split("/");
    const out: string[] = [];
    for (const seg of segs) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (out.length > 0) out.pop();
        continue;
      }
      out.push(seg);
    }
    s = `/${out.join("/")}`;

    const basePrefix =
      this.basePathPrefix === "/" ? "/" : this.basePathPrefix;
    if (basePrefix !== "/") {
      const baseSegFull = basePrefix.replace(/^\/|\/$/g, "");
      const baseParts = baseSegFull.split("/").filter(Boolean);
      const leaf = baseParts[baseParts.length - 1] ?? "";
      const removable = [baseSegFull, leaf, "__webdav"].filter(Boolean);
      for (const seg of removable) {
        while (s === `/${seg}` || s.startsWith(`/${seg}/`)) {
          s = s.slice(seg.length + 1);
          if (!s.startsWith("/")) s = `/${s}`;
          if (!s || s.length === 0) s = "/";
          if (s === "/") break;
        }
      }
    }
    return s || "/";
  }

  private withBasePrefix(path: string): string {
    const clean = this.stripBasePrefix(path);
    const basePrefix =
      this.basePathPrefix === "/" ? "/" : this.basePathPrefix;
    if (basePrefix === "/") return clean;
    const prefix = basePrefix.replace(/\/+$/, "");
    return clean === "/" ? `${prefix}/` : `${prefix}${clean}`;
  }

  private candidateFilePaths(inputPath: string): string[] {
    const normalized = normalizeFilePath(inputPath);
    const stripped = this.stripBasePrefix(normalized);
    const prefixed = this.withBasePrefix(normalized);
    const out: string[] = [];
    for (const p of [normalized, stripped, prefixed]) {
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  private candidateDirectoryPaths(inputPath: string): string[] {
    const base = normalizeDirPath(inputPath);
    const stripped = normalizeDirPath(this.stripBasePrefix(base));
    const prefixed = normalizeDirPath(this.withBasePrefix(base));
    const out: string[] = [];
    for (const p of [base, stripped, prefixed]) {
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  private normalizeEntryPath(rawPath: string, parentPath: string): string {
    let s = rawPath.trim().replace(/"/g, "");
    if (/^https?:\/\//i.test(s)) {
      try {
        s = new URL(s).pathname;
      } catch {
        /* ignore */
      }
    }
    s = s.replace(/\\/g, "/");
    if (!s.startsWith("/")) {
      s = `${parentPath.replace(/\/+$/, "")}/${s}`;
    }
    const segments = s.split("/");
    const normalized: string[] = [];
    for (const seg of segments) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (normalized.length > 0) normalized.pop();
        continue;
      }
      normalized.push(seg);
    }
    let normalizedPath = `/${normalized.join("/")}`;
    const basePrefix =
      this.basePathPrefix === "/" ? "/" : this.basePathPrefix;
    if (basePrefix !== "/" && normalizedPath.startsWith(basePrefix)) {
      const stripped = normalizedPath.slice(basePrefix.length - 1);
      normalizedPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
    }
    return normalizedPath;
  }

  async listDirectory(dirPath: string): Promise<DirEntry[]> {
    const tried: string[] = [];
    const paths = this.candidateDirectoryPaths(dirPath);
    let resolvedPath = "";
    let rawList: Array<{
      filename: string;
      basename?: string;
      type?: string;
    }> = [];

    for (const p of paths) {
      tried.push(p);
      try {
        rawList = (await this.client.getDirectoryContents(p)) as typeof rawList;
        resolvedPath = p;
        break;
      } catch {
        /* try next */
      }
    }
    if (!resolvedPath) {
      throw new Error(
        `ディレクトリを開けませんでした。試行したパス: ${tried.join(" , ")}`
      );
    }

    const parentNorm = this.normalizeEntryPath(resolvedPath, resolvedPath).replace(/\/+$/, "") || "/";
    const parentName = basename(parentNorm);

    const isDotNav = (p: string) => /(^|\/)\.\.?\/?$/.test(p.trim().replace(/"/g, ""));

    return rawList
      .filter((item) => !isDotNav(item.filename ?? ""))
      .map((item) => {
        const rawPath = item.filename ?? "";
        let itemPath = this.normalizeEntryPath(rawPath, resolvedPath);
        const type = (item.type ?? "").toLowerCase();
        const isDir = type === "directory" || rawPath.endsWith("/");
        if (isDir && !itemPath.endsWith("/")) itemPath = `${itemPath}/`;
        const label = (item.basename ?? basename(itemPath) ?? "").trim();
        return {
          path: itemPath,
          name: label || basename(itemPath) || itemPath,
          isDir,
        } satisfies DirEntry;
      })
      .filter((entry) => {
        const entryNorm = this.normalizeEntryPath(entry.path, resolvedPath).replace(/\/+$/, "") || "/";
        if (entryNorm === parentNorm) return false;
        if (entry.isDir && entry.name === parentName) return false;
        return true;
      });
  }

  async readFile(filePath: string): Promise<{ path: string; text: string }> {
    const tried: string[] = [];
    const paths = this.candidateFilePaths(filePath);
    for (const p of paths) {
      tried.push(p);
      try {
        const raw = await this.client.getFileContents(p, { format: "text" });
        const text =
          typeof raw === "string"
            ? raw
            : new TextDecoder().decode(raw as ArrayBuffer);
        return { path: p, text };
      } catch {
        /* try next */
      }
    }
    throw new Error(
      `ファイルを開けませんでした。試行したパス: ${tried.join(" , ")}`
    );
  }

  async writeFile(
    filePath: string,
    content: string,
    overwrite: boolean
  ): Promise<void> {
    await this.client.putFileContents(filePath, content, { overwrite });
  }

  async deleteFile(filePath: string): Promise<void> {
    await this.client.deleteFile(filePath);
  }
}
