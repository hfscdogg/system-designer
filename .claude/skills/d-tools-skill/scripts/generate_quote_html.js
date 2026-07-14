#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const { createDToolsClient } = require("./dtools_api_client");

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
  if (Number.isNaN(n)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(n);
}

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function readArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function sum(arr, key) {
  return arr.reduce((acc, item) => acc + (Number(item[key]) || 0), 0);
}

function computeLineAmount(item) {
  const qty = Number(item.quantity) || 0;
  const unit = Number(item.unitPrice) || 0;
  return qty * unit;
}

function buildAddress(a) {
  if (!a) return "-";
  const parts = [
    a.name,
    a.addressLine1,
    a.addressLine2,
    [a.city, a.state].filter(Boolean).join(", "),
    a.postalCode,
    a.country
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "-";
}

async function enrichProducts(client, items) {
  const out = [];
  for (const item of items) {
    if ((item.type || "").toLowerCase() !== "product") {
      out.push({ itemId: item.id, match: null });
      continue;
    }

    const queries = [item.partNumber, item.model, item.name].filter(Boolean);
    let best = null;

    for (const q of queries) {
      try {
        const res = await client.get("Products/GetProducts", {
          search: q,
          page: 1,
          pageSize: 5,
          includeInactive: true
        });
        const rows = res.data.products || [];
        if (!rows.length) continue;

        const exact = rows.find((p) => {
          const pn = (p.partNumber || "").toLowerCase();
          const m = (p.model || "").toLowerCase();
          const n = (p.name || "").toLowerCase();
          const needle = String(q).toLowerCase();
          return pn === needle || m === needle || n === needle;
        });

        best = exact || rows[0];
        if (exact) break;
      } catch (_) {
        // Continue best-effort enrichment without breaking quote generation.
      }
    }

    out.push({
      itemId: item.id,
      match: best
        ? {
            id: best.id,
            brand: best.brand,
            model: best.model,
            partNumber: best.partNumber,
            category: best.category,
            supplier: best.supplier,
            msrp: best.msrp,
            unitCost: best.unitCost,
            unitPrice: best.unitPrice
          }
        : null
    });
  }
  return out;
}

async function getHistoricalQuotes(client, opportunity) {
  const own = await client.get("Quotes/GetQuotes", { opportunityId: opportunity.id });
  const ownQuotes = own.data.quotes || [];

  let clientHistory = [];
  try {
    const oppsRes = await client.get("Opportunities/GetOpportunities", {
      clientIds: [opportunity.clientId],
      includeArchived: false,
      page: 1,
      pageSize: 30,
      sort: "-modifiedDate"
    });
    const opps = (oppsRes.data.opportunities || []).filter((o) => o.id !== opportunity.id).slice(0, 8);
    for (const opp of opps) {
      try {
        const qRes = await client.get("Quotes/GetQuotes", { opportunityId: opp.id });
        const qs = qRes.data.quotes || [];
        for (const q of qs) {
          clientHistory.push({
            quoteId: q.id,
            number: q.number,
            name: q.name,
            state: q.state,
            systemState: q.systemState,
            price: q.price,
            servicePrice: q.servicePrice,
            modifiedDate: q.modifiedDate,
            opportunityName: opp.name,
            opportunityNumber: opp.number
          });
        }
      } catch (_) {
        // Skip faulty rows; keep report generation resilient.
      }
    }
  } catch (_) {
    // Optional section only.
  }

  clientHistory = clientHistory
    .sort((a, b) => new Date(b.modifiedDate || 0) - new Date(a.modifiedDate || 0))
    .slice(0, 12);

  return { ownQuotes, clientHistory };
}

function renderHtml(payload) {
  const {
    generatedAt,
    quote,
    opportunity,
    client,
    lineItems,
    productEnrichment,
    financial,
    ownQuoteHistory,
    clientQuoteHistory
  } = payload;

  const enrichMap = new Map(productEnrichment.map((e) => [e.itemId, e.match]));

  const rowsHtml = lineItems
    .map((item, idx) => {
      const amount = computeLineAmount(item);
      const lookup = enrichMap.get(item.id);
      const details = [
        item.brand || lookup?.brand || null,
        item.model || lookup?.model || null,
        item.partNumber || lookup?.partNumber || null
      ]
        .filter(Boolean)
        .join(" | ");

      const desc = stripHtml(item.description);
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>
            <div class="item-name">${escapeHtml(item.name || "-")}</div>
            <div class="item-meta">${escapeHtml(details || "No manufacturer/model metadata")}</div>
            <div class="item-desc">${escapeHtml(desc || "-")}</div>
          </td>
          <td>${escapeHtml(item.type || "-")}</td>
          <td>${escapeHtml(item.quantity ?? "-")}</td>
          <td>${money(item.unitPrice)}</td>
          <td>${money(amount)}</td>
        </tr>`;
    })
    .join("\n");

  const productLookupHtml = lineItems
    .filter((i) => (i.type || "").toLowerCase() === "product")
    .map((item) => {
      const match = enrichMap.get(item.id);
      return `
        <tr>
          <td>${escapeHtml(item.name || "-")}</td>
          <td>${escapeHtml(item.partNumber || item.model || "-")}</td>
          <td>${escapeHtml(match?.category || "-")}</td>
          <td>${escapeHtml(match?.supplier || "-")}</td>
          <td>${money(match?.msrp)}</td>
          <td>${money(match?.unitPrice)}</td>
        </tr>`;
    })
    .join("\n");

  const ownHistoryHtml = ownQuoteHistory
    .map(
      (q) => `
      <tr>
        <td>${escapeHtml(q.number || "-")}</td>
        <td>${escapeHtml(q.name || "-")}</td>
        <td>${escapeHtml(q.state || "-")}</td>
        <td>${money(q.price)}</td>
        <td>${fmtDate(q.modifiedDate)}</td>
      </tr>`
    )
    .join("\n");

  const clientHistoryHtml = clientQuoteHistory
    .map(
      (q) => `
      <tr>
        <td>${escapeHtml(q.opportunityNumber || "-")}</td>
        <td>${escapeHtml(q.number || "-")}</td>
        <td>${escapeHtml(q.name || "-")}</td>
        <td>${escapeHtml(q.state || "-")}</td>
        <td>${money(q.price)}</td>
      </tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>INTERNAL Quote Report ${escapeHtml(quote.number || quote.id)}</title>
  <style>
    :root {
      --ink: #12202f;
      --muted: #5a6b7f;
      --line: #dce3ea;
      --paper: #ffffff;
      --soft: #f4f7fb;
      --brand: #1155cc;
      --accent: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      color: var(--ink);
      background: linear-gradient(180deg, #f2f6fb 0%, #e9eff8 100%);
      padding: 28px;
    }
    .page {
      max-width: 1100px;
      margin: 0 auto;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 18px 50px rgba(17, 35, 63, 0.08);
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      padding: 28px;
      background: linear-gradient(135deg, #0e2a52 0%, #144d8b 55%, #0f766e 100%);
      color: #fff;
    }
    .title { margin: 0; font-size: 28px; letter-spacing: 0.2px; }
    .subtitle { margin-top: 8px; opacity: 0.9; font-size: 14px; }
    .badge {
      display: inline-block;
      background: rgba(255, 255, 255, 0.18);
      border: 1px solid rgba(255, 255, 255, 0.35);
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      padding: 20px 28px;
      background: var(--soft);
      border-bottom: 1px solid var(--line);
    }
    .card {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
    }
    .card h4 {
      margin: 0 0 8px 0;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .card p { margin: 0; font-size: 15px; }
    .section { padding: 20px 28px; border-bottom: 1px solid var(--line); }
    .section h3 { margin: 0 0 12px 0; font-size: 18px; }
    .meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .meta div { padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
    .meta strong { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; }
    thead th {
      text-align: left;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      border-bottom: 1px solid var(--line);
      padding: 10px;
      background: #f9fbfe;
    }
    tbody td {
      border-bottom: 1px solid #edf1f6;
      padding: 10px;
      vertical-align: top;
      font-size: 13px;
    }
    .item-name { font-weight: 600; margin-bottom: 4px; }
    .item-meta { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    .item-desc { color: #364658; line-height: 1.4; }
    .totals {
      margin-left: auto;
      width: 360px;
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
    }
    .totals-row {
      display: flex;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      font-size: 14px;
    }
    .totals-row:last-child { border-bottom: 0; font-weight: 700; background: #f3f9f8; color: #0f504d; }
    .footer-note {
      padding: 20px 28px 30px 28px;
      color: var(--muted);
      font-size: 12px;
      background: #fbfdff;
    }
    @media (max-width: 900px) {
      body { padding: 10px; }
      .grid { grid-template-columns: 1fr 1fr; }
      .meta { grid-template-columns: 1fr; }
      .totals { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="topbar">
      <div>
        <h1 class="title">Internal Quote Report</h1>
        <div class="subtitle">${escapeHtml(quote.name || "Quote")} | Quote #${escapeHtml(quote.number || "-")}</div>
        <div class="badge" style="margin-top:10px; background:#b45309; border-color:#b45309;">INTERNAL — NOT FOR CLIENT DISTRIBUTION</div>
      </div>
      <div>
        <div class="badge">State: ${escapeHtml(quote.state || "-")}</div>
        <div class="subtitle">Generated ${escapeHtml(generatedAt)}</div>
      </div>
    </header>

    <section class="grid">
      <div class="card"><h4>Opportunity</h4><p>${escapeHtml(opportunity.number || "-")} | ${escapeHtml(opportunity.name || "-")}</p></div>
      <div class="card"><h4>Client</h4><p>${escapeHtml(client?.name || opportunity.clientName || "-")}</p></div>
      <div class="card"><h4>Quote Value</h4><p>${money(quote.price)}</p></div>
      <div class="card"><h4>Valid Until</h4><p>${fmtDate(quote.validUntilDate)}</p></div>
    </section>

    <section class="section">
      <h3>Project Context</h3>
      <div class="meta">
        <div><strong>Billing Address</strong>${escapeHtml(buildAddress(client?.billingAddress || opportunity.billingAddress))}</div>
        <div><strong>Site Address</strong>${escapeHtml(buildAddress(opportunity.siteAddress || client?.siteAddresses?.[0]))}</div>
        <div><strong>Project Type</strong>${escapeHtml(opportunity.projectType || "-")}</div>
        <div><strong>Fulfillment Location</strong>${escapeHtml(quote.fulfillmentLocation || opportunity.fulfillmentLocation || "-")}</div>
      </div>
    </section>

    <section class="section">
      <h3>Line Items</h3>
      <table>
        <thead>
          <tr>
            <th>#</th><th>Item</th><th>Type</th><th>Qty</th><th>Unit Price</th><th>Line Total</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || "<tr><td colspan='6'>No line items yet</td></tr>"}
        </tbody>
      </table>
    </section>

    <section class="section">
      <h3>Product Lookup Insights</h3>
      <table>
        <thead>
          <tr><th>Quoted Item</th><th>Lookup Key</th><th>Category</th><th>Supplier</th><th>MSRP</th><th>Catalog Price</th></tr>
        </thead>
        <tbody>
          ${productLookupHtml || "<tr><td colspan='6'>No product rows in this quote</td></tr>"}
        </tbody>
      </table>
    </section>

    <section class="section">
      <h3>Financial Summary</h3>
      <div class="totals">
        <div class="totals-row"><span>Material/Service Subtotal</span><span>${money(financial.subtotal)}</span></div>
        <div class="totals-row"><span>Tax (from quote records)</span><span>${money(financial.taxTotal)}</span></div>
        <div class="totals-row"><span>Service Price</span><span>${money(quote.servicePrice)}</span></div>
        <div class="totals-row"><span>Total Quoted Value</span><span>${money(quote.price)}</span></div>
      </div>
    </section>

    <section class="section">
      <h3>Previous Quotes (Same Opportunity)</h3>
      <table>
        <thead><tr><th>Quote #</th><th>Name</th><th>State</th><th>Price</th><th>Modified</th></tr></thead>
        <tbody>
          ${ownHistoryHtml || "<tr><td colspan='5'>No additional quote versions found</td></tr>"}
        </tbody>
      </table>
    </section>

    <section class="section">
      <h3>Previous Quotes (Client History)</h3>
      <table>
        <thead><tr><th>Opportunity #</th><th>Quote #</th><th>Name</th><th>State</th><th>Price</th></tr></thead>
        <tbody>
          ${clientHistoryHtml || "<tr><td colspan='5'>No client quote history found</td></tr>"}
        </tbody>
      </table>
    </section>

    <section class="section">
      <h3>Acceptance</h3>
      <p>Client Name: _______________________</p>
      <p>Signature: _________________________</p>
      <p>Date: ______________________________</p>
    </section>

    <footer class="footer-note">
      INTERNAL REPORT — contains cost, supplier, and client-history data. Do not send to the customer;
      use generate_proposal_html.js for the client-facing proposal. Auto-generated outside D-Tools
      using live D-Tools API data; final acceptance is manually mirrored into D-Tools.
    </footer>
  </div>
</body>
</html>`;
}

async function main() {
  const quoteId = readArg("--quote-id");
  const outDir = readArg("--out-dir", path.resolve(__dirname, "../../../../generated_quotes"));
  const outFileArg = readArg("--out-file");

  if (!quoteId) {
    console.error(
      "Usage: node .claude/skills/d-tools-skill/scripts/generate_quote_html.js --quote-id <QUOTE_ID> [--out-dir generated_quotes] [--out-file filename.html]"
    );
    process.exit(1);
  }

  const client = createDToolsClient({ timeoutMs: 60000 });

  const quote = await client.get("Quotes/GetQuote", { id: quoteId }).then((r) => r.data);
  const opportunity = await client.get("Opportunities/GetOpportunity", { id: quote.opportunityId }).then((r) => r.data);

  let clientRecord = null;
  if (opportunity.clientId) {
    try {
      clientRecord = await client.get("Clients/GetClient", { id: opportunity.clientId }).then((r) => r.data);
    } catch (_) {
      clientRecord = null;
    }
  }

  const lineItems = quote.items || [];
  const productEnrichment = await enrichProducts(client, lineItems);
  const { ownQuotes, clientHistory } = await getHistoricalQuotes(client, opportunity);

  const subtotal = lineItems.reduce((acc, item) => acc + computeLineAmount(item), 0);
  const taxTotal = sum(quote.taxes || [], "amount");

  const html = renderHtml({
    generatedAt: new Date().toLocaleString("en-US"),
    quote,
    opportunity,
    client: clientRecord,
    lineItems,
    productEnrichment,
    ownQuoteHistory: ownQuotes,
    clientQuoteHistory: clientHistory,
    financial: { subtotal, taxTotal }
  });

  fs.mkdirSync(outDir, { recursive: true });
  const safeNumber = String(quote.number || quote.id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const outputPath = path.resolve(outDir, outFileArg || `quote_${safeNumber}.html`);
  fs.writeFileSync(outputPath, html, "utf8");

  console.log(JSON.stringify({ ok: true, quoteId, outputPath, lineItemCount: lineItems.length }, null, 2));
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err.message,
        status: err.status,
        endpoint: err.endpoint,
        responseBody: err.responseBody
      },
      null,
      2
    )
  );
  process.exit(1);
});
