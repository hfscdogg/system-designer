import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { customerView, type CustomerProposal } from "@sd/build";
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
