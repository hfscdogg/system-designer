---
name: d-tools-skill
description: Use for D-Tools Cloud work in this repo - creating/updating opportunities via the D-Tools Cloud API, saving local opportunity/product memory under dtools-data/, and generating client-facing HTML proposals or internal quote reports under generated_quotes/. Trigger on any mention of D-Tools, opportunities, quotes, or proposals.
---

# D-Tools Skill

Drives the Henry sales workflow: collect project requirements in conversation, keep a D-Tools
opportunity as the source of truth, remember everything the D-Tools schema can't hold, and — only
after the customer approves — generate a polished proposal.

All paths below are relative to the repository root. Scripts live in
`.claude/skills/d-tools-skill/scripts/`.

## Setup (check once per session)

1. `DTOOLS_API_KEY` and `DTOOLS_BASIC_AUTH` must both be set in the environment. Verify with:
   `node -e "console.log((process.env.DTOOLS_API_KEY?'':'MISSING DTOOLS_API_KEY ')+(process.env.DTOOLS_BASIC_AUTH?'':'MISSING DTOOLS_BASIC_AUTH')||'ok')"`
   - If either is missing, STOP and tell the user to add it to this cloud environment's
     variables (Claude Code environment settings). Never write either value into any file.
   - `DTOOLS_API_KEY` is the tenant secret. `DTOOLS_BASIC_AUTH` is D-Tools' **published fixed**
     `Basic ...` Authorization value from their Cloud API Authentication docs
     (see `references/d_tool_api.md`) — kept out of the repo so secret scanners stay clean.
2. The environment must allow outbound HTTPS to `dtcloudapi.d-tools.cloud`.
3. Recommended runtime model for sessions that *use* this skill: `claude-sonnet-5`
   (`claude-haiku-4-5` is fine for pure re-render runs). Skill design changes are done on a
   frontier model.

## State persistence (cloud containers are ephemeral)

Local memory lives in the repo:

- `dtools-data/info/` — opportunity snapshots (`<number>.json`), extra info
  (`<opportunity_id>_info.json`), and `manifest.json`
- `dtools-data/product_info/` — product extra info (`<product_id>_info.json`) and `manifest.json`
- `generated_quotes/` — generated proposal/report HTML

**Rule: after ANY write to these folders, commit and push on the current session branch:**

```bash
git add dtools-data generated_quotes && git commit -m "Update D-Tools local records" && git push -u origin HEAD
```

If you skip this, the data is lost when the container is reclaimed.

## Workflow (phases in order — do not skip ahead)

Full conversational rules: `references/dtools-henry-workflow.md`. Condensed checklist:

1. **Create the opportunity.** Greet the customer; collect at minimum `clientName`,
   `opportunityName`, and contact/address basics (full field list in the reference). Create it
   via the API client, then snapshot:
   `node .claude/skills/d-tools-skill/scripts/sync_opportunity_info.js --id <OPPORTUNITY_ID>`
2. **Enrich continuously.** Ask 1–2 questions at a time; update the opportunity after every
   answer and re-run the sync script after every create/update.
3. **Store extra info.** Anything that doesn't fit the D-Tools schema goes to
   `dtools-data/info/<opportunity_id>_info.json` via
   `node .claude/skills/d-tools-skill/scripts/save_opportunity_extra_info.js --id <ID> --json '<JSON>'`.
   Product-level notes go to `dtools-data/product_info/` (see `scripts/product_info_store.js`).
4. **Check completeness before quoting.** Run
   `node .claude/skills/d-tools-skill/scripts/validate_opportunity.js --number <P-XXXX>`
   and ask the customer about every field it lists as missing. Do not proceed while it exits
   non-zero.
5. **Recommend products** — only products that exist in D-Tools (search with
   `Products/GetProducts`). Explain why each fits. Write the selection to a
   `selected_items.json` (schema below).
6. **Confirm.** Present the solution; iterate until the customer explicitly approves.
7. **Generate the proposal** (only after explicit approval — see next section).

## Generating documents

Two generators with different audiences — never mix them up:

### Client-facing proposal (branded, safe to send to the customer)

```bash
# From a live D-Tools quote:
node .claude/skills/d-tools-skill/scripts/generate_proposal_html.js --quote-id <QUOTE_ID>

# From an opportunity + selected items (the common case — the public API cannot create quotes):
node .claude/skills/d-tools-skill/scripts/generate_proposal_html.js \
  --opportunity-file dtools-data/info/<P-XXXX>.json \
  --extra-info-file dtools-data/info/<opportunity_id>_info.json \
  --items <selected_items.json>
```

Branding comes from `.claude/skills/d-tools-skill/brand/livewire.json` (logo, colors, company
block, terms). It contains **no** cost, MSRP, supplier, or quote-history data and is print/PDF
ready (browser print → clean PDF).

`selected_items.json` schema (validated by the generator; it prints exactly what's wrong on
failure):

```json
{
  "items": [
    {
      "name": "Alarm.com ADC-V516",
      "description": "Indoor 1080p Wi-Fi camera, live view only",
      "group": "Gaming Room",
      "quantity": 1,
      "unitPrice": 163.98,
      "type": "Product"
    }
  ],
  "taxRate": 0.0825,
  "validDays": 30,
  "notes": "Optional short note shown under the summary"
}
```

Required per item: `name`, `quantity`, `unitPrice`. Optional: `description`, `group` (used for
room/system grouping), `type` (`Product`/`Labor`/`Service`).

### Internal quote report (NOT for clients)

```bash
node .claude/skills/d-tools-skill/scripts/generate_quote_html.js --quote-id <QUOTE_ID>
```

Data-rich review page (MSRP, supplier, catalog price, client quote history). Clearly watermarked
INTERNAL — never send it to a customer.

## API quick facts

- Client: `scripts/dtools_api_client.js` → `createDToolsClient().get/post/put(endpoint, ...)`
- Read+write: Clients, Opportunities. Read-only: Quotes, ChangeOrders, PurchaseOrders,
  ServiceContracts, Files, TimeEntries. Partial update: Products, Projects.
- There is **no** public quote-create/update endpoint — that is why proposals are generated
  externally and finalized quotes are mirrored into D-Tools by a human.
- Endpoint details on demand: `references/dtools_swagger_reference.md` (behavior),
  `references/dtools_swagger.json` (full swagger — search it, never load it whole),
  `references/d_tool_api.md` (auth, limits, docs links).

## Custom questions overlay

`custom_questions.md` (in this skill folder) is an optional human-edited question guide. If it is
empty, ignore it. If it has content, use it to refine question order/interpretation; the rules in
this file and the workflow reference always win on conflict.
