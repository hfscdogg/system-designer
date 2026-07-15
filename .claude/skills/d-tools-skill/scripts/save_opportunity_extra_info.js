#!/usr/bin/env node
/* eslint-disable no-console */

const { saveOpportunityExtraInfo } = require("./opportunity_info_store");

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const opportunityId = readArg("--id");
  if (!opportunityId) {
    console.error(
      "Usage: node skills/d-tools-skill/scripts/save_opportunity_extra_info.js --id <OPPORTUNITY_ID> < payload.json"
    );
    process.exit(1);
  }

  const raw = await readStdin();
  if (!raw.trim()) {
    console.error("Expected JSON payload on stdin.");
    process.exit(1);
  }

  const parsed = JSON.parse(raw);
  const outputPath = saveOpportunityExtraInfo(opportunityId, parsed);

  console.log(
    JSON.stringify(
      {
        ok: true,
        opportunityId,
        outputPath
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message
      },
      null,
      2
    )
  );
  process.exit(1);
});
