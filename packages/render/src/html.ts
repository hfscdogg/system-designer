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
  /** The salesperson presenting the budget, shown on the cover like a D-Tools proposal. */
  presenter?: { name: string; email: string | null };
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

function list(items: string[]): string {
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

/** "2026-10-07" → "Oct 7, 2026", as D-Tools prints dates (UTC, so the date never shifts). */
export function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "2026-10-07" → "10/07/2026" for the page footer. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function itemTable(rows: string): string {
  return `<table class="items">
    <thead><tr><th class="item" colspan="2">ITEM</th><th class="num qty">QTY</th><th class="num">UNIT PRICE</th><th class="num">TOTAL</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function row(img: string, name: string, description: string, quantity: number, unit: string, total: string): string {
  return `<tr class="line">
      <td class="img">${img}</td>
      <td class="name">${escapeHtml(name)}</td>
      <td class="num qty">${escapeHtml(qty(quantity))}</td>
      <td class="num">${unit}</td>
      <td class="num">${total}</td>
    </tr>
    ${description ? `<tr class="desc"><td></td><td colspan="4">${escapeHtml(description)}</td></tr>` : ""}`;
}

/**
 * Customer-facing HTML in the look of Livewire's D-Tools proposals: cover,
 * Why Livewire?, Your Custom Quote, Warranty, Summary, Payment Terms (the
 * design retainer) and Terms & Conditions. No signature or acceptance block
 * (pilot hold, PRD §14.4). Input is the CustomerProposal projection only, so
 * internal cost and margin cannot reach this document.
 */
export function renderProposalHtml(c: CustomerProposal, brand: Brand, images: ImageMap, meta: RenderMeta): string {
  const col = brand.colors;
  const presenter = meta.presenter;
  const sections = c.sections
    .map(
      (s) => `
    <div class="quote-section">
      <h3>${escapeHtml(s.location)}</h3>
      ${itemTable(
        s.items
          .map((i) => {
            const src = "url" in i.image ? images[i.image.url] : undefined;
            const img = src ? `<img class="product" src="${escapeHtml(src)}" alt="${escapeHtml(i.model)}" />` : `<div class="pending">${IMAGE_PENDING}</div>`;
            const description = [i.description, i.quantity_note].filter(Boolean).join(" — ");
            return row(img, `${i.manufacturer} ${i.model}`, description, i.quantity, formatUsd(i.unit_price_cents), formatUsd(i.total_cents));
          })
          .join(""),
      )}
      <div class="section-total">${formatUsd(s.subtotal_cents)}</div>
    </div>`,
    )
    .join("\n");

  const laborTotal = c.labor_lines.reduce((sum, l) => sum + l.total_cents, 0);
  const labor = c.labor_lines.length
    ? `
    <div class="quote-section">
      <h3>Labor &amp; Installation</h3>
      ${itemTable(c.labor_lines.map((l) => row("", l.name, l.description, l.quantity, formatUsd(l.unit_price_cents), formatUsd(l.total_cents))).join(""))}
      <div class="section-total">${formatUsd(laborTotal)}</div>
    </div>`
    : "";
  const allowances = c.allowances.length
    ? `
    <div class="quote-section">
      <h3>Allowances</h3>
      <table class="items"><tbody>${c.allowances.map((a) => `<tr class="line"><td class="name" colspan="4">${escapeHtml(a.label)}</td><td class="num">TBD</td></tr><tr class="desc"><td colspan="5">${escapeHtml(a.note)}</td></tr>`).join("")}</tbody></table>
    </div>`
    : "";

  const k = c.commercial;
  const complete = k.total_cents !== null;
  const summaryRows = [
    ["Product + Labor", formatUsd(k.subtotal_cents), ""],
    [complete ? "Subtotal" : k.label, formatUsd(k.subtotal_cents), "strong"],
    ["Tax", k.tax === "TBD" ? "TBD" : formatUsd(k.tax.cents), ""],
    ...(complete ? [["Total Price", formatUsd(k.total_cents!), "grand"]] : []),
  ]
    .map(([label, value, cls]) => `<div class="sum-row ${cls}"><span>${escapeHtml(label)}</span><span>${value}</span></div>`)
    .join("");

  const about = [
    ["Assumptions", c.assumptions],
    ["Exclusions", c.exclusions],
    ["To verify on site", c.remaining_verification],
  ].filter(([, items]) => (items as string[]).length);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(documentTitle(c, meta.runId))}</title>
<meta name="pdf-footer" content="${escapeHtml(`${shortDate(meta.preparedOn)}|${c.title} V1`)}" />
<style>
${brand.fontCss}
:root{--navy:${col.navy};--green:${col.green};--gray:${col.gray};--label:${col.label};--rule:${col.rule}}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Tinos','Liberation Serif','Times New Roman',serif;color:var(--navy);font-size:11px;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h2{font-family:'Outfit',Arial,sans-serif;font-weight:700;font-size:19px;margin:22px 0 14px;padding-bottom:12px;border-bottom:1px solid var(--rule);letter-spacing:-.01em}
h3{font-weight:400;font-size:17px;margin:22px 0 10px;padding-bottom:10px;border-bottom:1px solid var(--rule);break-after:avoid;page-break-after:avoid}
h2{break-after:avoid;page-break-after:avoid}
h2.first{margin-top:0}
table.items thead{break-after:avoid;page-break-after:avoid}
p{margin:0 0 10px}
.cover{page-break-after:always}
.letterhead{display:flex;align-items:flex-start;gap:18px}
.letterhead .logo{width:118px}
.letterhead .company{color:var(--gray);font-size:11px;line-height:1.35;flex:1}
.letterhead .contact{text-align:right;font-size:11px;line-height:1.35;color:var(--gray)}
.letterhead .contact .link{color:var(--green)}
h1.title{font-weight:400;font-size:34px;margin:26px 0 12px;letter-spacing:-.01em}
.hero{width:100%;height:270px;object-fit:cover;display:block}
.client{margin-top:18px}
.client .who{font-family:'Outfit',Arial,sans-serif;font-weight:700;font-size:12px}
.client .where{font-size:10.5px;color:var(--navy)}
.meta-row{display:flex;justify-content:space-between;margin-top:26px}
.meta-row.near{margin-top:18px}
.meta-label{font-size:10.5px}
.meta-value{font-weight:700;font-size:12px;margin-top:2px}
.right{text-align:right}
table.items{width:100%;border-collapse:collapse}
table.items th{font-weight:400;font-size:7.5px;color:var(--label);padding:6px 0 10px;border-bottom:1px solid var(--rule);text-align:left}
table.items th.num{text-align:right}
table.items th.qty{text-align:center}
table.items tr.line td{padding:12px 0 2px;vertical-align:top;font-size:11.5px}
table.items tr.desc td{padding:0 0 12px;border-bottom:1px solid var(--rule);font-size:10.5px}
table.items tr{page-break-inside:avoid}
td.img{width:52px}
img.product{width:34px;height:34px;object-fit:contain}
.pending{width:44px;height:34px;border:1px dashed var(--label);color:var(--label);font-family:Arial,sans-serif;font-size:4.5px;white-space:nowrap;display:flex;align-items:center;justify-content:center}
.num{text-align:right;white-space:nowrap;width:86px}
.qty{width:60px;text-align:center}
.section-total{text-align:right;font-size:14px;margin:16px 0 8px}
.quote-section{page-break-inside:auto}
.warranty{font-weight:700;font-size:10.5px}
.sum-row{display:flex;justify-content:space-between;padding:16px 0;border-bottom:1px solid var(--rule);font-size:11.5px}
.sum-row.strong{font-weight:700}
.sum-row.grand{font-weight:700;font-size:13.5px;border-bottom:0}
.terms-head{display:flex;justify-content:space-between;align-items:baseline}
.terms-head .amount{font-family:'Outfit',Arial,sans-serif;font-weight:700;font-size:10px}
.milestone{display:flex;justify-content:space-between;align-items:center;padding:12px 0 12px 30px;border-top:1px solid var(--rule);position:relative;font-weight:700;font-size:11.5px}
.milestone:before{content:"";position:absolute;left:0;top:50%;width:9px;height:9px;margin-top:-5px;border:1px solid var(--label);border-radius:50%}
.milestone-note{font-size:10.5px;color:var(--gray);padding-left:30px}
ul{margin:0 0 10px;padding-left:18px}
.about h4{font-family:'Outfit',Arial,sans-serif;font-weight:600;font-size:11.5px;margin:12px 0 4px}
</style>
</head>
<body>
<section class="cover">
  <div class="letterhead">
    <img class="logo" src="${brand.logoDataUri}" alt="${escapeHtml(brand.companyName)} logo" />
    <div class="company">${[brand.companyName, ...brand.address].map(escapeHtml).join("<br>")}</div>
    <div class="contact"><span class="link">${escapeHtml(brand.website)}</span>${presenter ? `<br>${escapeHtml(presenter.name)}${presenter.email ? `<br><span class="link">${escapeHtml(presenter.email)}</span>` : ""}` : ""}</div>
  </div>
  <h1 class="title">${escapeHtml(c.title)}</h1>
  <img class="hero" src="${brand.heroDataUri}" alt="" />
  <div class="client">
    <div class="who">${escapeHtml(c.client)}</div>
    <div class="where">${escapeHtml(c.property)}</div>
  </div>
  <div class="meta-row">
    <div><div class="meta-label">Presented By</div><div class="meta-value">${escapeHtml(brand.companyName)}</div></div>
    <div class="right"><div class="meta-label">Quote Number</div><div class="meta-value">${escapeHtml(c.proposal_number === "UNASSIGNED" ? "Budget" : c.proposal_number)}</div></div>
  </div>
  <div class="meta-row near">
    <div><div class="meta-label">Presented On</div><div class="meta-value">${escapeHtml(longDate(meta.preparedOn))}</div></div>
  </div>
</section>

<h2 class="first">Why Livewire?</h2>
${brand.copy.why.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}

<h2>Your Custom Quote:</h2>
${sections || "<p>No equipment priced yet.</p>"}
${labor}
${allowances}

<h2>Warranty</h2>
<div class="warranty">${brand.copy.warranty.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}</div>

<h2>Summary</h2>
${summaryRows}

<h2 class="terms-head"><span>Payment Terms</span><span class="amount">Amount</span></h2>
<div class="milestone"><span>Design Retainer (${escapeHtml(k.retainer.pct)}%)</span><span>${formatUsd(k.retainer.cents)}</span></div>
<div class="milestone-note">Due to begin design. Remaining payment terms are set in the final proposal.</div>

<h2>Terms &amp; Conditions</h2>
${brand.copy.terms.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}
<p>${escapeHtml(brand.copy.budget)}</p>

${about.length ? `<h2>About This Budget</h2><div class="about">${about.map(([h, items]) => `<h4>${escapeHtml(h)}</h4>${list(items as string[])}`).join("")}</div>` : ""}
</body>
</html>`;
}
