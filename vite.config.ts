import { defineConfig, loadEnv } from "vite";

/** 開発時のみ: ブラウザ → localhost → ここで指定したホストへ転送し CORS を回避する */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_DEV_WEBDAV_TARGET?.trim().replace(/\/+$/, "");
  const basePath = env.VITE_APP_BASE_PATH?.trim();

  return {
    base:
      basePath && basePath !== "/"
        ? `/${basePath.replace(/^\/+|\/+$/g, "")}/`
        : "/",
    server: {
      port: 5173,
      strictPort: true,
      ...(target
        ? {
            proxy: {
              "/__webdav": {
                target,
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/__webdav/, ""),
              },
            },
          }
        : {}),
    },
  };
});
