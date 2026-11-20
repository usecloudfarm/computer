import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    // In dev the API lives on the server app; in production the server serves
    // this build, so the same relative paths work either way.
    proxy: { "/api": "http://localhost:8787" },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 4096 },
});
