import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export function createDevProxy(portValue?: string) {
  const port = Number(portValue?.trim() || "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535.");
  return {
    "/api": `http://127.0.0.1:${port}`,
    "/ws": { target: `ws://127.0.0.1:${port}`, ws: true },
  };
}

export default defineConfig(({ mode }) => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  // Server-only configuration. Never expose this object through Vite's define/env.
  const env = loadEnv(mode, repositoryRoot, "");
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: createDevProxy(process.env.PORT || env.PORT),
    },
  };
});
