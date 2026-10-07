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
import { hashCanonical, RUN_STATES, sha256Hex, type RunState, type ScopeDraftV1 } from "@sd/core";
import type { OutboundFile } from "@sd/channels";
import { loadBrand, preflightPdf, renderProposalHtml, type PreflightResult } from "@sd/render";
import type { CustomerProposal } from "@sd/build";
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
  renderPdf: (html: string) => Promise<Uint8Array>;
  fetchImage: (url: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
  postFile: (run: RunRecord, file: OutboundFile, key: string) => Promise<{ messageId: string; attachmentRef: string }>;
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

  const stages: Partial<Record<BuildStage, (runId: string) => Promise<StageOutcome>>> = {
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
      let result: ValidationResult = validateProposal(proposal, a.scope, a.scopeHash, await admittedCatalog(runId), "none" in policy ? null : policy);

      // Below the market's margin floor, and nothing else blocking: an admin decides (2026 sales comp policy).
      const margin = result.findings.find((f) => f.code === "margin_exception");
      if (margin && !result.findings.some((f) => f.severity === "block" && f.code !== "margin_exception")) {
        const proposalSha256 = hashCanonical(proposal);
        const exception = await store.getMarginException(runId);
        if (exception?.decision === "declined") return { ok: false, reason: `margin exception declined by ${exception.decided_by_name}` };
        if (exception?.decision === "approved" && exception.proposal_sha256 === proposalSha256) {
          const note = `${margin.message.replace(/; needs an approved exception$/, "")}; exception ${exception.id} approved by ${exception.decided_by_name}`;
          result = { ok: true, findings: result.findings.map((f) => (f === margin ? { code: "margin_exception_approved", severity: "warn", message: note } : f)) };
        } else {
          const requested = await store.requestMarginException({
            runId,
            proposalSha256,
            market: proposal.market,
            grossMarginPct: proposal.internal.gross_margin_pct!,
            minimumPct: proposal.internal.minimum_gross_margin_pct!,
          });
          await advance(runId, "AWAITING_MARGIN_APPROVAL", { exceptionId: requested.id });
          return { ok: false, outcome: "MARGIN_EXCEPTION", exceptionId: requested.id, reason: margin.message };
        }
      }
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
      // Confidential financial report: stored for audit, never posted (PRD §14.5).
      await store.publishArtifact(runId, "internal", "financial_report", {
        run_id: runId,
        policy_version: proposal.internal.policy_version,
        cost_cents: proposal.internal.cost_cents,
        priced_cents_with_cost: proposal.internal.priced_cents_with_cost,
        gross_margin_pct: proposal.internal.gross_margin_pct,
        lines_without_cost: proposal.internal.lines_without_cost,
        market: proposal.market,
        minimum_gross_margin_pct: proposal.internal.minimum_gross_margin_pct,
        mix: proposal.internal.mix,
        labor: proposal.labor,
        parts: proposal.parts,
        lines: proposal.sections.flatMap((sec) =>
          sec.lines.map((l) => ({ role: l.role, record_id: l.record_id, quantity: l.quantity, unit_price_cents: l.unit_price_cents, unit_cost_cents: l.unit_cost_cents })),
        ),
      });
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

  Object.assign(stages, {
    /** Re-read every admitted record right before finalizing (PRD §11.2). Any change stops the run. */
    async refreshCatalog(runId: string): Promise<StageOutcome> {
      const admitted = await artifact<AdmittedProduct[]>(runId, "catalog", "admitted");
      const changed: string[] = [];
      const reads: Array<{ record_id: string; sha256: string; fetched_at: string }> = [];
      for (const p of admitted) {
        let read;
        try {
          read = await deps.dtools.getProduct(p.record_id);
        } catch (err) {
          if (err instanceof DToolsReadError && err.status !== null && err.status < 500) {
            changed.push(`${p.brand} ${p.model} is no longer readable (${err.message})`);
            continue;
          }
          throw err;
        }
        reads.push({ record_id: p.record_id, sha256: read.sha256, fetched_at: read.fetchedAt });
        if (read.sha256 !== p.evidence.sha256) {
          await store.publishBinaryArtifact(runId, "refresh", p.record_id, read.body, "application/json");
          changed.push(`${p.brand} ${p.model} changed in D-Tools`);
        }
      }
      if (changed.length) return { ok: false, reason: changed.join("; "), outcome: "RECONCILIATION_REQUIRED" };
      // Fetch times differ between retries, so only the first confirmation is kept.
      if (!(await store.readArtifact(runId, "refresh", "confirmed"))) {
        await store.publishArtifact(runId, "refresh", "confirmed", { records: reads.map(({ record_id, sha256 }) => ({ record_id, sha256 })), first_fetch: reads[0]?.fetched_at ?? null });
      }
      return { ok: true, summary: `${reads.length} D-Tools records unchanged` };
    },

    async render(runId: string): Promise<StageOutcome> {
      const customer = await artifact<CustomerProposal>(runId, "validate", "customer_view");
      // Rendering is not byte-deterministic (dates, PDF ids), so a retry reuses what was published.
      let html = await store.readBinaryArtifact(runId, "render", "html");
      if (!html) {
        const images: Record<string, string> = {};
        const manifest: Array<{ url: string; sha256: string | null }> = [];
        for (const item of customer.sections.flatMap((s) => s.items)) {
          if (!("url" in item.image) || item.image.url in images) continue;
          const got = await deps.fetchImage(item.image.url).catch(() => null);
          manifest.push({ url: item.image.url, sha256: got ? sha256Hex(got.bytes) : null });
          if (got) images[item.image.url] = `data:${got.contentType};base64,${Buffer.from(got.bytes).toString("base64")}`;
        }
        // The requester presents the budget, as the salesperson does on a D-Tools proposal.
        const run = await store.getRun(runId);
        const person = await store.resolvePersonById(run.person_id);
        const presenter = person ? { name: person.display_name, email: await store.requesterEmail(runId) } : undefined;
        const markup = renderProposalHtml(customer, await loadBrand(), images, { runId, preparedOn: new Date().toISOString().slice(0, 10), presenter });
        await store.publishBinaryArtifact(runId, "render", "html", new TextEncoder().encode(markup), "text/html");
        await store.publishArtifact(runId, "render", "images", manifest);
        html = await store.readBinaryArtifact(runId, "render", "html");
      }
      if (!(await store.readBinaryArtifact(runId, "render", "pdf"))) {
        const pdf = await deps.renderPdf(new TextDecoder().decode(html!.bytes));
        await store.publishBinaryArtifact(runId, "render", "pdf", pdf, "application/pdf");
      }
      await advance(runId, "RENDERED");
      return { ok: true, summary: "PDF rendered" };
    },

    async preflight(runId: string): Promise<StageOutcome> {
      const customer = await artifact<CustomerProposal>(runId, "validate", "customer_view");
      const pdf = await store.readBinaryArtifact(runId, "render", "pdf");
      if (!pdf) throw new IntegrityError(`missing render/pdf for ${runId}`);
      const result: PreflightResult = await preflightPdf(pdf.bytes, { customer, runId, sha256: pdf.sha256 });
      await store.publishArtifact(runId, "preflight", "result", result);
      if (!result.ok) return { ok: false, reason: `PDF preflight failed (${result.failures.slice(0, 3).join("; ")})` };
      await advance(runId, "PREFLIGHT_PASSED", { pages: result.pages, sha256: result.sha256 });
      return { ok: true, summary: `${result.pages}-page PDF passed preflight` };
    },

    async handoff(runId: string): Promise<StageOutcome> {
      const run = await store.getRun(runId);
      const customer = await artifact<CustomerProposal>(runId, "validate", "customer_view");
      const pdf = await store.readBinaryArtifact(runId, "render", "pdf");
      const check = await artifact<PreflightResult>(runId, "preflight", "result");
      if (!pdf || !check.ok || check.sha256 !== pdf.sha256) throw new IntegrityError(`run ${runId} has no preflighted PDF to hand off`);

      const posted = await deps.postFile(
        run,
        {
          bytes: pdf.bytes,
          filename: `Livewire-${customer.proposal_number}-conceptual-budget.pdf`,
          contentType: "application/pdf",
          text: `Conceptual budget for ${customer.client} — held for internal review, not sent to the customer.\nPDF sha256 ${pdf.sha256.slice(0, 16)}…`,
        },
        `${runId}:pdf`,
      );
      await store.recordHandoff({ runId, pdfSha256: pdf.sha256, thread: { platform: run.platform, spaceId: run.space_id, threadId: run.thread_id }, providerMessageId: posted.messageId, attachmentRef: posted.attachmentRef });

      // Bound artifact packet (PRD §14.5): what was produced, from which evidence, by which release.
      const events = await store.listEvents(runId);
      const models = [...new Set(events.map((e) => e.data.model).filter((m): m is string => typeof m === "string"))];
      await store.publishArtifact(runId, "packet", "manifest", {
        run_id: runId,
        release_id: store.releaseId,
        models,
        pdf_sha256: pdf.sha256,
        provider_message_id: posted.messageId,
        artifacts: (await store.listArtifacts(runId)).filter((a) => a.stage !== "packet").map(({ stage, name, sha256 }) => ({ stage, name, sha256 })),
        catalog_evidence: await store.catalogEvidence(runId),
      });
      await advance(runId, "READY_HELD", { pdfSha256: pdf.sha256, providerMessageId: posted.messageId });
      return { ok: true, summary: "PDF posted, held" };
    },
  });

  return async function buildStage({ runId, stage }: { runId: string; stage: BuildStage }): Promise<StageOutcome> {
    const run = stages[stage];
    if (!run) throw new IntegrityError(`unknown build stage ${stage}`);
    return run(runId);
  };
}
