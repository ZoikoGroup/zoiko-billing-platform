#!/bin/sh
# Production/container entrypoint. See docs/PERFORMANCE_DEPLOYMENT.md.
#
# WEB_CONCURRENCY=1   -> single uvicorn process (dev / tests / SQLite)
# WEB_CONCURRENCY=N>1 -> gunicorn with N uvicorn workers
# unset               -> min(2*cores+1, WEB_CONCURRENCY_MAX (default 4))
set -e
PORT="${APP_PORT:-8001}"
if [ -z "$WEB_CONCURRENCY" ]; then
  CORES="$(nproc 2>/dev/null || echo 1)"
  WEB_CONCURRENCY=$((2 * CORES + 1))
  MAX="${WEB_CONCURRENCY_MAX:-4}"
  if [ "$WEB_CONCURRENCY" -gt "$MAX" ]; then WEB_CONCURRENCY="$MAX"; fi
fi
export WEB_CONCURRENCY
if [ "$WEB_CONCURRENCY" -le 1 ]; then
  exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
fi
exec gunicorn app.main:app -k uvicorn.workers.UvicornWorker \
  --workers "$WEB_CONCURRENCY" --bind "0.0.0.0:$PORT" \
  --timeout "${GUNICORN_TIMEOUT:-60}" --graceful-timeout 30 --keep-alive 5
