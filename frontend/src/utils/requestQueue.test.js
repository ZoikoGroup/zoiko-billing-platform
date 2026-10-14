import { describe, it, expect } from "vitest";
import { createRequestQueue } from "./requestQueue";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("createRequestQueue", () => {
  it("never exceeds the concurrency cap and drains the rest", async () => {
    const q = createRequestQueue(3);
    let inflight = 0;
    let max = 0;
    const gates = Array.from({ length: 8 }, deferred);
    const results = gates.map((g, i) => q.run(async () => {
      inflight += 1; max = Math.max(max, inflight);
      await g.promise;
      inflight -= 1;
      return i;
    }));
    await Promise.resolve();
    expect(q.active).toBe(3);
    expect(q.pending).toBe(5);
    for (const g of gates) { g.resolve(); await Promise.resolve(); await Promise.resolve(); }
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(max).toBe(3);
    expect(q.active).toBe(0);
  });

  it("starts higher priority first, FIFO within a priority", async () => {
    const q = createRequestQueue(1);
    const order = [];
    const gate = deferred();
    const blocker = q.run(() => gate.promise);
    const p = [
      q.run(() => order.push("low-1"), { priority: 1 }),
      q.run(() => order.push("high"), { priority: 10 }),
      q.run(() => order.push("low-2"), { priority: 1 }),
      q.run(() => order.push("mid"), { priority: 5 }),
    ];
    gate.resolve();
    await Promise.all([blocker, ...p]);
    expect(order).toEqual(["high", "mid", "low-1", "low-2"]);
  });

  it("propagates rejections, frees the slot, and keeps going", async () => {
    const q = createRequestQueue(1);
    const bad = q.run(() => Promise.reject(new Error("nope")));
    const thrown = q.run(() => { throw new Error("sync"); });
    const good = q.run(() => "ok");
    await expect(bad).rejects.toThrow("nope");
    await expect(thrown).rejects.toThrow("sync");
    await expect(good).resolves.toBe("ok");
    expect(q.active).toBe(0);
  });

  it("clear() drops tasks that have not started", async () => {
    const q = createRequestQueue(1);
    const gate = deferred();
    let ran = false;
    q.run(() => gate.promise);
    q.run(() => { ran = true; });
    q.clear();
    gate.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(ran).toBe(false);
    expect(q.pending).toBe(0);
  });
});
