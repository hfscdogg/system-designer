import { describe, expect, it } from "vitest";
import { buildReceipt, normalizeExtraction } from "@sd/core";
import { completeExtraction } from "../../core/test/fixtures.ts";
import { IntegrityError } from "../src/index.ts";
import { TEST_POLICY, testStore } from "./helpers.ts";

const thread = { platform: "google_chat", spaceId: "spaces/A", threadId: "spaces/A/threads/T" };

async function approvedRun() {
  const t = await testStore();
  const zack = (await t.store.resolvePerson("google_chat", "users/zack"))!;
  const { intake } = await t.store.captureIntake(
    { platform: "google_chat", providerMessageId: "m1", spaceId: thread.spaceId, threadId: thread.threadId, requesterProviderId: "users/zack",
      requesterEmail: null, text: "x", attachments: [], providerTime: null, rawBytes: new TextEncoder().encode("{}") },
    zack,
    1,
  );
  const started = await t.store.startRun(intake);
  if (!started.ok) throw new Error(started.reason);
  const run = started.run;
  const receipt = buildReceipt({ runId: run.id, version: 1, requesterPersonId: "zack",
    route: { platform: run.platform, space_id: run.space_id, thread_id: run.thread_id, session_generation: 1 },
    extraction: normalizeExtraction(completeExtraction()).scope });
  await t.store.publishReceipt(receipt);
  const approval = await t.store.commitApproval({ receiptId: receipt.receipt_id, scopeHash: receipt.scope_hash!, approverPersonId: "zack", thread, providerEventId: "c", method: "button" });
  if (!approval.ok) throw new Error(approval.reason);
  return { ...t, run, approvalId: approval.approvalId, scopeHash: receipt.scope_hash! };
}

describe("build bookkeeping", () => {
  it("allows exactly one build per approved scope (retries are idempotent)", async () => {
    const t = await approvedRun();
    expect(await t.store.acquireBuild(t.run.id, t.approvalId, t.scopeHash)).toEqual({ ok: true });
    expect(await t.store.acquireBuild(t.run.id, t.approvalId, t.scopeHash)).toEqual({ ok: true });
    expect(await t.store.acquireBuild(t.run.id, t.approvalId, "sha256:other")).toMatchObject({ ok: false });
    expect(await t.store.acquireBuild(t.run.id, "ap_forged", t.scopeHash)).toMatchObject({ ok: false });
  });

  it("publishes artifacts once and refuses different content under the same name", async () => {
    const t = await approvedRun();
    await t.store.publishArtifact(t.run.id, "compile", "draft", { a: 1 });
    await t.store.publishArtifact(t.run.id, "compile", "draft", { a: 1 });
    await expect(t.store.publishArtifact(t.run.id, "compile", "draft", { a: 2 })).rejects.toBeInstanceOf(IntegrityError);
    expect(await t.store.readArtifact(t.run.id, "compile", "draft")).toEqual({ a: 1 });
  });

  it("detects a stored artifact that was altered", async () => {
    const t = await approvedRun();
    const { key } = await t.store.publishArtifact(t.run.id, "bind", "proposal", { total: 1 });
    t.blobs.objects.set(key, new TextEncoder().encode('{"total":2}'));
    await expect(t.store.readArtifact(t.run.id, "bind", "proposal")).rejects.toThrow(/recorded hash/);
  });

  it("records catalog reads per run and flags a record that changed mid-run", async () => {
    const t = await approvedRun();
    const body = new TextEncoder().encode('{"id":"x"}');
    const read = { recordId: "x", endpoint: "Products/GetProduct", body, sha256: "will-be-recomputed", fetchedAt: "2026-10-05T12:00:00Z" };
    const { sha256Hex } = await import("@sd/core");
    await t.store.recordCatalogRead(t.run.id, { ...read, sha256: sha256Hex(body) }, { admitted: true, reason: null });
    await t.store.recordCatalogRead(t.run.id, { ...read, sha256: sha256Hex(body) }, { admitted: true, reason: null });
    const changed = new TextEncoder().encode('{"id":"x","unitPrice":1}');
    await expect(t.store.recordCatalogRead(t.run.id, { ...read, body: changed, sha256: sha256Hex(changed) }, { admitted: true, reason: null })).rejects.toThrow(/changed during the run/);
  });

  it("lets only an active admin publish a commercial policy, append-only", async () => {
    const t = await approvedRun();
    await expect(t.store.publishPolicy(TEST_POLICY, "zack", "try")).rejects.toThrow(/only an active admin/);
    const v = await t.store.publishPolicy(TEST_POLICY, "henry", "pilot defaults");
    expect((await t.store.latestPolicy())?.version).toBe(v);
    await expect(t.db.query(`UPDATE commercial_policies SET policy = '{}'`)).rejects.toThrow(/append-only/);
  });
});
