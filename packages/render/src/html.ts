import { formatUsd, type CustomerProposal } from "@sd/build";
import type { Brand } from "./assets.ts";

/**
 * Customer-facing HTML (PRD §14). Input is the CustomerProposal projection
 * only, so internal cost and margin cannot reach this document. Layout and
 * brand follow the d-tools-skill proposal template, minus every acceptance
 * and signature element (pilot hold, PRD §14.4).
 */
export const IMAGE_PENDING = "IMAGE PENDING";

export interface RenderMeta {
  runId: string;
  preparedOn: string; // YYYY-MM-DD
}

/** Embedded product images keyed by their D-Tools URL. Missing → IMAGE PENDING. */
export type ImageMap = Record<string, string>;

export function documentTitle(c: CustomerProposal, runId: string): string {
  return `Livewire conceptual budget ${c.proposal_number} run ${runId}`;
}

export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function list(items: string[], empty: string): string {
  return items.length ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`;
}

export function renderProposalHtml(c: CustomerProposal, brand: Brand, images: ImageMap, meta: RenderMeta): string {
  const col = brand.colors;
  const sections = c.sections
    .map(
      (s) => `
      <table class="items">
        <thead>
          <tr><th class="group-head" colspan="3">${escapeHtml(s.location)}</th></tr>
          <tr><th class="img-col"></th><th>Equipment</th><th class="num">Qty</th></tr>
        </thead>
        <tbody>${s.items
          .map((i) => {
            const src = "url" in i.image ? images[i.image.url] : undefined;
            const img = src ? `<img class="product" src="${escapeHtml(src)}" alt="${escapeHtml(i.model)}" />` : `<div class="pending">${IMAGE_PENDING}</div>`;
            return `
          <tr>
            <td class="img-col">${img}</td>
            <td>
              <div class="item-name">${escapeHtml(i.manufacturer)} ${escapeHtml(i.model)}</div>
              <div class="item-desc">${escapeHtml(i.description)}</div>
              ${i.quantity_note ? `<div class="item-note">${escapeHtml(i.quantity_note)}</div>` : ""}
            </td>
            <td class="num">${escapeHtml(i.quantity)}</td>
          </tr>`;
          })
          .join("")}
        </tbody>
        <tfoot><tr><td></td><td class="subtotal-label">${escapeHtml(s.location)} subtotal</td><td class="num">${formatUsd(s.subtotal_cents)}</td></tr></tfoot>
      </table>`,
    )
    .join("\n");

  const k = c.commercial;
  const taxRow = k.tax === "TBD" ? `<div class="totals-row"><span>Tax</span><span>TBD</span></div>` : `<div class="totals-row"><span>Estimated tax (${k.tax.rate_pct}%)</span><span>${formatUsd(k.tax.cents)}</span></div>`;
  const totalRow = k.total_cents !== null ? `<div class="totals-row grand"><span>Total</span><span>${formatUsd(k.total_cents)}</span></div>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(documentTitle(c, meta.runId))}</title>
<style>
${brand.fontCss}
:root{--primary:${col.primary};--primary-dark:${col.primaryDark};--accent:${col.accent};--text-accent:${col.textAccent};--ink:${col.ink};--muted:${col.muted};--line:${col.line};--soft:${col.soft};--cream:${col.cream}}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Montserrat',Arial,sans-serif;letter-spacing:-0.005em;color:var(--ink);font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.masthead{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding:28px 36px 22px;background:linear-gradient(120deg,var(--primary-dark) 0%,var(--primary) 70%);color:#fff}
.logo{max-height:64px;max-width:200px}
.tagline{margin-top:6px;font-size:12px;opacity:.85;font-style:italic;font-family:'Fraunces',Georgia,serif;font-weight:300}
.doc-meta{text-align:right}
.doc-meta .kind{font-size:11px;text-transform:uppercase;letter-spacing:3px;opacity:.8}
.doc-meta .number{font-size:20px;font-weight:700;margin-top:4px}
.doc-meta .dates{font-size:11px;margin-top:6px;opacity:.9}
.accentbar{height:5px;background:var(--accent)}
.notice{margin:18px 36px 0;padding:10px 14px;background:var(--cream);border-left:4px solid var(--accent);font-size:12px}
.section{padding:20px 36px;border-bottom:1px solid var(--line)}
h1.project{margin:0;font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:26px;letter-spacing:-0.02em;line-height:1.05}
.prepared{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px}
.label{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted);margin-bottom:3px}
h2{margin:0 0 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.24em;color:var(--text-accent)}
table.items{width:100%;border-collapse:collapse;margin-bottom:18px;page-break-inside:auto}
table.items tr{page-break-inside:avoid}
.group-head{text-align:left;background:var(--primary);color:#fff;padding:8px 10px;font-size:12px;letter-spacing:1px;text-transform:uppercase}
table.items th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);background:var(--soft);padding:6px 10px;border-bottom:1px solid var(--line)}
table.items td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.img-col{width:76px}
img.product{width:64px;height:64px;object-fit:contain}
.pending{width:64px;height:64px;border:1px dashed var(--muted);color:var(--muted);font-size:8px;font-weight:600;display:flex;align-items:center;justify-content:center;text-align:center}
.num{text-align:right;white-space:nowrap}
.item-name{font-weight:600}
.item-desc{color:var(--muted);font-size:12px;margin-top:2px;line-height:1.45}
.item-note{color:var(--text-accent);font-size:11px;margin-top:3px}
.subtotal-label{text-align:right;font-weight:600}
.totals{margin-left:auto;width:300px}
.totals-row{display:flex;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--line)}
.totals-row.grand{border:0;background:var(--primary-dark);color:#fff;font-weight:700;margin-top:4px}
.muted{color:var(--muted)}
.spaced{margin-top:12px}
ul{margin:0;padding-left:18px;line-height:1.6}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
footer{padding:14px 36px;font-size:11px;color:var(--muted)}
</style>
</head>
<body>
<header class="masthead">
  <div>
    <img class="logo" src="${brand.logoDataUri}" alt="${escapeHtml(brand.companyName)} logo" />
    <div class="tagline">${escapeHtml(brand.tagline)}</div>
  </div>
  <div class="doc-meta">
    <div class="kind">Conceptual budget</div>
    <div class="number">${escapeHtml(c.proposal_number)}</div>
    <div class="dates">Prepared ${escapeHtml(meta.preparedOn)}</div>
  </div>
</header>
<div class="accentbar"></div>
<div class="notice">This is a preliminary conceptual budget for discussion. It is not an offer and does not authorize work. Quantities, products and pricing are subject to design and site verification.</div>

<section class="section">
  <h1 class="project">${escapeHtml(c.project_type)}</h1>
  <div class="prepared">
    <div><div class="label">Prepared for</div><div>${escapeHtml(c.client)}</div><div>${escapeHtml(c.property)}</div></div>
    <div><div class="label">Prepared by</div><div>${escapeHtml(brand.companyName)}</div>${Object.values(brand.contact).map((v) => `<div>${escapeHtml(v)}</div>`).join("")}</div>
  </div>
</section>

<section class="section">
  <h2>Recommended equipment</h2>
  ${sections || '<p class="muted">No equipment priced yet.</p>'}
</section>

<section class="section">
  <h2>Services</h2>
  ${list(c.services, "Services to be defined during design.")}
  ${c.allowances.length ? `<div class="label spaced">Allowances</div>${list(c.allowances.map((a) => `${a.label}: ${a.note}`), "")}` : ""}
</section>

<section class="section">
  <h2>Budget summary</h2>
  <div class="totals">
    <div class="totals-row"><span>${escapeHtml(k.label === "Total" ? "Subtotal" : k.label)}</span><span>${formatUsd(k.subtotal_cents)}</span></div>
    ${taxRow}
    ${totalRow}
  </div>
</section>

<section class="section cols">
  <div><h2>Assumptions</h2>${list(c.assumptions, "None.")}</div>
  <div><h2>Exclusions</h2>${list(c.exclusions, "None.")}</div>
</section>

<section class="section">
  <h2>To verify on site</h2>
  ${list(c.remaining_verification, "Nothing outstanding.")}
</section>

<footer>${escapeHtml(brand.companyName)} · Run ${escapeHtml(meta.runId)}</footer>
</body>
</html>`;
}
