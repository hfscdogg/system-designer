import { randomUUID } from "node:crypto";
import {
  assertTransition,
  canonicalJson,
  OPEN_INTAKE_STATES,
  sha256Hex,
  type Receipt,
  type RunState,
  type ThreadRef,
} from "@sd/core";
import type { BlobStore } from "./blobs.ts";
import type { Db } from "./db.ts";

export interface MarginException {
  id: string;
  run_id: string;
  proposal_sha256: string;
  market: string;
  gross_margin_pct: number;
  minimum_pct: number;
  decision: "approved" | "declined" | null;
  decided_by: string | null;
  decided_by_name: string | null;
}

export function marginExceptionIdFor(runId: string): string {
  return `MX-${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase()}`;
}

export interface Person {
  id: string;
  display_name: string;
  roles: string[];
  active: boolean;
}

export interface AttachmentMeta {
  name: string;
  contentType: string | null;
  providerRef: string | null;
  /** Attachments are recorded but not admitted as scope evidence until downloaded and hashed. */
  admitted: false;
}

export interface IntakeInput {
  platform: string;
  providerMessageId: string;
  spaceId: string;
  threadId: string;
  requesterProviderId: string;
  requesterEmail: string | null;
  text: string;
  attachments: AttachmentMeta[];
  providerTime: string | null;
  /** The provider payload exactly as received. */
  rawBytes: Uint8Array;
}

export interface IntakeRecord {
  id: string;
  platform: string;
  provider_message_id: string;
  space_id: string;
  thread_id: string;
  person_id: string;
  session_generation: number;
  text: string;
  text_sha256: string;
  raw_sha256: string;
  attachments: AttachmentMeta[];
}

export interface RunRecord {
  id: string;
  platform: string;
  space_id: string;
  thread_id: string;
  person_id: string;
  session_generation: number;
  intake_id: string;
  state: RunState;
  release_id: string;
  status_message_id: string | null;
}

export interface ReceiptRecord {
  id: string;
  run_id: string;
  version: number;
  status: Receipt["status"];
  body: Receipt;
  scope_hash: string | null;
  session_generation: number;
  message_id: string | null;
  superseded_at: string | null;
}

export type ApprovalResult =
  | { ok: true; approvalId: string; runId: string; duplicate: boolean }
  | { ok: false; reason: string; runId: string | null };

export interface ApprovalInput {
  receiptId: string;
  scopeHash: string;
  approverPersonId: string;
  thread: ThreadRef;
  providerEventId: string;
  method: "button" | "text";
}

const BUILD_STATES: RunState[] = [
  "SCOPE_APPROVED",
  "PREBUILD_VERIFIED",
  "CATALOG_EVIDENCE_ADMITTED",
  "SELECTION_READY",
  "COMPILED",
  "BOUND",
  "AWAITING_MARGIN_APPROVAL",
  "VALIDATED",
  "RENDERED",
  "PREFLIGHT_PASSED",
  "RECONCILIATION_REQUIRED",
];

/** Tampering or a bug, never a transient failure. Workflows do not retry these. */
export class IntegrityError extends Error {
  override name = "IntegrityError";
}

export const threadOf = (r: { platform: string; space_id: string; thread_id: string }): ThreadRef => ({
  platform: r.platform,
  spaceId: r.space_id,
  threadId: r.thread_id,
});

export class Store {
  private readonly db: Db;
  private readonly blobs: BlobStore;
  readonly releaseId: string;

  constructor(db: Db, blobs: BlobStore, releaseId: string) {
    this.db = db;
    this.blobs = blobs;
    this.releaseId = releaseId;
  }

  // ---------- identity & routing ----------

  async resolvePerson(platform: string, providerUserId: string): Promise<Person | null> {
    const res = await this.db.query<Person>(
      `SELECT p.id, p.display_name, p.roles, p.active FROM channel_identities ci
       JOIN persons p ON p.id = ci.person_id
       WHERE ci.platform = $1 AND ci.provider_user_id = $2 AND p.active`,
      [platform, providerUserId],
    );
    return res.rows[0] ?? null;
  }

  /** The email the run's request came from, as Google Chat reported it. */
  async requesterEmail(runId: string): Promise<string | null> {
    const res = await this.db.query<{ requester_email: string | null }>(
      `SELECT i.requester_email FROM runs r JOIN intake_messages i ON i.id = r.intake_id WHERE r.id = $1`,
      [runId],
    );
    return res.rows[0]?.requester_email ?? null;
  }

  async resolvePersonById(personId: string): Promise<Person | null> {
    const res = await this.db.query<Person>(`SELECT id, display_name, roles, active FROM persons WHERE id = $1`, [personId]);
    return res.rows[0] ?? null;
  }

  async isAllowedSpace(platform: string, spaceId: string): Promise<boolean> {
    const res = await this.db.query(`SELECT 1 FROM allowed_spaces WHERE platform = $1 AND space_id = $2`, [platform, spaceId]);
    return res.rows.length > 0;
  }

  async currentGeneration(t: ThreadRef, db: Db = this.db): Promise<number> {
    const res = await db.query<{ generation: number }>(
      `INSERT INTO session_generations (platform, space_id, thread_id) VALUES ($1, $2, $3)
       ON CONFLICT (platform, space_id, thread_id) DO UPDATE SET generation = session_generations.generation
       RETURNING generation`,
      [t.platform, t.spaceId, t.threadId],
    );
    return res.rows[0]!.generation;
  }

  /** Session reset (PRD §15.2): bump the generation, stale open runs and their receipts. */
  async resetSession(t: ThreadRef, actor: string): Promise<{ generation: number; staleRunIds: string[] }> {
    return this.db.transaction(async (tx) => {
      const generation = (await this.currentGeneration(t, tx)) + 1;
      await tx.query(
        `UPDATE session_generations SET generation = $4 WHERE platform = $1 AND space_id = $2 AND thread_id = $3`,
        [t.platform, t.spaceId, t.threadId, generation],
      );
      const stale = await tx.query<{ id: string }>(
        `UPDATE runs SET state = 'STALE', updated_at = now()
         WHERE platform = $1 AND space_id = $2 AND thread_id = $3 AND state = ANY($4)
         RETURNING id`,
        [t.platform, t.spaceId, t.threadId, OPEN_INTAKE_STATES],
      );
      const staleRunIds = stale.rows.map((r) => r.id);
      if (staleRunIds.length) {
        await tx.query(`UPDATE receipts SET superseded_at = now() WHERE run_id = ANY($1) AND superseded_at IS NULL`, [staleRunIds]);
      }
      await this.event(tx, null, "session_reset", actor, { thread: t, generation, staleRunIds });
      return { generation, staleRunIds };
    });
  }

  // ---------- intake evidence ----------

  /**
   * Persist the original message before any interpretation (PRD §7.2). Replays
   * of the same provider message return the first record unchanged.
   */
  async captureIntake(input: IntakeInput, person: Person, generation: number): Promise<{ intake: IntakeRecord; created: boolean }> {
    const id = `in_${randomUUID()}`;
    const safeMessageId = input.providerMessageId.replace(/[^A-Za-z0-9._-]/g, "_");
    // Keyed by content hash: a provider redelivery with different envelope bytes is kept
    // as its own evidence object, while the first capture stays the authoritative record.
    const blob = await this.blobs.putImmutable(
      `intake/${input.platform}/${safeMessageId}/${sha256Hex(input.rawBytes)}.json`,
      input.rawBytes,
      "application/json",
    );
    const inserted = await this.db.query<IntakeRecord>(
      `INSERT INTO intake_messages (id, platform, provider_message_id, space_id, thread_id, requester_provider_id,
         requester_email, person_id, session_generation, text, attachments, provider_time, raw_blob_key, raw_sha256,
         text_sha256, release_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (platform, provider_message_id) DO NOTHING
       RETURNING *`,
      [
        id,
        input.platform,
        input.providerMessageId,
        input.spaceId,
        input.threadId,
        input.requesterProviderId,
        input.requesterEmail,
        person.id,
        generation,
        input.text,
        JSON.stringify(input.attachments),
        input.providerTime,
        blob.key,
        blob.sha256,
        sha256Hex(input.text),
        this.releaseId,
      ],
    );
    if (inserted.rows[0]) {
      await this.event(this.db, null, "intake_captured", person.id, { intakeId: id, rawSha256: blob.sha256 });
      return { intake: inserted.rows[0], created: true };
    }
    const existing = (await this.db.query<IntakeRecord>(
      `SELECT * FROM intake_messages WHERE platform = $1 AND provider_message_id = $2`,
      [input.platform, input.providerMessageId],
    )).rows[0]!;
    if (existing.text_sha256 !== sha256Hex(input.text) || existing.person_id !== person.id) {
      await this.event(this.db, null, "intake_replay_mismatch", person.id, {
        intakeId: existing.id,
        providerMessageId: input.providerMessageId,
        replayRawSha256: blob.sha256,
      });
    }
    return { intake: existing, created: false };
  }

  async getIntake(id: string): Promise<IntakeRecord> {
    const res = await this.db.query<IntakeRecord>(`SELECT * FROM intake_messages WHERE id = $1`, [id]);
    if (!res.rows[0]) throw new Error(`intake ${id} not found`);
    const row = res.rows[0];
    if (sha256Hex(row.text) !== row.text_sha256) throw new Error(`intake ${id} text does not match its recorded hash`);
    return row;
  }

  /** Claim a provider message for one purpose (PRD §7.3). False if already claimed. */
  async claimMessage(platform: string, providerMessageId: string, purpose: string, runId: string | null, db: Db = this.db): Promise<boolean> {
    const res = await db.query(
      `INSERT INTO message_claims (platform, provider_message_id, run_id, purpose) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING 1`,
      [platform, providerMessageId, runId, purpose],
    );
    return res.rows.length > 0;
  }

  // ---------- runs ----------

  /**
   * Create a run for a captured intake and claim its message atomically.
   * Fails if the message was already claimed or the thread already has an open run.
   */
  async startRun(intake: IntakeRecord): Promise<{ ok: true; run: RunRecord } | { ok: false; reason: "already_claimed" | "open_run_exists" }> {
    const runId = `run_${randomUUID().replace(/-/g, "")}`;
    try {
      return await this.db.transaction(async (tx) => {
        const existing = await tx.query(`SELECT 1 FROM message_claims WHERE platform = $1 AND provider_message_id = $2`, [
          intake.platform,
          intake.provider_message_id,
        ]);
        if (existing.rows.length) return { ok: false as const, reason: "already_claimed" as const };
        const run = await tx.query<RunRecord>(
          `INSERT INTO runs (id, platform, space_id, thread_id, person_id, session_generation, intake_id, state, release_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'AUTHENTICATED_AND_CAPTURED',$8) RETURNING *`,
          [runId, intake.platform, intake.space_id, intake.thread_id, intake.person_id, intake.session_generation, intake.id, this.releaseId],
        );
        await this.claimMessage(intake.platform, intake.provider_message_id, "intake", runId, tx);
        await this.event(tx, runId, "run_started", intake.person_id, { intakeId: intake.id, textSha256: intake.text_sha256 });
        return { ok: true as const, run: run.rows[0]! };
      });
    } catch (err) {
      if (String((err as Error).message).includes("runs_one_open_per_thread")) return { ok: false, reason: "open_run_exists" };
      throw err;
    }
  }

  async getRun(id: string, db: Db = this.db): Promise<RunRecord> {
    const res = await db.query<RunRecord>(`SELECT * FROM runs WHERE id = $1`, [id]);
    if (!res.rows[0]) throw new Error(`run ${id} not found`);
    return res.rows[0];
  }

  async findOpenRun(t: ThreadRef): Promise<RunRecord | null> {
    const res = await this.db.query<RunRecord>(
      `SELECT * FROM runs WHERE platform = $1 AND space_id = $2 AND thread_id = $3 AND state = ANY($4)`,
      [t.platform, t.spaceId, t.threadId, OPEN_INTAKE_STATES],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Runs that should have a live workflow: still collecting scope or building,
   * not stopped for a human (BLOCKED / RECONCILIATION_REQUIRED) and not finished.
   */
  async listRunsAwaitingWorkflow(minAgeSeconds: number): Promise<RunRecord[]> {
    const res = await this.db.query<RunRecord>(
      `SELECT * FROM runs WHERE state = ANY($1) AND updated_at < now() - make_interval(secs => $2) ORDER BY created_at`,
      [[...OPEN_INTAKE_STATES, ...BUILD_STATES.filter((s) => s !== "RECONCILIATION_REQUIRED")], minAgeSeconds],
    );
    return res.rows;
  }

  /** A run in this thread that is past approval and still building. */
  async findBuildingRun(t: ThreadRef): Promise<RunRecord | null> {
    const res = await this.db.query<RunRecord>(
      `SELECT * FROM runs WHERE platform = $1 AND space_id = $2 AND thread_id = $3 AND state = ANY($4)
       ORDER BY created_at DESC LIMIT 1`,
      [t.platform, t.spaceId, t.threadId, BUILD_STATES],
    );
    return res.rows[0] ?? null;
  }

  async listRunsForPerson(personId: string, limit = 10): Promise<RunRecord[]> {
    const res = await this.db.query<RunRecord>(`SELECT * FROM runs WHERE person_id = $1 ORDER BY created_at DESC LIMIT $2`, [personId, limit]);
    return res.rows;
  }

  async transitionRun(runId: string, to: RunState, actor: string, data: Record<string, unknown> = {}, db?: Db): Promise<RunRecord> {
    const work = async (tx: Db) => {
      const run = await tx.query<RunRecord>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [runId]);
      const current = run.rows[0];
      if (!current) throw new Error(`run ${runId} not found`);
      if (current.state === to && to !== "NEEDS_CLARIFICATION" && to !== "AWAITING_SCOPE_APPROVAL") return current; // idempotent retry
      assertTransition(current.state, to);
      const updated = await tx.query<RunRecord>(
        `UPDATE runs SET state = $2, updated_at = now(), last_error = $3 WHERE id = $1 RETURNING *`,
        [runId, to, typeof data.error === "string" ? data.error : null],
      );
      await this.event(tx, runId, "state_changed", actor, { from: current.state, to, ...data });
      return updated.rows[0]!;
    };
    return db ? work(db) : this.db.transaction(work);
  }

  async setStatusMessage(runId: string, messageId: string): Promise<void> {
    await this.db.query(`UPDATE runs SET status_message_id = $2 WHERE id = $1 AND status_message_id IS NULL`, [runId, messageId]);
  }

  // ---------- receipts & approvals ----------

  /** Publish a new receipt version and supersede the previous one, atomically. */
  async publishReceipt(receipt: Receipt): Promise<ReceiptRecord> {
    const bodySha = sha256Hex(canonicalJson(receipt));
    return this.db.transaction(async (tx) => {
      const run = (await tx.query<RunRecord>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [receipt.run_id])).rows[0];
      if (!run) throw new Error(`run ${receipt.run_id} not found`);
      const existing = (await tx.query<ReceiptRecord & { body_sha256: string }>(`SELECT * FROM receipts WHERE id = $1`, [receipt.receipt_id])).rows[0];
      if (existing) {
        if (existing.body_sha256 !== bodySha) throw new Error(`receipt ${receipt.receipt_id} already published with different content`);
        return existing; // idempotent retry
      }
      if (!OPEN_INTAKE_STATES.includes(run.state)) throw new Error(`run ${run.id} is ${run.state}; cannot publish a receipt`);
      if (run.session_generation !== receipt.route.session_generation) throw new Error(`receipt session generation is stale`);
      const generation = await this.currentGeneration(threadOf(run), tx);
      if (generation !== run.session_generation) throw new Error(`thread session was reset; run ${run.id} is stale`);

      await tx.query(`UPDATE receipts SET superseded_at = now() WHERE run_id = $1 AND superseded_at IS NULL`, [run.id]);
      const inserted = await tx.query<ReceiptRecord>(
        `INSERT INTO receipts (id, run_id, version, status, body, body_sha256, scope_hash, session_generation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [receipt.receipt_id, run.id, receipt.version, receipt.status, JSON.stringify(receipt), bodySha, receipt.scope_hash, run.session_generation],
      );
      const to: RunState = receipt.status === "AWAITING_APPROVAL" ? "AWAITING_SCOPE_APPROVAL" : "NEEDS_CLARIFICATION";
      await this.transitionRun(run.id, to, "system", { receiptId: receipt.receipt_id }, tx);
      await this.event(tx, run.id, "receipt_published", "system", {
        receiptId: receipt.receipt_id,
        version: receipt.version,
        status: receipt.status,
        scopeHash: receipt.scope_hash,
        bodySha256: bodySha,
      });
      return inserted.rows[0]!;
    });
  }

  async setReceiptMessage(receiptId: string, messageId: string): Promise<void> {
    await this.db.query(`UPDATE receipts SET message_id = $2 WHERE id = $1 AND message_id IS NULL`, [receiptId, messageId]);
  }

  async latestReceipt(runId: string, db: Db = this.db): Promise<ReceiptRecord | null> {
    const res = await db.query<ReceiptRecord>(
      `SELECT * FROM receipts WHERE run_id = $1 ORDER BY version DESC LIMIT 1`,
      [runId],
    );
    return res.rows[0] ?? null;
  }

  async getReceipt(receiptId: string): Promise<ReceiptRecord | null> {
    const res = await this.db.query<ReceiptRecord>(`SELECT * FROM receipts WHERE id = $1`, [receiptId]);
    return res.rows[0] ?? null;
  }

  /**
   * Approve a receipt (PRD §9.4). Selection, validation and commit happen in one
   * transaction under a row lock on the run, so a revised receipt cannot replace
   * the approved one mid-operation.
   */
  async commitApproval(input: ApprovalInput): Promise<ApprovalResult> {
    const result = await this.db.transaction(async (tx): Promise<ApprovalResult> => {
      const target = (await tx.query<{ run_id: string }>(`SELECT run_id FROM receipts WHERE id = $1`, [input.receiptId])).rows[0];
      if (!target) return { ok: false, reason: "unknown receipt", runId: null };
      const run = (await tx.query<RunRecord>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [target.run_id])).rows[0]!;
      const fail = (reason: string): ApprovalResult => ({ ok: false, reason, runId: run.id });

      const prior = (await tx.query<{ id: string; receipt_id: string; approver_person_id: string }>(
        `SELECT id, receipt_id, approver_person_id FROM approvals WHERE run_id = $1`,
        [run.id],
      )).rows[0];
      if (prior) {
        return prior.receipt_id === input.receiptId && prior.approver_person_id === input.approverPersonId
          ? { ok: true, approvalId: prior.id, runId: run.id, duplicate: true }
          : fail("run already approved");
      }
      if (input.approverPersonId !== run.person_id) return fail("only the requester can approve this scope");
      if (input.thread.platform !== run.platform || input.thread.spaceId !== run.space_id || input.thread.threadId !== run.thread_id) {
        return fail("approval must come from the run's own thread");
      }
      if (run.state !== "AWAITING_SCOPE_APPROVAL") return fail(`run is ${run.state}`);
      const latest = await this.latestReceipt(run.id, tx);
      if (!latest || latest.id !== input.receiptId || latest.superseded_at) return fail("receipt is not the latest receipt");
      if (latest.status !== "AWAITING_APPROVAL") return fail("receipt has blocking questions");
      if (latest.scope_hash !== input.scopeHash) return fail("scope hash does not match the receipt");
      const generation = await this.currentGeneration(threadOf(run), tx);
      if (generation !== run.session_generation || generation !== latest.session_generation) return fail("session was reset; receipt is stale");

      const approvalId = `ap_${randomUUID()}`;
      await tx.query(
        `INSERT INTO approvals (id, run_id, receipt_id, scope_hash, approver_person_id, platform, space_id, thread_id,
           session_generation, provider_event_id, method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [approvalId, run.id, latest.id, latest.scope_hash, input.approverPersonId, run.platform, run.space_id, run.thread_id,
          generation, input.providerEventId, input.method],
      );
      await this.transitionRun(run.id, "SCOPE_APPROVED", input.approverPersonId, { approvalId, receiptId: latest.id }, tx);
      await this.event(tx, run.id, "scope_approved", input.approverPersonId, {
        approvalId,
        receiptId: latest.id,
        scopeHash: latest.scope_hash,
        method: input.method,
      });
      return { ok: true, approvalId, runId: run.id, duplicate: false };
    });
    if (!result.ok) {
      await this.event(this.db, result.runId, "approval_rejected", input.approverPersonId, {
        receiptId: input.receiptId,
        reason: result.reason,
        method: input.method,
      });
    }
    return result;
  }

  async getApprovalForRun(runId: string): Promise<{ id: string; run_id: string; receipt_id: string; scope_hash: string } | null> {
    const res = await this.db.query<{ id: string; run_id: string; receipt_id: string; scope_hash: string }>(
      `SELECT id, run_id, receipt_id, scope_hash FROM approvals WHERE run_id = $1`,
      [runId],
    );
    return res.rows[0] ?? null;
  }

  async getApproval(approvalId: string): Promise<{ id: string; run_id: string; receipt_id: string; scope_hash: string } | null> {
    const res = await this.db.query<{ id: string; run_id: string; receipt_id: string; scope_hash: string }>(
      `SELECT id, run_id, receipt_id, scope_hash FROM approvals WHERE id = $1`,
      [approvalId],
    );
    return res.rows[0] ?? null;
  }

  // ---------- build pipeline ----------

  /**
   * Acquire the single build for an approved run. Re-acquiring for the same
   * approval is idempotent (an activity retry); anything else is refused.
   */
  async acquireBuild(runId: string, approvalId: string, scopeHash: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.db.transaction(async (tx) => {
      const approval = (await tx.query<{ run_id: string; scope_hash: string }>(`SELECT run_id, scope_hash FROM approvals WHERE id = $1`, [approvalId])).rows[0];
      if (!approval || approval.run_id !== runId || approval.scope_hash !== scopeHash) return { ok: false as const, reason: "approval does not match this run and scope" };
      const inserted = await tx.query(
        `INSERT INTO builds (run_id, approval_id, scope_hash, release_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING 1`,
        [runId, approvalId, scopeHash, this.releaseId],
      );
      if (inserted.rows.length) {
        await this.event(tx, runId, "build_acquired", "system", { approvalId, scopeHash });
        return { ok: true as const };
      }
      const existing = (await tx.query<{ approval_id: string; scope_hash: string }>(`SELECT approval_id, scope_hash FROM builds WHERE run_id = $1`, [runId])).rows[0];
      return existing?.approval_id === approvalId && existing.scope_hash === scopeHash
        ? { ok: true as const }
        : { ok: false as const, reason: "a different build already exists for this run" };
    });
  }

  /** Store a raw D-Tools read for this run and record whether it was admitted. */
  async recordCatalogRead(
    runId: string,
    read: { recordId: string; endpoint: string; body: Uint8Array; sha256: string; fetchedAt: string },
    admission: { admitted: boolean; reason: string | null },
  ): Promise<string> {
    const blob = await this.blobs.putImmutable(`runs/${runId}/catalog/${read.recordId}-${read.sha256}.json`, read.body, "application/json");
    if (blob.sha256 !== read.sha256) throw new Error(`catalog read for ${read.recordId} changed while storing`);
    const inserted = await this.db.query(
      `INSERT INTO catalog_evidence (run_id, record_id, endpoint, sha256, blob_key, fetched_at, admitted, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING 1`,
      [runId, read.recordId, read.endpoint, read.sha256, blob.key, read.fetchedAt, admission.admitted, admission.reason],
    );
    if (!inserted.rows.length) {
      const existing = (await this.db.query<{ sha256: string }>(`SELECT sha256 FROM catalog_evidence WHERE run_id = $1 AND record_id = $2`, [runId, read.recordId])).rows[0]!;
      // A retried activity may re-read; a changed record mid-run is reconciliation work, not a silent update.
      if (existing.sha256 !== read.sha256) throw new IntegrityError(`D-Tools record ${read.recordId} changed during the run`);
    }
    return blob.key;
  }

  /** Publish a JSON stage artifact once (canonical encoding, so retries hash identically). */
  async publishArtifact(runId: string, stage: string, name: string, content: unknown): Promise<{ key: string; sha256: string }> {
    return this.publishBinaryArtifact(runId, stage, name, new TextEncoder().encode(canonicalJson(content)), "application/json");
  }

  /**
   * Publish a stage artifact once. Republishing identical bytes is a no-op;
   * different bytes under the same name are refused (PRD §16.2).
   */
  async publishBinaryArtifact(runId: string, stage: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; sha256: string }> {
    const ext = contentType === "application/pdf" ? "pdf" : contentType === "text/html" ? "html" : "json";
    const blob = await this.blobs.putImmutable(`runs/${runId}/${stage}/${name}-${sha256Hex(bytes)}.${ext}`, bytes, contentType);
    const inserted = await this.db.query(
      `INSERT INTO artifacts (run_id, stage, name, blob_key, sha256) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
      [runId, stage, name, blob.key, blob.sha256],
    );
    if (!inserted.rows.length) {
      const existing = (await this.db.query<{ sha256: string }>(`SELECT sha256 FROM artifacts WHERE run_id = $1 AND stage = $2 AND name = $3`, [runId, stage, name])).rows[0]!;
      if (existing.sha256 !== blob.sha256) throw new IntegrityError(`artifact ${stage}/${name} for ${runId} was already published with different content`);
    } else {
      await this.event(this.db, runId, "artifact_published", "system", { stage, name, sha256: blob.sha256 });
    }
    return blob;
  }

  async readBinaryArtifact(runId: string, stage: string, name: string): Promise<{ bytes: Uint8Array; sha256: string } | null> {
    const row = (await this.db.query<{ blob_key: string; sha256: string }>(
      `SELECT blob_key, sha256 FROM artifacts WHERE run_id = $1 AND stage = $2 AND name = $3`,
      [runId, stage, name],
    )).rows[0];
    if (!row) return null;
    const bytes = await this.blobs.get(row.blob_key);
    if (sha256Hex(bytes) !== row.sha256) throw new IntegrityError(`artifact ${stage}/${name} for ${runId} does not match its recorded hash`);
    return { bytes, sha256: row.sha256 };
  }

  async readArtifact<T>(runId: string, stage: string, name: string): Promise<T | null> {
    const found = await this.readBinaryArtifact(runId, stage, name);
    return found ? (JSON.parse(new TextDecoder().decode(found.bytes)) as T) : null;
  }

  async listArtifacts(runId: string): Promise<Array<{ stage: string; name: string; sha256: string; blob_key: string }>> {
    const res = await this.db.query<{ stage: string; name: string; sha256: string; blob_key: string }>(
      `SELECT stage, name, sha256, blob_key FROM artifacts WHERE run_id = $1 ORDER BY stage, name`,
      [runId],
    );
    return res.rows;
  }

  async catalogEvidence(runId: string): Promise<Array<{ record_id: string; sha256: string; admitted: boolean }>> {
    const res = await this.db.query<{ record_id: string; sha256: string; admitted: boolean }>(
      `SELECT record_id, sha256, admitted FROM catalog_evidence WHERE run_id = $1 ORDER BY record_id`,
      [runId],
    );
    return res.rows;
  }

  /** Record the single held hand-off. A retry with the same PDF and message is a no-op. */
  async recordHandoff(h: { runId: string; pdfSha256: string; thread: ThreadRef; providerMessageId: string; attachmentRef: string }): Promise<void> {
    const inserted = await this.db.query(
      `INSERT INTO held_handoffs (run_id, pdf_sha256, platform, space_id, thread_id, provider_message_id, attachment_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING 1`,
      [h.runId, h.pdfSha256, h.thread.platform, h.thread.spaceId, h.thread.threadId, h.providerMessageId, h.attachmentRef],
    );
    if (inserted.rows.length) {
      await this.event(this.db, h.runId, "held_handoff", "system", { pdfSha256: h.pdfSha256, providerMessageId: h.providerMessageId });
      return;
    }
    const existing = (await this.db.query<{ pdf_sha256: string; provider_message_id: string }>(`SELECT pdf_sha256, provider_message_id FROM held_handoffs WHERE run_id = $1`, [h.runId])).rows[0]!;
    if (existing.pdf_sha256 !== h.pdfSha256 || existing.provider_message_id !== h.providerMessageId) {
      throw new IntegrityError(`run ${h.runId} already has a different held hand-off`);
    }
  }

  async getHandoff(runId: string): Promise<{ pdf_sha256: string; provider_message_id: string } | null> {
    const res = await this.db.query<{ pdf_sha256: string; provider_message_id: string }>(`SELECT pdf_sha256, provider_message_id FROM held_handoffs WHERE run_id = $1`, [runId]);
    return res.rows[0] ?? null;
  }

  async latestPolicy(): Promise<{ version: number; policy: unknown } | null> {
    const res = await this.db.query<{ version: number; policy: unknown }>(`SELECT version, policy FROM commercial_policies ORDER BY version DESC LIMIT 1`);
    return res.rows[0] ?? null;
  }

  async publishPolicy(policy: unknown, setBy: string, reason: string): Promise<number> {
    const res = await this.db.query<{ version: number }>(
      `INSERT INTO commercial_policies (policy, set_by, reason) VALUES ($1, $2, $3) RETURNING version`,
      [JSON.stringify(policy), setBy, reason],
    );
    await this.event(this.db, null, "commercial_policy_published", setBy, { version: res.rows[0]!.version, reason });
    return res.rows[0]!.version;
  }

  // ---------- direct conversations ----------

  /** Remember a person's 1:1 conversation with the app, so admins can be reached for decisions. */
  async rememberDirectSpace(platform: string, providerUserId: string, spaceId: string): Promise<void> {
    await this.db.query(
      `UPDATE channel_identities SET dm_space_id = $3 WHERE platform = $1 AND provider_user_id = $2 AND dm_space_id IS DISTINCT FROM $3`,
      [platform, providerUserId, spaceId],
    );
  }

  /** Active admins the app can reach directly on a platform. */
  async adminDirectSpaces(platform: string): Promise<Array<{ person_id: string; display_name: string; dm_space_id: string }>> {
    const res = await this.db.query<{ person_id: string; display_name: string; dm_space_id: string }>(
      `SELECT p.id AS person_id, p.display_name, ci.dm_space_id FROM channel_identities ci
       JOIN persons p ON p.id = ci.person_id
       WHERE ci.platform = $1 AND ci.dm_space_id IS NOT NULL AND p.active AND 'admin' = ANY(p.roles)
       ORDER BY p.id`,
      [platform],
    );
    return res.rows;
  }

  // ---------- margin exceptions ----------

  /** Record that a run's bound proposal is below its margin floor. Idempotent per run. */
  async requestMarginException(input: { runId: string; proposalSha256: string; market: string; grossMarginPct: number; minimumPct: number }): Promise<MarginException> {
    const id = marginExceptionIdFor(input.runId);
    await this.db.query(
      `INSERT INTO margin_exceptions (id, run_id, proposal_sha256, market, gross_margin_pct, minimum_pct)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id) DO NOTHING`,
      [id, input.runId, input.proposalSha256, input.market, input.grossMarginPct, input.minimumPct],
    );
    const ex = (await this.getMarginException(input.runId))!;
    if (ex.proposal_sha256 !== input.proposalSha256) throw new IntegrityError(`margin exception for ${input.runId} is for a different proposal`);
    await this.event(this.db, input.runId, "margin_exception_requested", "system", { exceptionId: ex.id, grossMarginPct: input.grossMarginPct, minimumPct: input.minimumPct, market: input.market });
    return ex;
  }

  async getMarginException(runId: string): Promise<MarginException | null> {
    const res = await this.db.query<MarginException>(
      `SELECT e.id, e.run_id, e.proposal_sha256, e.market, e.gross_margin_pct::float8 AS gross_margin_pct, e.minimum_pct::float8 AS minimum_pct,
              d.decision, d.decided_by, p.display_name AS decided_by_name
       FROM margin_exceptions e
       LEFT JOIN margin_exception_decisions d ON d.exception_id = e.id
       LEFT JOIN persons p ON p.id = d.decided_by
       WHERE e.run_id = $1`,
      [runId],
    );
    return res.rows[0] ?? null;
  }

  /** An admin's decision, made once and atomically. The database also refuses non-admins. */
  async decideMarginException(input: {
    exceptionId: string;
    deciderPersonId: string;
    decision: "approved" | "declined";
    providerEventId: string;
    method: "button" | "text";
  }): Promise<{ ok: true; runId: string; decision: "approved" | "declined"; duplicate: boolean } | { ok: false; reason: string; runId: string | null }> {
    const result = await this.db.transaction(async (tx) => {
      const ex = (await tx.query<{ id: string; run_id: string }>(`SELECT id, run_id FROM margin_exceptions WHERE id = $1 FOR UPDATE`, [input.exceptionId])).rows[0];
      if (!ex) return { ok: false as const, reason: "unknown margin exception", runId: null };
      const decider = (await tx.query<{ roles: string[] }>(`SELECT roles FROM persons WHERE id = $1 AND active`, [input.deciderPersonId])).rows[0];
      if (!decider?.roles.includes("admin")) return { ok: false as const, reason: "only an admin can decide a margin exception", runId: ex.run_id };
      const prior = (await tx.query<{ decision: "approved" | "declined" }>(`SELECT decision FROM margin_exception_decisions WHERE exception_id = $1`, [ex.id])).rows[0];
      if (prior) {
        return prior.decision === input.decision
          ? { ok: true as const, runId: ex.run_id, decision: prior.decision, duplicate: true }
          : { ok: false as const, reason: `already ${prior.decision}`, runId: ex.run_id };
      }
      const run = (await tx.query<RunRecord>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [ex.run_id])).rows[0]!;
      if (run.state !== "AWAITING_MARGIN_APPROVAL") return { ok: false as const, reason: `run is ${run.state}`, runId: ex.run_id };
      await tx.query(
        `INSERT INTO margin_exception_decisions (exception_id, decision, decided_by, provider_event_id, method) VALUES ($1, $2, $3, $4, $5)`,
        [ex.id, input.decision, input.deciderPersonId, input.providerEventId, input.method],
      );
      await this.event(tx, ex.run_id, `margin_exception_${input.decision}`, input.deciderPersonId, { exceptionId: ex.id, method: input.method });
      return { ok: true as const, runId: ex.run_id, decision: input.decision, duplicate: false };
    });
    if (!result.ok) {
      await this.event(this.db, result.runId, "margin_decision_rejected", input.deciderPersonId, { exceptionId: input.exceptionId, reason: result.reason });
    }
    return result;
  }

  // ---------- audit ----------

  async appendEvent(runId: string | null, type: string, actor: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.event(this.db, runId, type, actor, data);
  }

  async listEvents(runId: string): Promise<Array<{ type: string; actor: string; data: Record<string, unknown> }>> {
    const res = await this.db.query<{ type: string; actor: string; data: Record<string, unknown> }>(
      `SELECT type, actor, data FROM events WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return res.rows;
  }

  private async event(db: Db, runId: string | null, type: string, actor: string, data: Record<string, unknown>): Promise<void> {
    await db.query(`INSERT INTO events (run_id, type, actor, data, release_id) VALUES ($1, $2, $3, $4, $5)`, [
      runId,
      type,
      actor,
      JSON.stringify(data),
      this.releaseId,
    ]);
  }
}
