#!/usr/bin/env node
/* eslint-disable no-console */

const { createDToolsClient } = require("./dtools_api_client");
const { saveOpportunitySnapshot } = require("./opportunity_info_store");

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

async function main() {
  const id = readArg("--id");

  if (!id) {
    console.error("Usage: node .claude/skills/d-tools-skill/scripts/sync_opportunity_info.js --id <OPPORTUNITY_ID>");
    process.exit(1);
  }

  const client = createDToolsClient({ timeoutMs: 60000 });
  const opportunity = await client.get("Opportunities/GetOpportunity", { id }).then((res) => res.data);
  const outputPath = saveOpportunitySnapshot(opportunity);

  console.log(
    JSON.stringify(
      {
        ok: true,
        opportunityId: opportunity.id,
        opportunityNumber: opportunity.number,
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
        error: error.message,
        status: error.status,
        endpoint: error.endpoint,
        responseBody: error.responseBody
      },
      null,
      2
    )
  );
  process.exit(1);
});
