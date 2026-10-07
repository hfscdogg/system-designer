import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { FakeChannelAdapter } from "@sd/channels";
import { recordedDToolsReader } from "@sd/dtools";
import { htmlToPdf } from "@sd/render";
import { createActivities, TASK_QUEUE, TemporalWorkflows } from "../src/index.ts";
import { CATALOG, testPattern } from "../../../packages/build/test/fixtures.ts";
import { completeExtraction } from "../../../packages/core/test/fixtures.ts";
import { TEST_POLICY, testStore } from "../../../packages/store/test/helpers.ts";

/**
 * Runs the real workflow on a Temporal test server. The server binary is
 * downloaded on first use, so this suite only runs when TEMPORAL_TESTS=1 (CI).
 */
describe.skipIf(!process.env.TEMPORAL_TESTS)("proposalRun on Temporal", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 180_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("runs intake → receipt → approval → held PDF and survives a lost approval signal", async () => {
    const { store } = await testStore();
    await store.publishPolicy(TEST_POLICY, "henry", "test policy");
    const chat = new FakeChannelAdapter();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)),
      activities: createActivities({
        store,
        adapters: { google_chat: chat },
        extractor: { extract: async () => ({ raw: completeExtraction(), model: "fake" }) },
        interpreter: { interpret: async () => ({ raw: null, model: "fake" }) },
        dtools: recordedDToolsReader(CATALOG),
        patterns: [testPattern()],
        renderPdf: (html) => htmlToPdf(html),
        fetchImage: async () => null,
      }),
    });
    const workflows = new TemporalWorkflows(env.client);

    await worker.runUntil(async () => {
      const zack = (await store.resolvePerson("google_chat", "users/zack"))!;
      const thread = { platform: "google_chat", spaceId: "spaces/A", threadId: "spaces/A/threads/T" };
      const { intake } = await store.captureIntake(
        {
          platform: "google_chat",
          providerMessageId: "m1",
          spaceId: thread.spaceId,
          threadId: thread.threadId,
          requesterProviderId: "users/zack",
          requesterEmail: null,
          text: "Smith security upgrade",
          attachments: [],
          providerTime: null,
          rawBytes: new TextEncoder().encode("{}"),
        },
        zack,
        await store.currentGeneration(thread),
      );
      const started = await store.startRun(intake);
      if (!started.ok) throw new Error(started.reason);
      const runId = started.run.id;
      await workflows.start(runId);
      await workflows.start(runId); // idempotent

      // Wait for the receipt to be published.
      for (let i = 0; i < 100 && !(await store.latestReceipt(runId)); i++) await new Promise((r) => setTimeout(r, 100));
      const receipt = (await store.latestReceipt(runId))!;
      expect(receipt.status).toBe("AWAITING_APPROVAL");

      // Commit the approval in the database but never send the signal.
      const approval = await store.commitApproval({
        receiptId: receipt.id,
        scopeHash: receipt.scope_hash!,
        approverPersonId: "zack",
        thread,
        providerEventId: "click",
        method: "button",
      });
      expect(approval.ok).toBe(true);

      // Time skipping fast-forwards to the hourly reconcile, which finds the approval.
      const result = await env.client.workflow.getHandle(runId).result();
      expect(result).toMatchObject({ state: "READY_HELD", receiptId: receipt.id });
      expect((await store.getRun(runId)).state).toBe("READY_HELD");
      expect(chat.files).toHaveLength(1);
    });
  }, 180_000);
});
