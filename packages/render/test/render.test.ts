import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { customerView, formatUsd, retainerTier, type CustomerProposal } from "@sd/build";
import { sha256Hex } from "@sd/core";
import { recordedDToolsReader } from "@sd/dtools";
import { admitProduct, bind, compile, materialize, patternRecordIds, type AdmittedProduct } from "@sd/build";
import { htmlToPdf, IMAGE_PENDING, loadBrand, preflightPdf, renderProposalHtml } from "../src/index.ts";
import { approvedScope, CATALOG, POLICY, testPattern } from "../../build/test/fixtures.ts";

async function customer(): Promise<CustomerProposal> {
  const pattern = testPattern();
  const { scope, scopeHash, receiptId } = approvedScope();
  const reader = recordedDToolsReader(CATALOG);
  const admitted = new Map<string, AdmittedProduct>();
  for (const id of patternRecordIds(pattern)) {
    const a = admitProduct(id, await reader.getProduct(id), "k");
    if (a.ok) admitted.set(id, a.product);
  }
  const compiled = compile(materialize(scope, pattern), admitted, pattern);
  if (!compiled.ok) throw new Error(compiled.errors.join());
  return customerView(bind(compiled.draft, { runId: "run_r1", receiptId, approvalId: "a", scopeHash, scope, policy: POLICY, releaseId: "rel" }));
}

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const meta = { runId: "run_r1", preparedOn: "2026-10-05" };

async function render(c: CustomerProposal, opts: { watermark?: string; images?: Record<string, string> } = {}) {
  const images = opts.images ?? Object.fromEntries(c.sections.flatMap((s) => s.items).flatMap((i) => ("url" in i.image ? [[i.image.url, PIXEL]] : [])));
  const html = renderProposalHtml(c, await loadBrand(), images, meta);
  const pdf = await htmlToPdf(html, { watermark: opts.watermark });
  return { html, pdf };
}

describe("customer HTML", () => {
  it("contains no internal fields, no acceptance controls, and marks missing images", async () => {
    const c = await customer();
    const html = renderProposalHtml(c, await loadBrand(), {}, meta);
    // Inspect visible markup only: CSS has "margin" properties and base64 data can spell anything.
    const body = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/data:[^"]+/g, "");
    expect(body).not.toMatch(/unit_cost|margin|markup|signature|<input|<form/i);
    expect(html).not.toMatch(/https?:\/\//); // fully self-contained
    expect(html.split(IMAGE_PENDING).length - 1).toBe(c.sections.flatMap((s) => s.items).length);
    expect(html).toContain("Priced scope to date");
    expect(html).not.toMatch(/>Total</);
  });
});

describe("PDF + preflight", () => {
  it("renders a PDF that passes preflight", async () => {
    const c = await customer();
    const { pdf } = await render(c);
    const r = await preflightPdf(pdf, { customer: c, runId: "run_r1", sha256: sha256Hex(pdf) });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.pages).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("looks like a D-Tools proposal: presenter, priced lines, summary and a tiered design retainer", async () => {
    const c = await customer();
    // 4% of the total, or of the priced scope while the total is incomplete (tax TBD here).
    expect(c.commercial.total_cents).toBeNull();
    expect(c.commercial.retainer).toEqual({ cents: retainerTier(c.commercial.subtotal_cents) });
    const html = renderProposalHtml(c, await loadBrand(), {}, { ...meta, presenter: { name: "Henry Clifford", email: "henry@getlivewire.com" } });
    const pdf = await htmlToPdf(html);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), disableFontFace: true, verbosity: 0 }).promise;
    let text = "";
    for (let n = 1; n <= doc.numPages; n++) text += " " + (await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
    text = text.replace(/\s+/g, " ");
    for (const s of ["Henry Clifford", "henry@getlivewire.com", "Project Number", "Why Livewire?", "System Proposal", "Your Custom Quote:", "ITEM QTY", "Installation Labor", "90 Day Warranty", "Summary", "Product + Labor", "Shipping & Handling/Parts", "Looking for Financing or ACH Options?", "Terms & Conditions"]) {
      expect(text, s).toContain(s);
    }
    expect(text).toContain(`Design Retainer ${formatUsd(c.commercial.retainer.cents)}`);
    expect(text).toMatch(/10\/05\/2026 Smith Family Security Modernization Budget Page 1 of \d/);
    // Like Livewire's current proposals: quantities per line, prices only as area totals.
    expect(text).not.toMatch(/UNIT PRICE/);
    expect(text).not.toMatch(/Signature/i);
  }, 60_000);

  it("fails when the watermark is missing or duplicated", async () => {
    const c = await customer();
    const missing = (await render(c, { watermark: "DRAFT" })).pdf;
    expect((await preflightPdf(missing, { customer: c, runId: "run_r1", sha256: sha256Hex(missing) })).failures.join()).toMatch(/watermark 0 times/);
    const dup = await htmlToPdf(renderProposalHtml({ ...c, assumptions: ["CONCEPTUAL BUDGET • NOT FOR APPROVAL"] }, await loadBrand(), {}, meta));
    expect((await preflightPdf(dup, { customer: c, runId: "run_r1", sha256: sha256Hex(dup) })).failures.join()).toMatch(/watermark 2 times/);
  }, 60_000);

  it("fails on form fields, forbidden wording, wrong title, wrong totals and hash mismatch", async () => {
    const c = await customer();
    const { pdf } = await render(c);

    const withForm = await PDFDocument.load(pdf);
    withForm.getForm().createTextField("client.signature").addToPage(withForm.getPage(0), { x: 50, y: 50 });
    const formBytes = await withForm.save();
    expect((await preflightPdf(formBytes, { customer: c, runId: "run_r1", sha256: sha256Hex(formBytes) })).failures.join()).toMatch(/form/);

    const leaky = await htmlToPdf(renderProposalHtml({ ...c, exclusions: ["Internal cost basis available on request"] }, await loadBrand(), {}, meta));
    expect((await preflightPdf(leaky, { customer: c, runId: "run_r1", sha256: sha256Hex(leaky) })).failures.join()).toMatch(/forbidden wording/);

    // The same words inside the requester's own scope text are data, not an acceptance block (pilot: Alexis Courtney).
    const own = { ...c, exclusions: [...c.exclusions, "Client to accept delivery of the Bretford cart"], remaining_verification: [...c.remaining_verification, "Requested product: low-cost conduit"] };
    const ownPdf = await htmlToPdf(renderProposalHtml(own, await loadBrand(), {}, meta));
    expect((await preflightPdf(ownPdf, { customer: own, runId: "run_r1", sha256: sha256Hex(ownPdf) })).failures).toEqual([]);

    expect((await preflightPdf(pdf, { customer: c, runId: "run_other", sha256: sha256Hex(pdf) })).failures.join()).toMatch(/title/);
    const other = { ...c, commercial: { ...c.commercial, subtotal_cents: c.commercial.subtotal_cents + 100 } };
    expect((await preflightPdf(pdf, { customer: other, runId: "run_r1", sha256: sha256Hex(pdf) })).failures.join()).toMatch(/subtotal/);
    expect((await preflightPdf(pdf, { customer: c, runId: "run_r1", sha256: "0".repeat(64) })).failures.join()).toMatch(/hash/);
    expect((await preflightPdf(new TextEncoder().encode("not a pdf"), { customer: c, runId: "run_r1", sha256: "x" })).ok).toBe(false);
  }, 90_000);

  it("refuses to render anything that loads external resources", async () => {
    await expect(htmlToPdf('<html><body><img src="https://example.com/x.png">hi</body></html>')).rejects.toThrow(/external resources/);
  }, 60_000);
});
