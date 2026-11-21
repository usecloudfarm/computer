import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = process.env["CLOUDFARM_API"] ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The agent runs server-side: it holds the API key, the filesystem and the
    // sandbox. The browser only ever talks to /api/chat.
    proxy: { "/api": { target: API, changeOrigin: true } },
  },
});
