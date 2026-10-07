import { formatUsd, PILOT_WATERMARK, type CustomerProposal } from "@sd/build";
import { sha256Hex } from "@sd/core";
import { IMAGE_PENDING } from "./html.ts";

/**
 * Preflight inspects the actual generated PDF bytes (PRD §13.7). It never
 * trusts the renderer's intent: every check reads the document itself.
 */
export interface PreflightExpectation {
  customer: CustomerProposal;
  runId: string;
  /** Hash registered for this artifact; the bytes must match it. */
  sha256: string;
  watermark?: string;
}

export interface PreflightResult {
  ok: boolean;
  pages: number;
  sha256: string;
  failures: string[];
}

const FORBIDDEN = [/\bcosts?\b/i, /\bmargins?\b/i, /\bmarkups?\b/i, /\bcommissions?\b/i, /\bsignature\b/i, /\baccept(ance|ed)?\b/i, /\bsign here\b/i];

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

export async function preflightPdf(bytes: Uint8Array, expected: PreflightExpectation): Promise<PreflightResult> {
  const failures: string[] = [];
  const sha256 = sha256Hex(bytes);
  if (sha256 !== expected.sha256) failures.push("PDF bytes do not match the registered artifact hash");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs detaches the buffer it is given, so hand it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    return { ok: false, pages: 0, sha256, failures: [...failures, `PDF does not parse: ${(err as Error).message}`] };
  }

  const watermark = expected.watermark ?? PILOT_WATERMARK;
  const pageTexts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const text = (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ").replace(/\s+/g, " ");
    pageTexts.push(text);
    const marks = count(text, watermark);
    if (marks !== 1) failures.push(`page ${n} has the watermark ${marks} times (expected exactly 1)`);
    if (text.replace(watermark, "").replace(/Page \d+ of \d+/, "").trim().length < 40) failures.push(`page ${n} has no material content`);
    const annotations = await page.getAnnotations();
    if (annotations.some((a: { subtype?: string }) => a.subtype === "Widget")) failures.push(`page ${n} has form fields`);
  }
  if (doc.numPages === 0) failures.push("PDF has no pages");

  const meta = await doc.getMetadata();
  const info = meta.info as { IsAcroFormPresent?: boolean; Title?: string };
  if (info.IsAcroFormPresent) failures.push("PDF contains an interactive form");
  if (!info.Title?.includes(`run ${expected.runId}`) || !info.Title.startsWith("Livewire conceptual budget")) {
    failures.push("PDF title does not identify this run's generated proposal");
  }

  const all = pageTexts.join(" ");
  for (const re of FORBIDDEN) if (re.test(all)) failures.push(`PDF contains forbidden wording (${re.source})`);

  // Totals reconcile with the validated customer view.
  const c = expected.customer.commercial;
  if (!all.includes(formatUsd(c.subtotal_cents))) failures.push(`subtotal ${formatUsd(c.subtotal_cents)} not found`);
  for (const s of expected.customer.sections) {
    if (!all.includes(formatUsd(s.subtotal_cents))) failures.push(`${s.location} subtotal ${formatUsd(s.subtotal_cents)} not found`);
  }
  if (c.total_cents !== null) {
    if (!all.includes(formatUsd(c.total_cents))) failures.push(`total ${formatUsd(c.total_cents)} not found`);
  } else if (/\bTotal\b/.test(all.replace(/subtotal/gi, ""))) {
    failures.push("an incomplete budget shows a total");
  }
  if (c.tax === "TBD" && !/Tax TBD/.test(all)) failures.push("tax is not shown as TBD");

  // Images: exact-model image or a visible pending notice for each item.
  const pendingExpected = expected.customer.sections.flatMap((s) => s.items).filter((i) => "pending" in i.image).length;
  const pendingFound = count(all, IMAGE_PENDING);
  if (pendingFound < pendingExpected) failures.push(`${pendingExpected} items lack images but only ${pendingFound} show ${IMAGE_PENDING}`);

  await task.destroy();
  return { ok: failures.length === 0, pages: pageTexts.length, sha256, failures };
}
