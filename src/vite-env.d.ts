/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_WEBDAV_BASE_URL?: string;
  readonly VITE_DEFAULT_BROWSE_ROOT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
