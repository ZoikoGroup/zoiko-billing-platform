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
    // Keep the default ~500 kB per-chunk warning so oversized bundles are
    // surfaced again instead of silently swallowed (it was raised to 1500 to
    // silence chart/export vendors that since moved to isolated chunks below).
    chunkSizeWarningLimit: 500,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/xlsx") || id.includes("node_modules/xlsx-js-style")) {
            return "vendor-xlsx";
          }
          if (id.includes("node_modules/pdfmake/build/vfs_fonts")) {
            return "vendor-pdf-fonts";
          }
          if (id.includes("node_modules/pdfmake") || id.includes("node_modules/@foliojs-fork") || id.includes("node_modules/awesome-phonenumber")) {
            return "vendor-docgen";
          }
          if (id.includes("node_modules/recharts")) {
            return "vendor-charts";
          }
          if (id.includes("node_modules/lucide-react")) {
            return "vendor-icons";
          }
          if (id.includes("node_modules/react-router") || id.includes("node_modules/react-router-dom")) {
            return "vendor-router";
          }
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom") || id.includes("node_modules/react-markdown") || id.includes("node_modules/scheduler")) {
            return "vendor-react";
          }
        },
      },
    },
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
