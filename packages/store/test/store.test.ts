import { describe, expect, it } from "vitest";
import { buildReceipt, normalizeExtraction, type ScopeExtraction } from "@sd/core";
import { completeExtraction, emptyExtraction } from "../../core/test/fixtures.ts";
import type { IntakeInput, Store } from "../src/index.ts";
import { testStore } from "./helpers.ts";

const thread = { platform: "google_chat", spaceId: "spaces/A", threadId: "spaces/A/threads/T" };

function intakeInput(id: string, text = "Smith security upgrade", overrides: Partial<IntakeInput> = {}): IntakeInput {
  return {
    platform: "google_chat",
    providerMessageId: id,
    spaceId: thread.spaceId,
    threadId: thread.threadId,
    requesterProviderId: "users/zack",
    requesterEmail: "zack@example.com",
    text,
    attachments: [],
    providerTime: "2026-10-05T12:00:00Z",
    rawBytes: new TextEncoder().encode(JSON.stringify({ id, text })),
    ...overrides,
  };
}

async function startRun(store: Store, msgId = "spaces/A/messages/1") {
  const zack = (await store.resolvePerson("google_chat", "users/zack"))!;
  const gen = await store.currentGeneration(thread);
  const { intake } = await store.captureIntake(intakeInput(msgId), zack, gen);
  const started = await store.startRun(intake);
  if (!started.ok) throw new Error(started.reason);
  return started.run;
}

async function publish(store: Store, runId: string, version: number, extraction: ScopeExtraction = completeExtraction()) {
  const run = await store.getRun(runId);
  const receipt = buildReceipt({
    runId,
    version,
    requesterPersonId: run.person_id,
    route: { platform: run.platform, space_id: run.space_id, thread_id: run.thread_id, session_generation: run.session_generation },
    extraction: normalizeExtraction(extraction).scope,
  });
  await store.publishReceipt(receipt);
  return receipt;
}

const approve = (store: Store, receiptId: string, scopeHash: string, overrides: Record<string, unknown> = {}) =>
  store.commitApproval({
    receiptId,
    scopeHash,
    approverPersonId: "zack",
    thread,
    providerEventId: "click-1",
    method: "button",
    ...overrides,
  });

describe("identity", () => {
  it("resolves only linked, active identities", async () => {
    const { store } = await testStore();
    expect((await store.resolvePerson("google_chat", "users/henry"))?.roles).toContain("admin");
    expect(await store.resolvePerson("google_chat", "users/stranger")).toBeNull();
    expect(await store.isAllowedSpace("google_chat", "spaces/A")).toBe(true);
    expect(await store.isAllowedSpace("google_chat", "spaces/customer")).toBe(false);
  });
});

describe("intake capture and claims", () => {
  it("captures once, stores raw bytes with a hash, and returns the original on replay", async () => {
    const { store, blobs } = await testStore();
    const zack = (await store.resolvePerson("google_chat", "users/zack"))!;
    const first = await store.captureIntake(intakeInput("m1"), zack, 1);
    const replay = await store.captureIntake(intakeInput("m1"), zack, 1);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.intake.id).toBe(first.intake.id);
    expect(blobs.objects.size).toBe(1);
  });

  it("keeps the first capture when a replay carries different content, and records the mismatch", async () => {
    const { store, db } = await testStore();
    const zack = (await store.resolvePerson("google_chat", "users/zack"))!;
    const first = await store.captureIntake(intakeInput("m1"), zack, 1);
    const replay = await store.captureIntake(intakeInput("m1", "different text"), zack, 1);
    expect(replay.intake.id).toBe(first.intake.id);
    expect(replay.intake.text).toBe("Smith security upgrade");
    const mismatches = await db.query(`SELECT 1 FROM events WHERE type = 'intake_replay_mismatch'`);
    expect(mismatches.rows).toHaveLength(1);
  });

  it("makes intake records and the event log immutable", async () => {
    const { store, db } = await testStore();
    await startRun(store);
    await expect(db.query(`UPDATE intake_messages SET text = 'edited'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM events`)).rejects.toThrow(/append-only/);
  });

  it("claims a message for exactly one run and allows one open run per thread", async () => {
    const { store } = await testStore();
    const run = await startRun(store, "m1");
    const zack = (await store.resolvePerson("google_chat", "users/zack"))!;
    const { intake } = await store.captureIntake(intakeInput("m1"), zack, 1);
    expect(await store.startRun(intake)).toEqual({ ok: false, reason: "already_claimed" });
    const second = (await store.captureIntake(intakeInput("m2"), zack, 1)).intake;
    expect(await store.startRun(second)).toEqual({ ok: false, reason: "open_run_exists" });
    expect((await store.findOpenRun(thread))?.id).toBe(run.id);
  });
});

describe("receipts and approval", () => {
  it("approves the latest complete receipt exactly once", async () => {
    const { store } = await testStore();
    const run = await startRun(store);
    const r = await publish(store, run.id, 1);
    const result = await approve(store, r.receipt_id, r.scope_hash!);
    expect(result.ok).toBe(true);
    expect((await store.getRun(run.id)).state).toBe("SCOPE_APPROVED");
    const again = await approve(store, r.receipt_id, r.scope_hash!);
    expect(again).toMatchObject({ ok: true, duplicate: true });
    const types = (await store.listEvents(run.id)).map((e) => e.type);
    expect(types.filter((t) => t === "scope_approved")).toHaveLength(1);
  });

  it("refuses a receipt with blocking questions", async () => {
    const { store } = await testStore();
    const run = await startRun(store);
    const r = await publish(store, run.id, 1, emptyExtraction());
    expect(r.status).toBe("NEEDS_CLARIFICATION");
    expect((await approve(store, r.receipt_id, "sha256:anything")).ok).toBe(false);
  });

  it("refuses a superseded receipt", async () => {
    const { store } = await testStore();
    const run = await startRun(store);
    const v1 = await publish(store, run.id, 1);
    await publish(store, run.id, 2, completeExtraction({ budget: { status: "known", amount_usd: 40000 } }));
    const res = await approve(store, v1.receipt_id, v1.scope_hash!);
    expect(res).toMatchObject({ ok: false, reason: "receipt is not the latest receipt" });
  });

  it("refuses the wrong requester, the wrong thread and a mismatched hash", async () => {
    const { store } = await testStore();
    const run = await startRun(store);
    const r = await publish(store, run.id, 1);
    expect(await approve(store, r.receipt_id, r.scope_hash!, { approverPersonId: "henry" })).toMatchObject({ ok: false, reason: "only the requester can approve this scope" });
    expect(await approve(store, r.receipt_id, r.scope_hash!, { thread: { ...thread, threadId: "spaces/A/threads/OTHER" } })).toMatchObject({ ok: false });
    expect(await approve(store, r.receipt_id, "sha256:forged")).toMatchObject({ ok: false, reason: "scope hash does not match the receipt" });
    expect((await store.getRun(run.id)).state).toBe("AWAITING_SCOPE_APPROVAL");
    const rejected = (await store.listEvents(run.id)).filter((e) => e.type === "approval_rejected");
    expect(rejected).toHaveLength(3);
  });

  it("stales pending receipts on session reset and refuses later approval", async () => {
    const { store } = await testStore();
    const run = await startRun(store);
    const r = await publish(store, run.id, 1);
    const reset = await store.resetSession(thread, "henry");
    expect(reset.staleRunIds).toEqual([run.id]);
    expect((await approve(store, r.receipt_id, r.scope_hash!)).ok).toBe(false);
    await expect(publish(store, run.id, 2)).rejects.toThrow(/STALE/);
  });

  it("refuses to republish a receipt id with different content", async () => {
    const { store } = await testStore();
    const run = await startRun(store);
    await publish(store, run.id, 1);
    await expect(publish(store, run.id, 1, completeExtraction({ client: "Someone Else" }))).rejects.toThrow(/different content/);
    await expect(publish(store, run.id, 1)).resolves.toBeDefined();
  });
});
