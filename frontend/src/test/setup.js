import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia — polyfill it so components using
// viewport-based hooks (e.g. useIsDesktopViewport) don't crash under test.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
