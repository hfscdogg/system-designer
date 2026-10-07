# External Quote HTML Workflow (D-Tools API Workaround)

This workflow builds D-Tools-style quote/proposal pages outside D-Tools, using live API data.

## Why This Exists

D-Tools public API currently does not expose quote write endpoints, so line-item quote authoring cannot be fully automated in-platform.

This workaround lets your agent:
1. Read live quote/opportunity/client/product data.
2. Generate polished HTML quote drafts automatically.
3. Route for approval outside D-Tools.
4. Manually mirror accepted quotes into D-Tools UI.

## Script

File:
- `.claude/skills/d-tools-skill/scripts/generate_quote_html.js`

## Inputs

Required:
- `--quote-id <QUOTE_ID>`

Optional:
- `--out-dir <DIRECTORY>` (default: `generated_quotes`)
- `--out-file <FILENAME.html>`

## Example

```bash
set -a; source .env; set +a
node .claude/skills/d-tools-skill/scripts/generate_quote_html.js --quote-id db2358ca-c410-4678-bb84-3a60717f28f2
```

Output:
- HTML file generated in `generated_quotes/` by default.

## What The HTML Includes

1. Quote header and status
2. Opportunity and client context
3. Full line-item table (qty, unit price, line total)
4. Product enrichment lookups from live `Products/GetProducts`
5. Financial summary (subtotal, taxes, service price, total)
6. Previous quote versions for same opportunity
7. Previous quote history for same client
8. Signature/acceptance section

## Notes

1. Product enrichment is best-effort. If exact product IDs do not map directly, search-based matching is used.
2. Generated HTML is meant for proposal review and approval, not direct writeback to D-Tools quote records.
3. After acceptance, a human can build/finalize the quote in D-Tools UI.
