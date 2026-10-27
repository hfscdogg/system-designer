import { describe, expect, it } from "vitest";
import { DToolsReadError, httpDToolsReader, transientRead } from "../src/index.ts";

/** A fetch that answers with each response in turn and records the waits between them. */
function scripted(responses: Array<{ status: number; retryAfter?: string }>) {
  const waits: number[] = [];
  let calls = 0;
  const fetch = (async () => {
    const r = responses[Math.min(calls++, responses.length - 1)]!;
    return new Response(r.status === 200 ? JSON.stringify({ id: "p1" }) : "Too Many Requests", {
      status: r.status,
      headers: r.retryAfter ? { "retry-after": r.retryAfter } : {},
    });
  }) as typeof globalThis.fetch;
  const reader = httpDToolsReader({ apiKey: "k", basicAuth: "Basic x", fetch, sleep: async (ms) => void waits.push(ms) });
  return { reader, waits, calls: () => calls };
}

describe("D-Tools reader rate limits (staging smoke, 2026-10-27)", () => {
  it("waits and reads again when D-Tools rate-limits a read, as long as Retry-After asks", async () => {
    const t = scripted([{ status: 429, retryAfter: "2" }, { status: 429 }, { status: 200 }]);
    const read = await t.reader.getProduct("p1");
    expect(read.status).toBe(200);
    expect(t.calls()).toBe(3);
    expect(t.waits).toEqual([2000, 2000]);
  });

  it("reports a read that stays rate-limited as transient, so the build retries instead of calling the record changed", async () => {
    const t = scripted([{ status: 429 }]);
    const err = await t.reader.getProduct("p1").catch((e) => e);
    expect(err).toBeInstanceOf(DToolsReadError);
    expect(err.status).toBe(429);
    expect(t.calls()).toBe(5);
    expect(transientRead(err)).toBe(true);
  });

  it("does not retry a missing record, and calls it permanent", async () => {
    const t = scripted([{ status: 404 }]);
    const err = await t.reader.getProduct("p1").catch((e) => e);
    expect(t.calls()).toBe(1);
    expect(transientRead(err)).toBe(false);
    expect(transientRead(new DToolsReadError("outage", "Products/GetProduct", 503))).toBe(true);
    expect(transientRead(new DToolsReadError("network", "Products/GetProduct", null))).toBe(true);
  });
});
