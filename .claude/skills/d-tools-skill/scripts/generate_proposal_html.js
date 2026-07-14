#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Client-facing proposal generator (branded, print/PDF-ready).
 *
 * SAFE TO SEND TO CUSTOMERS: renders name/description/qty/price only.
 * It never includes MSRP, unit cost, supplier, margin, or client quote history —
 * for that internal view use generate_quote_html.js instead.
 *
 * Input modes (pick one):
 *   1. --quote-id <QUOTE_ID>
 *        Fetches the quote + opportunity live from D-Tools (needs DTOOLS_API_KEY).
 *   2. --opportunity-file <dtools-data/info/P-XXXX.json> --items <selected_items.json>
 *        Renders from a local opportunity snapshot plus a selected-items file
 *        (the common case: the public API cannot create quotes).
 *        Optional: --extra-info-file <dtools-data/info/<id>_info.json> for the
 *        scope-of-work narrative. Or use --opportunity-id <ID> to fetch live.
 *
 * Other options:
 *   --brand <path>     brand config (default: ../brand/livewire.json)
 *   --out-dir <dir>    output directory (default: <repo>/generated_quotes)
 *   --out-file <name>  output filename
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const DEFAULT_BRAND_PATH = path.resolve(__dirname, "../brand/livewire.json");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "generated_quotes");

function readArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function fail(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  console.error(JSON.stringify({ ok: false, problems: list }, null, 2));
  process.exit(1);
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(html) {
  return String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function money(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(n);
}

function fmtDate(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function readJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} not found at ${filePath} — check the path and re-run.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`${label} at ${filePath} is not valid JSON (${err.message}) — fix the file and re-run.`);
  }
  return null;
}

/**
 * Strict validation of the selected-items payload so a small runtime model gets a
 * corrective message it can act on, instead of a half-rendered proposal.
 */
function validateItemsPayload(payload, sourcePath) {
  const problems = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail(`${sourcePath}: top level must be an object like {"items": [...]}.`);
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    fail(`${sourcePath}: "items" must be a non-empty array.`);
  }
  payload.items.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      problems.push(`items[${i}] must be an object.`);
      return;
    }
    if (!item.name || !String(item.name).trim()) {
      problems.push(`missing items[${i}].name — add the product/service name and re-run.`);
    }
    const qty = Number(item.quantity);
    if (item.quantity === undefined || Number.isNaN(qty) || qty <= 0) {
      problems.push(`missing/invalid items[${i}].quantity — set a number greater than 0 and re-run.`);
    }
    const price = Number(item.unitPrice);
    if (item.unitPrice === undefined || Number.isNaN(price) || price < 0) {
      problems.push(`missing/invalid items[${i}].unitPrice — set the per-unit price (number) and re-run.`);
    }
  });
  if (payload.taxRate !== undefined) {
    const rate = Number(payload.taxRate);
    if (Number.isNaN(rate) || rate < 0 || rate >= 1) {
      problems.push(`invalid taxRate ${JSON.stringify(payload.taxRate)} — use a decimal fraction like 0.0825 for 8.25%.`);
    }
  }
  if (problems.length) fail(problems);
}

function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turn the free-form extra-info JSON into readable scope bullets. */
function extraInfoToScope(extraInfo) {
  const data = extraInfo?.data || extraInfo;
  if (!data || typeof data !== "object") return { intent: null, points: [] };

  const SKIP_KEYS = new Set(["source", "savedAt"]);
  let intent = null;
  const points = [];

  for (const [key, value] of Object.entries(data)) {
    if (SKIP_KEYS.has(key) || value === null || value === undefined || value === "") continue;
    if (key === "customerIntent") {
      intent = String(value);
      continue;
    }
    if (Array.isArray(value)) {
      points.push({ label: humanizeKey(key), value: value.map(String).join(", ") });
    } else if (typeof value === "object") {
      points.push({ label: humanizeKey(key), value: JSON.stringify(value) });
    } else if (typeof value === "boolean") {
      points.push({ label: humanizeKey(key), value: value ? "Yes" : "No" });
    } else {
      points.push({ label: humanizeKey(key), value: String(value) });
    }
  }
  return { intent, points };
}

function buildAddress(a) {
  if (!a) return null;
  const parts = [
    a.addressLine1,
    a.addressLine2,
    [a.city, a.state].filter(Boolean).join(", "),
    a.postalCode
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = String(item.group || "Project Scope").trim() || "Project Scope";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/** Returns the value unless it's empty or a "TODO..." placeholder from the brand config. */
function real(value) {
  const s = String(value || "").trim();
  return s && !s.toUpperCase().startsWith("TODO") ? s : null;
}

function renderHtml({ brand, meta, clientBlock, scope, items, totals, notes }) {
  const c = brand.colors || {};
  const f = brand.fonts || {};
  const displayFont = f.display || "Georgia, 'Times New Roman', serif";
  const bodyFont = f.body || "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  const fontImport = f.googleImport ? `@import url('${f.googleImport}');` : "";
  const groups = groupItems(items);

  const groupSections = [...groups.entries()]
    .map(([groupName, rows]) => {
      const rowsHtml = rows
        .map((item) => {
          const qty = Number(item.quantity) || 0;
          const unit = Number(item.unitPrice) || 0;
          return `
          <tr>
            <td>
              <div class="item-name">${escapeHtml(item.name)}</div>
              ${item.description ? `<div class="item-desc">${escapeHtml(stripHtml(item.description))}</div>` : ""}
            </td>
            <td class="num">${escapeHtml(qty)}</td>
            <td class="num">${money(unit)}</td>
            <td class="num">${money(qty * unit)}</td>
          </tr>`;
        })
        .join("\n");
      return `
      <table class="items">
        <thead>
          <tr>
            <th class="group-head" colspan="4">${escapeHtml(groupName)}</th>
          </tr>
          <tr>
            <th>Item</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Total</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
    })
    .join("\n");

  const scopeHtml =
    scope.intent || scope.points.length
      ? `
    <section class="section">
      <h2>Scope of Work</h2>
      ${scope.intent ? `<p class="intent">${escapeHtml(scope.intent)}</p>` : ""}
      ${
        scope.points.length
          ? `<dl class="scope-grid">${scope.points
              .map((p) => `<div class="scope-cell"><dt>${escapeHtml(p.label)}</dt><dd>${escapeHtml(p.value)}</dd></div>`)
              .join("\n")}</dl>`
          : ""
      }
    </section>`
      : "";

  const termsHtml = (brand.terms || [])
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("\n");

  const logoHtml = brand.logoDataUri
    ? `<img class="logo" src="${escapeHtml(brand.logoDataUri)}" alt="${escapeHtml(brand.companyName || "")} logo" />`
    : `<div class="logo-text">${escapeHtml(brand.logoText || brand.companyName || "Proposal")}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(brand.companyName || "")} Proposal ${escapeHtml(meta.number || "")}</title>
  <style>
    ${fontImport}
    :root {
      --primary: ${c.primary || "#0e2a52"};
      --primary-dark: ${c.primaryDark || "#081c39"};
      --accent: ${c.accent || "#0f766e"};
      --text-accent: ${c.textAccent || c.accent || "#0f766e"};
      --ink: ${c.ink || "#12202f"};
      --muted: ${c.muted || "#5a6b7f"};
      --line: ${c.line || "#dfe6ee"};
      --soft: ${c.soft || "#f5f8fc"};
      --font-display: ${displayFont};
      --font-body: ${bodyFont};
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: var(--font-body);
      letter-spacing: -0.005em;
      color: var(--ink);
      background: ${c.pageBackground || "#eef2f7"};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sheet {
      max-width: 850px;
      margin: 24px auto;
      background: #fff;
      box-shadow: 0 12px 40px rgba(15, 30, 55, 0.12);
    }
    .masthead {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 24px;
      padding: 44px 52px 32px 52px;
      background: linear-gradient(120deg, var(--primary-dark) 0%, var(--primary) 70%);
      color: #fff;
    }
    .logo { max-height: 54px; max-width: 220px; }
    .logo-text {
      font-weight: 800;
      font-size: 26px;
      letter-spacing: 4px;
    }
    .tagline { margin-top: 6px; font-size: 13px; opacity: 0.85; font-style: italic; font-family: var(--font-display); }
    .doc-meta { text-align: right; }
    .doc-meta .kind { font-size: 12px; text-transform: uppercase; letter-spacing: 3px; opacity: 0.8; }
    .doc-meta .number { font-size: 22px; font-weight: 700; margin-top: 4px; }
    .doc-meta .dates { font-size: 12px; margin-top: 8px; opacity: 0.9; line-height: 1.5; }
    .accentbar { height: 6px; background: var(--accent); }
    .section { padding: 28px 52px; border-bottom: 1px solid var(--line); }
    .section:last-of-type { border-bottom: 0; }
    h1.project {
      margin: 0;
      font-family: var(--font-display);
      font-variation-settings: ${f.displayVariationSettings || "normal"};
      font-size: 30px;
      font-weight: 500;
      letter-spacing: -0.02em;
      line-height: 1.05;
      color: var(--primary-dark);
    }
    .prepared {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
      margin-top: 18px;
      font-size: 14px;
    }
    .prepared .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    h2 {
      margin: 0 0 14px 0;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.24em;
      color: var(--text-accent);
    }
    .intent { font-size: 16px; line-height: 1.6; margin: 0 0 16px 0; }
    .scope-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 24px;
      margin: 0;
    }
    .scope-cell { padding: 8px 0; border-bottom: 1px dotted var(--line); }
    .scope-cell dt { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
    .scope-cell dd { margin: 3px 0 0 0; font-size: 14px; }
    table.items { width: 100%; border-collapse: collapse; margin-bottom: 22px; }
    table.items:last-child { margin-bottom: 0; }
    .group-head {
      text-align: left;
      background: var(--primary);
      color: #fff;
      padding: 9px 12px;
      font-size: 13px;
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    table.items th {
      text-align: left;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted);
      background: var(--soft);
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
    }
    table.items td { padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; }
    .item-name { font-weight: 600; }
    .item-desc { color: var(--muted); font-size: 12.5px; margin-top: 3px; line-height: 1.45; }
    .totals { margin-left: auto; width: 320px; }
    .totals-row { display: flex; justify-content: space-between; padding: 9px 12px; font-size: 14px; border-bottom: 1px solid var(--line); }
    .totals-row.grand { border: 0; background: var(--primary-dark); color: #fff; font-size: 16px; font-weight: 700; margin-top: 4px; }
    .note { color: var(--muted); font-size: 13px; margin-top: 14px; font-style: italic; }
    ol.terms { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.7; color: ${c.ink600 || "#3A3A33"}; }
    .acceptance { display: grid; grid-template-columns: 2fr 1fr; gap: 40px; margin-top: 10px; }
    .sig-line { border-bottom: 1px solid var(--ink); height: 34px; }
    .sig-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-top: 6px; }
    footer.colophon {
      padding: 20px 52px 30px 52px;
      background: var(--soft);
      font-size: 12px;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    @media (max-width: 700px) {
      .masthead, .section, footer.colophon { padding-left: 20px; padding-right: 20px; }
      .prepared, .scope-grid, .acceptance { grid-template-columns: 1fr; }
      .totals { width: 100%; }
    }
    @page { size: letter; margin: 0.55in; }
    @media print {
      body { background: #fff; }
      .sheet { margin: 0; max-width: none; box-shadow: none; }
      .section { page-break-inside: avoid; }
      table.items tr { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <header class="masthead">
      <div>
        ${logoHtml}
        ${brand.tagline ? `<div class="tagline">${escapeHtml(brand.tagline)}</div>` : ""}
      </div>
      <div class="doc-meta">
        <div class="kind">Proposal</div>
        <div class="number">${escapeHtml(meta.number || "Draft")}</div>
        <div class="dates">
          Prepared ${escapeHtml(fmtDate(meta.preparedAt))}<br />
          Valid until ${escapeHtml(fmtDate(meta.validUntil))}
        </div>
      </div>
    </header>
    <div class="accentbar"></div>

    <section class="section">
      <h1 class="project">${escapeHtml(meta.projectName || "Project Proposal")}</h1>
      <div class="prepared">
        <div>
          <div class="label">Prepared for</div>
          <div>${escapeHtml(clientBlock.name || "—")}</div>
          ${clientBlock.siteAddress ? `<div>${escapeHtml(clientBlock.siteAddress)}</div>` : ""}
          ${clientBlock.email ? `<div>${escapeHtml(clientBlock.email)}</div>` : ""}
          ${clientBlock.phone ? `<div>${escapeHtml(clientBlock.phone)}</div>` : ""}
        </div>
        <div>
          <div class="label">Prepared by</div>
          <div>${escapeHtml(meta.preparedBy || brand.companyName || "—")}</div>
          ${real(brand.contact?.phone) ? `<div>${escapeHtml(real(brand.contact.phone))}</div>` : ""}
          ${real(brand.contact?.email) ? `<div>${escapeHtml(real(brand.contact.email))}</div>` : ""}
          ${real(brand.contact?.website) ? `<div>${escapeHtml(real(brand.contact.website))}</div>` : ""}
        </div>
      </div>
    </section>

    ${scopeHtml}

    <section class="section">
      <h2>Recommended Solution</h2>
      ${groupSections}
    </section>

    <section class="section">
      <h2>Investment Summary</h2>
      <div class="totals">
        <div class="totals-row"><span>Subtotal</span><span>${money(totals.subtotal)}</span></div>
        ${totals.tax !== null ? `<div class="totals-row"><span>Estimated Tax</span><span>${money(totals.tax)}</span></div>` : ""}
        <div class="totals-row grand"><span>Total Investment</span><span>${money(totals.total)}</span></div>
      </div>
      ${notes ? `<p class="note">${escapeHtml(notes)}</p>` : ""}
    </section>

    <section class="section">
      <h2>Terms</h2>
      <ol class="terms">${termsHtml}</ol>
    </section>

    <section class="section">
      <h2>Acceptance</h2>
      <div class="acceptance">
        <div><div class="sig-line"></div><div class="sig-label">Client signature</div></div>
        <div><div class="sig-line"></div><div class="sig-label">Date</div></div>
      </div>
      <div class="acceptance">
        <div><div class="sig-line"></div><div class="sig-label">Printed name</div></div>
        <div><div class="sig-line"></div><div class="sig-label">Proposal #</div></div>
      </div>
    </section>

    <footer class="colophon">
      <span>${escapeHtml(brand.footerNote || "")}</span>
      ${brand.trustLine ? `<span>${escapeHtml(brand.trustLine)}</span>` : ""}
      <span>${escapeHtml(brand.companyName || "")}${real(brand.contact?.address) ? ` · ${escapeHtml(real(brand.contact.address))}` : ""}</span>
    </footer>
  </div>
</body>
</html>`;
}

function pickPrimaryContact(opportunity) {
  const contacts = opportunity.contacts || [];
  return contacts.find((ct) => ct.isPrimary) || contacts[0] || null;
}

async function loadFromQuote(quoteId) {
  const { createDToolsClient } = require("./dtools_api_client");
  const client = createDToolsClient({ timeoutMs: 60000 });
  const quote = await client.get("Quotes/GetQuote", { id: quoteId }).then((r) => r.data);
  const opportunity = await client
    .get("Opportunities/GetOpportunity", { id: quote.opportunityId })
    .then((r) => r.data);

  const items = (quote.items || []).map((item) => ({
    name: item.name,
    description: item.description,
    group: item.group || item.location || item.system || null,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    type: item.type
  }));

  const subtotal = items.reduce((acc, i) => acc + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0);
  const tax = (quote.taxes || []).reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
  const total = Number(quote.price) || subtotal + tax;

  return {
    opportunity,
    items,
    totals: { subtotal, tax: tax || null, total },
    number: quote.number || opportunity.number,
    validUntil: quote.validUntilDate || null,
    notes: null,
    extraInfo: null
  };
}

async function loadFromOpportunity(args) {
  let opportunity;
  if (args.opportunityFile) {
    const snapshot = readJsonFile(path.resolve(args.opportunityFile), "Opportunity snapshot");
    opportunity = snapshot.opportunity || snapshot;
  } else {
    const { createDToolsClient } = require("./dtools_api_client");
    const client = createDToolsClient({ timeoutMs: 60000 });
    opportunity = await client
      .get("Opportunities/GetOpportunity", { id: args.opportunityId })
      .then((r) => r.data);
  }
  if (!opportunity || !opportunity.id) {
    fail("Opportunity data has no id — pass a snapshot from dtools-data/info/ or a valid --opportunity-id.");
  }

  const payload = readJsonFile(path.resolve(args.itemsFile), "Selected items file");
  validateItemsPayload(payload, args.itemsFile);

  let extraInfo = null;
  if (args.extraInfoFile) {
    extraInfo = readJsonFile(path.resolve(args.extraInfoFile), "Extra info file");
  } else {
    const guess = path.join(REPO_ROOT, "dtools-data", "info", `${opportunity.id}_info.json`);
    if (fs.existsSync(guess)) extraInfo = JSON.parse(fs.readFileSync(guess, "utf8"));
  }

  const subtotal = payload.items.reduce(
    (acc, i) => acc + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0),
    0
  );
  const tax = payload.taxRate !== undefined ? subtotal * Number(payload.taxRate) : null;
  const total = subtotal + (tax || 0);
  const validDays = Number(payload.validDays) || null;

  return {
    opportunity,
    items: payload.items,
    totals: { subtotal, tax, total },
    number: opportunity.number,
    validUntil: validDays ? new Date(Date.now() + validDays * 86400000) : null,
    notes: payload.notes || null,
    extraInfo
  };
}

async function main() {
  const quoteId = readArg("--quote-id");
  const opportunityFile = readArg("--opportunity-file");
  const opportunityId = readArg("--opportunity-id");
  const itemsFile = readArg("--items");

  if (!quoteId && !(itemsFile && (opportunityFile || opportunityId))) {
    fail([
      "No input mode selected. Use ONE of:",
      "  --quote-id <QUOTE_ID>",
      "  --opportunity-file <dtools-data/info/P-XXXX.json> --items <selected_items.json>",
      "  --opportunity-id <OPPORTUNITY_ID> --items <selected_items.json>"
    ]);
  }

  const brandPath = path.resolve(readArg("--brand", DEFAULT_BRAND_PATH));
  const brand = readJsonFile(brandPath, "Brand config");

  const data = quoteId
    ? await loadFromQuote(quoteId)
    : await loadFromOpportunity({ opportunityFile, opportunityId, itemsFile, extraInfoFile: readArg("--extra-info-file") });

  const { opportunity } = data;
  const contact = pickPrimaryContact(opportunity);
  const owner = (opportunity.resources || []).find((r) => r.name === opportunity.owner) || null;

  const validUntil =
    data.validUntil ||
    new Date(Date.now() + (Number(brand.validDays) || 30) * 86400000);

  const html = renderHtml({
    brand,
    meta: {
      number: data.number,
      projectName: opportunity.name,
      preparedAt: new Date(),
      validUntil,
      preparedBy: owner ? `${owner.name}${owner.title ? `, ${owner.title}` : ""} — ${brand.companyName || ""}` : null
    },
    clientBlock: {
      name: opportunity.clientName,
      siteAddress: buildAddress(opportunity.siteAddress),
      email: contact?.email || null,
      phone: contact?.phone || contact?.mobile || null
    },
    scope: extraInfoToScope(data.extraInfo),
    items: data.items,
    totals: data.totals,
    notes: data.notes
  });

  const outDir = path.resolve(readArg("--out-dir", DEFAULT_OUT_DIR));
  fs.mkdirSync(outDir, { recursive: true });
  const safeNumber = String(data.number || opportunity.id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const outputPath = path.resolve(outDir, readArg("--out-file") || `proposal_${safeNumber}.html`);
  fs.writeFileSync(outputPath, html, "utf8");

  console.log(
    JSON.stringify(
      { ok: true, outputPath, itemCount: data.items.length, subtotal: data.totals.subtotal, total: data.totals.total },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      { ok: false, error: err.message, status: err.status, endpoint: err.endpoint, responseBody: err.responseBody },
      null,
      2
    )
  );
  process.exit(1);
});
