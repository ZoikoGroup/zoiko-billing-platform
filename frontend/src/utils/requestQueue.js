/**
 * Tiny concurrency limiter with priorities.
 *
 *   const queue = createRequestQueue(6);
 *   queue.run(() => api.get("/x"), { priority: 10 });   // higher runs first
 *
 * - at most `concurrency` task functions are in flight at once
 * - waiting tasks start highest `priority` first, FIFO within a priority
 * - run() returns a promise that settles exactly like the task's promise
 *   (a throwing/rejecting task frees its slot and propagates to the caller)
 * - clear() drops tasks that have not started (their promises never settle,
 *   intended for unmount cleanup)
 */
export const DEFAULT_CONCURRENCY = 6;

export function createRequestQueue(concurrency = DEFAULT_CONCURRENCY) {
  const limit = Math.max(1, Math.floor(concurrency) || DEFAULT_CONCURRENCY);
  let active = 0;
  let seq = 0;
  let waiting = [];

  const next = () => {
    while (active < limit && waiting.length > 0) {
      let best = 0;
      for (let i = 1; i < waiting.length; i += 1) {
        const a = waiting[i];
        const b = waiting[best];
        if (a.priority > b.priority || (a.priority === b.priority && a.order < b.order)) best = i;
      }
      const [job] = waiting.splice(best, 1);
      active += 1;
      let result;
      try {
        result = Promise.resolve(job.task());
      } catch (err) {
        result = Promise.reject(err);
      }
      result.then(job.resolve, job.reject).finally(() => {
        active -= 1;
        next();
      });
    }
  };

  return {
    run(task, { priority = 0 } = {}) {
      return new Promise((resolve, reject) => {
        waiting.push({ task, priority, order: seq += 1, resolve, reject });
        next();
      });
    },
    clear() {
      waiting = [];
    },
    get active() {
      return active;
    },
    get pending() {
      return waiting.length;
    },
  };
}

export default createRequestQueue;
