import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // In dev the API runs separately; in production the Node server serves this build.
  server: { proxy: { "/api": "http://localhost:3000" } },
});
