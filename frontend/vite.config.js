import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:8002",
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
        // Rolldown's manualChunks shim pulls each chunk's dependencies in
        // recursively, which dragged React core into vendor-charts (so the
        // entry modulepreloaded recharts on every page). codeSplitting groups
        // with includeDependenciesRecursively:false keep each lib in its own
        // chunk; higher priority wins when a module matches several groups.
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            { name: "vendor-xlsx", test: /node_modules[\/](xlsx|xlsx-js-style)[\/]/, priority: 60 },
            { name: "vendor-pdf-fonts", test: /node_modules[\/]pdfmake[\/]build[\/]vfs_fonts/, priority: 70 },
            { name: "vendor-docgen", test: /node_modules[\/](pdfmake|@foliojs-fork|awesome-phonenumber)[\/]/, priority: 50 },
            { name: "vendor-charts", test: /node_modules[\/]recharts[\/]/, priority: 40 },
            { name: "vendor-icons", test: /node_modules[\/]lucide-react[\/]/, priority: 40 },
            { name: "vendor-router", test: /node_modules[\/](react-router|react-router-dom)[\/]/, priority: 40 },
            { name: "vendor-react", test: /node_modules[\/](react|react-dom|scheduler)[\/]/, priority: 30 },
          ],
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
