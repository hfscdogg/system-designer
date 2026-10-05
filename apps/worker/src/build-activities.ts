import {
  admitProduct,
  bind,
  compile,
  CommercialPolicySchema,
  customerView,
  formatUsd,
  materialize,
  patternRecordIds,
  PatternSpecSchema,
  selectPattern,
  validateProposal,
  type AdmittedProduct,
  type PatternSpec,
  type PolicyRecord,
  type Proposal,
  type ProposalDraft,
  type ValidationResult,
} from "@sd/build";
import { RUN_STATES, type RunState, type ScopeDraftV1 } from "@sd/core";
import { DToolsReadError, type DToolsReader } from "@sd/dtools";
import { IntegrityError, type RunRecord, type Store } from "@sd/store";
import type { BuildStage, StageOutcome } from "./workflows/logic.ts";

/**
 * Build stages after scope approval (PRD §13). Each stage reads the previous
 * stage's published artifacts (never in-memory state), publishes its own once,
 * and advances the run state. A retried stage reproduces identical artifacts.
 */
export interface BuildDeps {
  store: Store;
  dtools: DToolsReader;
  patterns: PatternSpec[];
  notify: (run: RunRecord, text: string, key: string) => Promise<void>;
}

interface Approved {
  approvalId: string;
  receiptId: string;
  scope: ScopeDraftV1;
  scopeHash: string;
}

export function createBuildStage(deps: BuildDeps) {
  const { store } = deps;

  async function approved(runId: string): Promise<Approved> {
    const approval = await store.getApprovalForRun(runId);
    if (!approval) throw new IntegrityError(`run ${runId} has no approval`);
    const receipt = await store.getReceipt(approval.receipt_id);
    if (!receipt?.body.scope || receipt.scope_hash !== approval.scope_hash) throw new IntegrityError(`approved receipt for ${runId} does not match its approval`);
    return { approvalId: approval.id, receiptId: receipt.id, scope: receipt.body.scope, scopeHash: approval.scope_hash };
  }

  async function artifact<T>(runId: string, stage: string, name: string): Promise<T> {
    const value = await store.readArtifact<T>(runId, stage, name);
    if (value === null) throw new IntegrityError(`missing ${stage}/${name} for ${runId}`);
    return value;
  }

  async function admittedCatalog(runId: string): Promise<Map<string, AdmittedProduct>> {
    const products = await artifact<AdmittedProduct[]>(runId, "catalog", "admitted");
    return new Map(products.map((p) => [p.record_id, p]));
  }

  /**
   * Move forward to `to`. A retried stage whose earlier attempt already advanced
   * the run (its result was lost in transit) finds the run at or past `to` and
   * does nothing, instead of trying to move backwards.
   */
  async function advance(runId: string, to: RunState, data: Record<string, unknown> = {}) {
    const current = (await store.getRun(runId)).state;
    const forward = (s: RunState) => RUN_STATES.indexOf(s);
    if (forward(current) >= forward(to) && forward(current) <= forward("READY_HELD")) return;
    await store.transitionRun(runId, to, "system", data);
  }

  const stages: Record<BuildStage, (runId: string) => Promise<StageOutcome>> = {
    async prebuild(runId) {
      const a = await approved(runId);
      const acquired = await store.acquireBuild(runId, a.approvalId, a.scopeHash);
      if (!acquired.ok) return { ok: false, reason: acquired.reason };
      const pattern = selectPattern(a.scope.functional_systems, deps.patterns);
      if (!pattern) {
        return { ok: false, reason: `no single approved architecture pattern covers ${a.scope.functional_systems.join(", ")}; Zack needs to review this scope` };
      }
      // Freeze the pattern this run builds with, so later stages and retries use exactly it.
      await store.publishArtifact(runId, "prebuild", "pattern", pattern);
      await advance(runId, "PREBUILD_VERIFIED", { pattern: pattern.pattern, version: pattern.version });
      return { ok: true, summary: `${pattern.title} pattern` };
    },

    async admitCatalog(runId) {
      const pattern = PatternSpecSchema.parse(await artifact(runId, "prebuild", "pattern"));
      const admitted: AdmittedProduct[] = [];
      const rejected: string[] = [];
      for (const id of patternRecordIds(pattern)) {
        let read;
        try {
          read = await deps.dtools.getProduct(id);
        } catch (err) {
          // Missing records block; outages are thrown so the activity retries, then fails visibly.
          if (err instanceof DToolsReadError && err.status !== null && err.status < 500) {
            rejected.push(`${id}: ${err.message}`);
            continue;
          }
          throw err;
        }
        const admission = admitProduct(id, read, "");
        const blobKey = await store.recordCatalogRead(
          runId,
          { recordId: id, endpoint: read.endpoint, body: read.body, sha256: read.sha256, fetchedAt: read.fetchedAt },
          { admitted: admission.ok, reason: admission.ok ? null : admission.reason },
        );
        if (admission.ok) admitted.push({ ...admission.product, evidence: { ...admission.product.evidence, blob_key: blobKey } });
        else rejected.push(`${id}: ${admission.reason}`);
      }
      if (rejected.length) return { ok: false, reason: `D-Tools records could not be admitted (${rejected.join("; ")})` };
      await store.publishArtifact(runId, "catalog", "admitted", admitted);
      await advance(runId, "CATALOG_EVIDENCE_ADMITTED", { records: admitted.length });
      return { ok: true, summary: `${admitted.length} D-Tools records read` };
    },

    async compileSelection(runId) {
      const a = await approved(runId);
      const pattern = PatternSpecSchema.parse(await artifact(runId, "prebuild", "pattern"));
      const selection = materialize(a.scope, pattern);
      await store.publishArtifact(runId, "selection", "selection", selection);
      await advance(runId, "SELECTION_READY");
      const compiled = compile(selection, await admittedCatalog(runId), pattern);
      if (!compiled.ok) return { ok: false, reason: `the compiler rejected the selection (${compiled.errors.slice(0, 3).join("; ")})` };
      await store.publishArtifact(runId, "compile", "draft", compiled.draft);
      await advance(runId, "COMPILED");
      return { ok: true, summary: `${compiled.draft.lines.length} products, ${compiled.draft.unresolved.length} unresolved` };
    },

    async bindProposal(runId) {
      const a = await approved(runId);
      const draft = await artifact<ProposalDraft>(runId, "compile", "draft");
      // The policy in force is frozen into the run on first bind.
      let policy = await store.readArtifact<PolicyRecord | { none: true }>(runId, "bind", "policy");
      if (!policy) {
        const latest = await store.latestPolicy();
        policy = latest ? { version: latest.version, policy: CommercialPolicySchema.parse(latest.policy) } : { none: true };
        await store.publishArtifact(runId, "bind", "policy", policy);
      }
      const proposal = bind(draft, {
        runId,
        receiptId: a.receiptId,
        approvalId: a.approvalId,
        scopeHash: a.scopeHash,
        scope: a.scope,
        policy: "none" in policy ? null : policy,
        releaseId: store.releaseId,
      });
      await store.publishArtifact(runId, "bind", "proposal", proposal);
      await advance(runId, "BOUND");
      return { ok: true, summary: `${proposal.commercial.label}: ${formatUsd(proposal.commercial.subtotal_cents)}` };
    },

    async validate(runId) {
      const a = await approved(runId);
      const proposal = await artifact<Proposal>(runId, "bind", "proposal");
      const policy = await artifact<PolicyRecord | { none: true }>(runId, "bind", "policy");
      const result: ValidationResult = validateProposal(proposal, a.scope, a.scopeHash, await admittedCatalog(runId), "none" in policy ? null : policy);
      await store.publishArtifact(runId, "validate", "result", result);
      const run = await store.getRun(runId);
      for (const [i, finding] of result.findings.filter((f) => f.severity === "escalate").entries()) {
        await deps.notify(run, `⚠️ Needs Zack's review: ${finding.message}`, `${runId}:escalation:${i}`);
      }
      if (!result.ok) {
        const blocking = result.findings.filter((f) => f.severity === "block").map((f) => f.message);
        return { ok: false, reason: `validation failed (${blocking.join("; ")})` };
      }
      await store.publishArtifact(runId, "validate", "customer_view", customerView(proposal));
      await advance(runId, "VALIDATED");
      const c = proposal.commercial;
      const summary = [
        `Proposal validated for ${proposal.client}.`,
        `${c.label}: ${formatUsd(c.subtotal_cents)}${c.total_cents !== null ? ` (total ${formatUsd(c.total_cents)})` : ""}; tax ${c.tax.status === "calculated" ? formatUsd(c.tax.cents) : "TBD"}.`,
        proposal.allowances.length ? `Allowances (TBD): ${proposal.allowances.map((x) => x.label).join(", ")}.` : null,
        proposal.remaining_verification.length ? `To verify: ${proposal.remaining_verification.join("; ")}.` : null,
      ].filter(Boolean);
      await deps.notify(run, summary.join("\n"), `${runId}:validated`);
      return { ok: true, summary: summary[1]! };
    },
  };

  return async function buildStage({ runId, stage }: { runId: string; stage: BuildStage }): Promise<StageOutcome> {
    return stages[stage](runId);
  };
}
