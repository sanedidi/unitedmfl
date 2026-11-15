import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Team registration site: its own origin (e.g. ariza.unitedmfl.uz), the Go API
// on the same origin under /api (Caddy proxies it). In development Vite proxies
// /api and /uploads to the local API.
const api = process.env.API_URL || "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5174, proxy: { "/api": { target: api, changeOrigin: true }, "/uploads": { target: api, changeOrigin: true } } },
  preview: { port: 4174, proxy: { "/api": { target: api, changeOrigin: true }, "/uploads": { target: api, changeOrigin: true } } },
  build: { sourcemap: false },
});
