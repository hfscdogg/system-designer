import { describe, expect, it } from "vitest";
import type { RunSignal } from "@sd/core";
import { reconcileRuns, type WorkflowPort } from "../src/index.ts";
import { testStore } from "../../../packages/store/test/helpers.ts";

class RecordingPort implements WorkflowPort {
  started: string[] = [];
  failFor = new Set<string>();
  async start(runId: string) {
    if (this.failFor.has(runId)) throw new Error("temporal unreachable");
    this.started.push(runId);
  }
  async signal(_runId: string, _s: RunSignal) {}
  async isRunning(_runId: string) {
    return false;
  }
}

async function runIn(store: Awaited<ReturnType<typeof testStore>>["store"], id: string, thread: string) {
  const zack = (await store.resolvePerson("google_chat", "users/zack"))!;
  const { intake } = await store.captureIntake(
    { platform: "google_chat", providerMessageId: id, spaceId: "spaces/A", threadId: thread, requesterProviderId: "users/zack",
      requesterEmail: null, text: "x", attachments: [], providerTime: null, rawBytes: new TextEncoder().encode(id) },
    zack,
    1,
  );
  const started = await store.startRun(intake);
  if (!started.ok) throw new Error(started.reason);
  return started.run;
}

describe("reconcileRuns", () => {
  it("starts workflows only for active runs old enough, and reports failures", async () => {
    const { store, db } = await testStore();
    const a = await runIn(store, "m1", "spaces/A/threads/1");
    const b = await runIn(store, "m2", "spaces/A/threads/2");
    const c = await runIn(store, "m3", "spaces/A/threads/3");
    await store.transitionRun(c.id, "BLOCKED", "system", { error: "x" });
    await db.query(`UPDATE runs SET updated_at = now() - interval '1 hour'`);
    const fresh = await runIn(store, "m4", "spaces/A/threads/4");

    const port = new RecordingPort();
    port.failFor.add(b.id);
    const result = await reconcileRuns(store, port, 300);
    expect(port.started).toEqual([a.id]);
    expect(result).toEqual({ checked: [a.id, b.id], failed: [b.id] });
    expect(result.checked).not.toContain(fresh.id);
    expect(result.checked).not.toContain(c.id);
  });
});
