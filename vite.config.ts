// SPDX-License-Identifier: EUPL-1.2
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development `/api` is proxied to the server API (default: a local `needforheat-server-api` on port 8080).
// In production nginx does the same (deploy/nginx.conf.template), so the Cockpit and the API share one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.NFH_API ?? "http://localhost:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
