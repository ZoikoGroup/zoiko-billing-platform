import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.js"],
    css: false,
    // frontend/tests/**/*.spec.ts are Playwright E2E specs, run via
    // `npx playwright test` — vitest must not attempt to import them.
    include: ["src/**/*.test.{js,jsx,ts,tsx}"],
  },
});
