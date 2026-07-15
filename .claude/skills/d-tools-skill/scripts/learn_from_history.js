#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Tier 1 history learning (Phase 5 support).
 *
 * Before recommending products for a new opportunity, look at what similar
 * PAST projects actually sold: scan Won opportunities, pull their Accepted
 * quotes, and emit the line items as grounding for recommendations.
 *
 * Read-only. Never writes to D-Tools.
 *
 * Usage:
 *   node skills/d-tools-skill/scripts/learn_from_history.js \
 *     [--project-type <TYPE>] [--building-type <TYPE>] [--market-sector <SECTOR>] \
 *     [--budget <NUMBER>] [--limit 5] [--max-pages 5] [--include-cost] \
 *     [--out-file <FILE.json>]
 *
 * All filters are optional; with none given it returns the most recent Won
 * projects with itemized accepted quotes. Similarity scoring:
 *   projectType exact +3 · buildingType exact +2 · marketSector exact +1
 *   budget within ±50% +2, within ±100% +1
 * Quotes with no line items are skipped (older UI-built quotes are itemized;
 * some small/API-created ones are not).
 */

const fs = require("fs");
const { createDToolsClient } = require("./dtools_api_client");

function readArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

async function withRetry(fn, tries = 3) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const transient = error.status === 503 || error.status === 429 || !error.status;
      if (!transient) throw error;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function scoreOpportunity(o, target) {
  let score = 0;
  if (target.projectType && norm(o.projectType) === target.projectType) score += 3;
  if (target.buildingType && norm(o.buildingType) === target.buildingType) score += 2;
  if (target.marketSector && norm(o.marketSector) === target.marketSector) score += 1;
  if (target.budget) {
    const basis = Number(o.budget) || Number(o.total) || Number(o.price) || 0;
    if (basis > 0) {
      const ratio = basis / target.budget;
      if (ratio >= 0.5 && ratio <= 1.5) score += 2;
      else if (ratio >= 0.25 && ratio <= 2.0) score += 1;
    }
  }
  return score;
}

function compactItem(item, includeCost) {
  const out = {
    type: item.type,
    name: item.name,
    brand: item.brand,
    model: item.model,
    category: item.category,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    msrp: item.msrp
  };
  if (includeCost) {
    out.unitCost = item.unitCost;
    out.margin = item.margin;
  }
  return out;
}

async function main() {
  const target = {
    projectType: norm(readArg("--project-type")) || null,
    buildingType: norm(readArg("--building-type")) || null,
    marketSector: norm(readArg("--market-sector")) || null,
    budget: Number(readArg("--budget")) || null
  };
  const limit = Number(readArg("--limit", "5"));
  const maxPages = Number(readArg("--max-pages", "5")); // pages of 100 Won opportunities
  const includeCost = hasFlag("--include-cost");
  const outFile = readArg("--out-file");

  const client = createDToolsClient({ timeoutMs: 60000 });

  // 1. Fetch Won opportunities directly (stages filter + page/pageSize are the
  //    real GetOpportunities params — see references/dtools_swagger.json).
  const won = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await withRetry(() =>
      client.get("Opportunities/GetOpportunities", { stages: "Won", page, pageSize: 100 })
    );
    const opps = res.data.opportunities || res.data.items || res.data || [];
    if (!Array.isArray(opps) || opps.length === 0) break;
    won.push(...opps);
    if (opps.length < 100) break;
  }

  // 2. Rank by similarity to the current intake; recency breaks ties.
  const ranked = won
    .map((o) => ({ o, score: scoreOpportunity(o, target) }))
    .sort((a, b) => b.score - a.score);

  // 3. Walk the ranking, keep projects whose accepted quote has line items.
  const projects = [];
  for (const { o, score } of ranked) {
    if (projects.length >= limit) break;
    let quotes;
    try {
      const qres = await withRetry(() => client.get("Quotes/GetQuotes", { opportunityId: o.id }));
      // GetQuotes returns a bare array of quotes.
      quotes = Array.isArray(qres.data) ? qres.data : qres.data.quotes || qres.data.items || [];
    } catch (error) {
      continue;
    }
    const accepted = quotes.filter((q) => q.state === "Accepted");
    const pool = accepted.length ? accepted : quotes;
    for (const qMeta of pool) {
      const full = await withRetry(() => client.get("Quotes/GetQuote", { id: qMeta.id })).then(
        (r) => r.data
      );
      const quote = full.quote || full;
      const items = quote.items || [];
      if (!items.length) continue;
      projects.push({
        similarityScore: score,
        opportunity: {
          number: o.number,
          name: o.name,
          projectType: o.projectType,
          buildingType: o.buildingType,
          marketSector: o.marketSector,
          budget: o.budget,
          total: o.total
        },
        quote: {
          number: quote.number,
          state: quote.state,
          acceptedDate: quote.acceptedDate,
          price: quote.price
        },
        items: items.map((it) => compactItem(it, includeCost))
      });
      break; // one itemized quote per project is enough grounding
    }
  }

  // 4. Aggregate recurring products across the selected projects (distinct
  //    project count — a product repeated within one quote counts once).
  const tally = new Map();
  projects.forEach((p, projectIndex) => {
    for (const it of p.items) {
      if (it.type === "Labor") continue;
      const key = `${it.brand || ""} ${it.model || it.name || ""}`.trim();
      if (!key) continue;
      const row =
        tally.get(key) || { product: key, category: it.category, seenIn: new Set(), totalQty: 0 };
      row.seenIn.add(projectIndex);
      row.totalQty += Number(it.quantity) || 0;
      tally.set(key, row);
    }
  });
  const recurring = [...tally.values()]
    .map(({ seenIn, ...r }) => ({ ...r, projects: seenIn.size }))
    .filter((r) => r.projects >= 2)
    .sort((a, b) => b.projects - a.projects || b.totalQty - a.totalQty);

  const result = {
    ok: true,
    target,
    wonOpportunitiesScanned: won.length,
    projectsReturned: projects.length,
    recurringProducts: recurring,
    projects
  };

  const json = JSON.stringify(result, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, json);
    console.log(JSON.stringify({ ok: true, outFile, projectsReturned: projects.length }, null, 2));
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message,
        status: error.status || null,
        endpoint: error.endpoint || null
      },
      null,
      2
    )
  );
  process.exit(1);
});
