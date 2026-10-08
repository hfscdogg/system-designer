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
    <thead><tr><th class="item" colspan="2">ITEM</th><th class="num qty">QTY</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function row(img: string, name: string, description: string, quantity: number): string {
  return `<tr class="line">
      <td class="img">${img}</td>
      <td class="name"><div class="item-name">${escapeHtml(name)}</div>${description ? `<div class="item-desc">${escapeHtml(description)}</div>` : ""}</td>
      <td class="num qty">${escapeHtml(qty(quantity))}</td>
    </tr>`;
}

const joinWords = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

/**
 * Customer-facing HTML in the look of Livewire's current D-Tools proposals:
 * cover, Why Livewire?, System Proposal introduction, Your Custom Quote (each
 * area with a short scope paragraph, ITEM / QTY and an area total), Warranty,
 * Summary, Payment Terms (financing options and the design retainer) and
 * Terms & Conditions. No signature or acceptance block (pilot hold, PRD
 * §14.4). Input is the CustomerProposal projection only, so internal cost and
 * margin cannot reach this document.
 */
export function renderProposalHtml(c: CustomerProposal, brand: Brand, images: ImageMap, meta: RenderMeta): string {
  const col = brand.colors;
  const presenter = meta.presenter;
  const sections = c.sections
    .map((s) => {
      const toVerify = s.items.some((i) => i.quantity_note);
      const scope = `Livewire will furnish, install and program the equipment below for the ${s.location.toLowerCase()}.${toVerify ? " Quantities marked as minimums are confirmed during design." : ""}`;
      return `
    <div class="quote-section">
      <h3>${escapeHtml(s.location)}</h3>
      <p class="scope">${escapeHtml(scope)}</p>
      ${itemTable(
        s.items
          .map((i) => {
            const src = "url" in i.image ? images[i.image.url] : undefined;
            const img = src ? `<img class="product" src="${escapeHtml(src)}" alt="${escapeHtml(i.model)}" />` : `<div class="pending">${IMAGE_PENDING}</div>`;
            const description = [i.description, i.quantity_note].filter(Boolean).join(" — ");
            return row(img, `${i.manufacturer} ${i.model}`, description, i.quantity);
          })
          .join(""),
      )}
      <div class="section-total">${formatUsd(s.subtotal_cents)}</div>
    </div>`;
    })
    .join("\n");

  const labor = c.labor_lines.length
    ? `
    <div class="quote-section">
      <h3>Labor &amp; Installation</h3>
      <p class="scope">Design, installation, programming and testing by Livewire's technicians.</p>
      ${itemTable(c.labor_lines.map((l) => row("", l.name, l.description, l.quantity)).join(""))}
      <div class="section-total">${formatUsd(c.labor_total_cents)}</div>
    </div>`
    : "";
  const allowances = c.allowances.length
    ? `
    <div class="quote-section">
      <h3>Allowances</h3>
      ${itemTable(c.allowances.map((a) => row("", a.label, a.note, 1)).join(""))}
    </div>`
    : "";

  const k = c.commercial;
  const complete = k.total_cents !== null;
  const summaryRows = [
    ["Product + Labor", formatUsd(k.subtotal_cents + (k.reduction?.cents ?? 0) - k.parts_cents), ""],
    ...(k.parts_cents > 0 ? [["Shipping & Handling/Parts", formatUsd(k.parts_cents), ""]] : []),
    ...(k.reduction ? [[`Discount (${k.reduction.pct}%)`, `(${formatUsd(k.reduction.cents)})`, ""]] : []),
    [complete ? "Subtotal" : k.label, formatUsd(k.subtotal_cents), "strong"],
    ["Tax", k.tax === "TBD" ? "TBD" : formatUsd(k.tax.cents), ""],
    ...(complete ? [["Total Price", formatUsd(k.total_cents!), "grand"]] : []),
  ]
    .map(([label, value, cls]) => `<div class="sum-row ${cls}"><span>${escapeHtml(label)}</span><span class="amt">${value}</span></div>`)
    .join("");

  const intro = [
    `Livewire is proud to present the following conceptual budget for the ${c.intro.systems} of the client's ${c.project_type.toLowerCase().includes("commercial") ? "property" : "residence"}${c.intro.rooms.length ? `, covering the ${joinWords(c.intro.rooms.map((r) => r.toLowerCase()))}` : ""}. Our team will deliver a turnkey solution with reliable, high-performance systems and a clean, organized installation.`,
    "The scope of work is outlined alongside each area's bill of materials.",
    ...(c.intro.labor_hours ? [`We expect the work to take approximately ${c.intro.labor_hours} technician hours to complete.`] : []),
  ];

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
<meta name="pdf-footer" content="${escapeHtml(`${shortDate(meta.preparedOn)}|${c.client} ${c.title}`)}" />
<style>
${brand.fontCss}
:root{--navy:${col.navy};--green:${col.green};--gray:${col.gray};--label:${col.label};--rule:${col.rule};--link:${col.link}}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Outfit',Arial,sans-serif;font-weight:400;color:var(--navy);font-size:11px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h2{font-weight:700;font-size:20px;margin:26px 0 14px;padding-bottom:12px;border-bottom:1px solid var(--rule);break-after:avoid;page-break-after:avoid}
h2.first{margin-top:0}
h3{font-weight:500;font-size:16px;margin:24px 0 12px;padding-bottom:12px;border-bottom:1px solid var(--rule);break-after:avoid;page-break-after:avoid}
h4.sub{font-weight:600;font-size:16px;margin:16px 0 2px}
p{margin:0 0 12px}
.link{color:var(--link)}
.cover{page-break-after:always}
.letterhead{display:flex;align-items:flex-start;gap:20px}
.letterhead .logo{width:122px}
.letterhead .company{color:var(--gray);font-size:11px;line-height:1.35;flex:1}
.letterhead .company .name{font-size:12.5px}
.letterhead .contact{text-align:right;font-size:10.5px;line-height:1.35;color:var(--gray)}
.letterhead .contact .web{color:var(--green);font-weight:600}
.letterhead .contact .mail{color:var(--green)}
h1.title{font-weight:400;font-size:32px;margin:22px 0 16px;letter-spacing:-.01em}
.hero{width:100%;height:265px;object-fit:cover;display:block}
.client{margin-top:18px}
.client .who{font-weight:600;font-size:12.5px;margin-bottom:4px}
.client .where{font-size:10.5px;line-height:1.3}
.meta-row{display:flex;justify-content:space-between;margin-top:30px}
.meta-row.near{margin-top:22px}
.meta-label{font-size:10px;font-weight:600}
.meta-value{font-weight:600;font-size:13px;margin-top:2px}
.right{text-align:right}
p.scope{margin:0 0 18px}
table.items{width:100%;border-collapse:collapse;break-before:avoid}
table.items thead{break-after:avoid;page-break-after:avoid}
table.items th{font-weight:400;font-size:7.5px;color:var(--label);padding:6px 0 10px;border-bottom:1px solid var(--rule);text-align:left}
table.items th.qty{text-align:center}
table.items tr.line td{padding:12px 0;vertical-align:top;border-bottom:1px solid var(--rule)}
table.items tr{page-break-inside:avoid}
td.img{width:58px}
img.product{width:46px;height:40px;object-fit:contain}
.pending{width:46px;height:34px;border:1px dashed var(--label);color:var(--label);font-family:Arial,sans-serif;font-size:4.5px;white-space:nowrap;display:flex;align-items:center;justify-content:center}
.item-name{font-weight:600;font-size:12px}
.item-desc{font-size:11px;margin-top:3px}
.qty{width:70px;text-align:center;font-size:12px}
.section-total{text-align:right;font-size:15px;margin:20px 0 10px}
.warranty p{font-weight:500}
.sum-row{display:flex;justify-content:space-between;padding:17px 0;border-bottom:1px solid var(--rule);font-size:12px}
.sum-row .amt{color:var(--gray)}
.sum-row.strong{font-weight:600}
.sum-row.strong .amt,.sum-row.grand .amt{color:var(--navy)}
.sum-row.grand{font-weight:600;font-size:14px;border-bottom:0}
.terms-head{display:flex;justify-content:space-between;align-items:baseline}
.terms-head .amount{font-weight:600;font-size:11px}
.financing{padding:4px 0 10px 24px;border-bottom:1px solid var(--rule);margin-bottom:16px}
.financing h4{font-weight:500;font-size:16px;margin:4px 0 10px}
.financing p{margin:0 0 8px;font-size:10px}
h3.plan{border-bottom:0;margin:10px 0 8px;padding-bottom:0}
.milestone{display:flex;justify-content:space-between;align-items:center;padding:10px 0 10px 36px;position:relative;font-weight:600;font-size:12px}
.milestone:before{content:"";position:absolute;left:0;top:50%;width:12px;height:12px;margin-top:-7px;border:1px solid var(--label);border-radius:50%}
.milestone .amt{color:var(--gray);font-weight:500}
.milestone-note{font-size:10px;color:var(--gray);padding-left:36px}
ul{margin:0 0 10px;padding-left:18px}
.about h4{font-weight:600;font-size:12px;margin:12px 0 4px}
</style>
</head>
<body>
<section class="cover">
  <div class="letterhead">
    <img class="logo" src="${brand.logoDataUri}" alt="${escapeHtml(brand.companyName)} logo" />
    <div class="company"><div class="name">${escapeHtml(brand.companyName)}</div>${brand.address.map(escapeHtml).join("<br>")}</div>
    <div class="contact"><span class="web">${escapeHtml(brand.website)}</span>${presenter ? `<br>${escapeHtml(presenter.name)}${presenter.email ? `<br><span class="mail">${escapeHtml(presenter.email)}</span>` : ""}` : ""}</div>
  </div>
  <h1 class="title">${escapeHtml(c.title)}</h1>
  <img class="hero" src="${brand.heroDataUri}" alt="" />
  <div class="client">
    <div class="who">${escapeHtml(c.client)}</div>
    <div class="where">${escapeHtml(c.property)}</div>
  </div>
  <div class="meta-row">
    <div><div class="meta-label">Presented By</div><div class="meta-value">${escapeHtml(brand.companyName)}</div></div>
    <div class="right"><div class="meta-label">Project Number</div><div class="meta-value">${escapeHtml(c.proposal_number === "UNASSIGNED" ? "Budget" : c.proposal_number)}</div></div>
  </div>
  <div class="meta-row near">
    <div><div class="meta-label">Presented On</div><div class="meta-value">${escapeHtml(longDate(meta.preparedOn))}</div></div>
  </div>
</section>

<h2 class="first">Why Livewire?</h2>
${brand.copy.why.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}

<h2>System Proposal</h2>
<h4 class="sub">Introduction</h4>
${intro.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}
${brand.copy.intro_after.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}
<p class="link">${escapeHtml(brand.copy.no_surprises)}</p>
<p>${escapeHtml(brand.copy.team[0])}<br><span class="link">${escapeHtml(brand.copy.team[1])}</span></p>

<h2>Your Custom Quote:</h2>
${sections || "<p>No equipment priced yet.</p>"}
${labor}
${allowances}

<h2>${escapeHtml(brand.copy.warranty_title)}</h2>
<div class="warranty">${brand.copy.warranty.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}</div>

<h2>Summary</h2>
${summaryRows}

<h2 class="terms-head"><span>Payment Terms</span><span class="amount">Amount</span></h2>
<div class="financing">
  <h4>Looking for Financing or ACH Options?</h4>
  ${brand.copy.financing.map(([label, value]) => `<p>${escapeHtml(label)}</p><p class="${value.startsWith("www.") ? "link" : ""}">${escapeHtml(value)}</p>`).join("")}
</div>
<h3 class="plan">Design Payment Terms</h3>
<div class="milestone"><span>Design Retainer (${escapeHtml(k.retainer.pct)}%)</span><span class="amt">${formatUsd(k.retainer.cents)}</span></div>
<div class="milestone-note">Due to begin design. Project payment terms are set in the final proposal.</div>

<h2>Terms &amp; Conditions</h2>
${brand.copy.terms.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}
<p>${escapeHtml(brand.copy.budget)}</p>

${about.length ? `<h2>About This Budget</h2><div class="about">${about.map(([h, items]) => `<h4>${escapeHtml(h)}</h4>${list(items as string[])}`).join("")}</div>` : ""}
</body>
</html>`;
}
