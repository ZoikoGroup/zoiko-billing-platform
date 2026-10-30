// A deploy can replace the hashed chunk files an already-open tab still
// needs. Vite reports that as a `vite:preloadError` event; reloading once
// picks up the new index.html and its chunks. The last reload time is kept in
// sessionStorage so a chunk that is genuinely broken can't cause a reload
// loop - the error then reaches App's error boundary instead. Only this key
// is touched; auth storage is left alone.
export const CHUNK_RELOAD_KEY = "zoiko-chunk-reload-at";
export const CHUNK_RELOAD_GUARD_MS = 60_000;

const CHUNK_ERROR_PATTERN =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk .* failed/i;

export function isChunkLoadError(error) {
  if (!error) return false;
  if (error.name === "ChunkLoadError") return true;
  return CHUNK_ERROR_PATTERN.test(String(error.message || error));
}

export function handlePreloadError(event, { storage = window.sessionStorage, reload = () => window.location.reload(), now = Date.now } = {}) {
  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY));
    if (last && now() - last < CHUNK_RELOAD_GUARD_MS) return false;
    storage.setItem(CHUNK_RELOAD_KEY, String(now()));
  } catch {
    // Without sessionStorage there is no loop guard, so don't reload.
    return false;
  }
  // Stop Vite rethrowing; the page is about to be replaced. location.reload()
  // keeps the full URL (path, query and hash).
  event.preventDefault();
  reload();
  return true;
}

export function installChunkReloadRecovery(target = window) {
  const listener = (event) => handlePreloadError(event);
  target.addEventListener("vite:preloadError", listener);
  return () => target.removeEventListener("vite:preloadError", listener);
}
