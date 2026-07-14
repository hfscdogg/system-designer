#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Pre-quote completeness check for a D-Tools opportunity snapshot.
 *
 * Run this BEFORE recommending products or generating a proposal. It prints
 * exactly which fields are missing and what to ask the customer, so the
 * conversation model never has to judge completeness on its own.
 *
 * Usage:
 *   node .claude/skills/d-tools-skill/scripts/validate_opportunity.js --number P-2566
 *   node .claude/skills/d-tools-skill/scripts/validate_opportunity.js --file dtools-data/info/P-2566.json
 *
 * Exit code 0 = quote-ready. Exit code 1 = missing required info (see output).
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const INFO_DIR = path.join(REPO_ROOT, "dtools-data", "info");

function readArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function out(result) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const number = readArg("--number");
const fileArg = readArg("--file");

if (!number && !fileArg) {
  console.error(
    "Usage: node .claude/skills/d-tools-skill/scripts/validate_opportunity.js --number <P-XXXX> | --file <snapshot.json>"
  );
  process.exit(1);
}

const filePath = fileArg
  ? path.resolve(fileArg)
  : path.join(INFO_DIR, `${String(number).replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`);

if (!fs.existsSync(filePath)) {
  out({
    ok: false,
    problems: [
      `Snapshot not found at ${filePath}.`,
      "Run: node .claude/skills/d-tools-skill/scripts/sync_opportunity_info.js --id <OPPORTUNITY_ID> first, then re-run this check."
    ]
  });
}

let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
} catch (err) {
  out({ ok: false, problems: [`Snapshot at ${filePath} is not valid JSON: ${err.message}`] });
}

const opp = snapshot.opportunity || snapshot;
const missing = [];
const warnings = [];

function requireField(value, name, ask) {
  const empty =
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim()) ||
    (typeof value === "number" && value <= 0);
  if (empty) missing.push(`${name} — ${ask}`);
}

requireField(opp.clientName, "clientName", "confirm who the client is.");
requireField(opp.name, "opportunity name", "give the project a short descriptive name.");
requireField(opp.buildingType, "buildingType", "ask whether the site is residential or commercial.");
requireField(opp.projectType, "projectType", "ask if this is a new build, remodel, retrofit, etc.");
requireField(opp.budget, "budget", "ask the customer for a budget range.");
requireField(opp.estimatedCloseDate, "estimatedCloseDate", "ask when they'd like to move forward.");

const contact = (opp.contacts || []).find((ct) => ct.isPrimary) || (opp.contacts || [])[0];
if (!contact) {
  missing.push("primary contact — ask for the customer's name and contact details.");
} else {
  if (!contact.email && !contact.phone && !contact.mobile) {
    missing.push("contact email or phone — ask how to reach the customer.");
  }
}

const site = opp.siteAddress || {};
if (!site.city || !site.state) {
  missing.push("site address city/state — ask where the installation will happen.");
}
if (!site.addressLine1) {
  warnings.push("siteAddress.addressLine1 is empty — a street address makes scheduling and the proposal cleaner.");
}
if (!site.postalCode) {
  warnings.push("siteAddress.postalCode is empty — needed for accurate tax estimates.");
}

const extraInfoPath = path.join(INFO_DIR, `${opp.id}_info.json`);
if (!fs.existsSync(extraInfoPath)) {
  warnings.push(
    `No extra-info file at ${extraInfoPath} — requirements gathered in conversation (rooms, priorities, preferences) should be saved there via save_opportunity_extra_info.js before quoting.`
  );
}

if (missing.length) {
  out({
    ok: false,
    opportunity: { id: opp.id, number: opp.number, name: opp.name },
    problems: missing.map((m) => `MISSING: ${m}`),
    warnings,
    nextStep: "Ask the customer for each MISSING item, update the opportunity in D-Tools, re-run sync_opportunity_info.js, then re-run this check."
  });
}

out({
  ok: true,
  opportunity: { id: opp.id, number: opp.number, name: opp.name },
  message: `Opportunity ${opp.number || opp.id} is quote-ready.`,
  warnings
});
