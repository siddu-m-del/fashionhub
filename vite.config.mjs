import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendTarget = env.API_PROXY_TARGET || `http://127.0.0.1:${env.PORT || 3001}`;
  const proxy = {
    "/api": {
      target: backendTarget,
      changeOrigin: false,
    },
    "/uploads": {
      target: backendTarget,
      changeOrigin: false,
    },
  };

  return {
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      proxy,
    },
    preview: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      proxy,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
