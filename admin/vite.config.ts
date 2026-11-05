import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The admin is served at its own origin (e.g. admin.unitedmfl.com) and talks to
// the Go API on the same origin under /api (Caddy proxies it). In development
// Vite proxies /api and /uploads to the local API.
const api = process.env.API_URL || "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: true }, "/uploads": { target: api, changeOrigin: true } } },
  preview: { port: 4173, proxy: { "/api": { target: api, changeOrigin: true }, "/uploads": { target: api, changeOrigin: true } } },
  build: { sourcemap: false, chunkSizeWarningLimit: 800 },
});
