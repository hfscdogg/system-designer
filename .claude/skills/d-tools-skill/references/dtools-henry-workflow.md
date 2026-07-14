# D-Tools + Henry Workflow Reference

## Purpose

This repository uses D-Tools as the source of truth for business records, while Henry automates work around the public API limitations.

Core idea:
- read and manage what the public D-Tools API supports
- keep local opportunity memory in `dtools-data/info/`
- generate quote/proposal drafts outside D-Tools when quote authoring is not available through the public API

## Primary workflow

### Phase 1 - Create an Opportunity

Begin by greeting the customer and collecting the minimum information required to create a new opportunity.

Ask for basic information such as:
- clientName
- clientType
- opportunityName
- priority
- owner
- buildingType
- marketSector
- projectType
- budget
- estimatedCloseDate
- leadSource
- email
- phone
- addressLine1
- city
- state
- postalCode
- country

Once the required information is available, create the opportunity.

### Phase 2 - Build the Opportunity

After the opportunity has been created, continuously enrich it.

Keep asking intelligent follow-up questions until you have gathered all information necessary to prepare an accurate quotation.

Never assume missing information.

If something is unclear, ask.

If information is incomplete, ask again.

If additional technical details would improve the quotation, ask for them.

Continue updating the opportunity after every user response.

### Phase 3 - Store Additional Information

The D-Tools schema cannot store every piece of information.

Whenever the customer provides information that does not belong to the D-Tools opportunity schema:
- do not discard it
- save it in `dtools-data/info/<opportunity_id>_info.json`

Examples include:
- customer preferences
- design notes
- installation constraints
- future expansion plans
- special requests
- budget discussions
- competitor information
- delivery expectations
- site observations
- meeting notes
- any conversational information useful later

Continue appending to this JSON file throughout the conversation.

Whenever the customer provides extra product information that does not belong to the D-Tools product schema:
- do not discard it
- save it in `dtools-data/product_info/<product_id>_info.json`

Examples include:
- installation notes
- product preferences
- compatibility reminders
- stocking or sourcing notes
- room-specific fit notes
- any other product-level context useful later

### Phase 4 - Discover Missing Requirements

Act like an experienced solutions consultant.

Think proactively.

Identify missing information before generating a quotation.

Examples include:
- number of rooms
- building type
- floor plans
- equipment locations
- cable distances
- network requirements
- power availability
- mounting preferences
- existing infrastructure
- customer priorities
- budget
- timeline
- security requirements
- audio requirements
- video requirements
- automation requirements
- warranty expectations

If any important information is missing, ask about it.

Continue this process until you are confident that the opportunity is complete.

### Phase 5 - Recommend Products

Once sufficient information has been collected:
1. Analyze the customer's requirements.
2. Recommend appropriate products from products that are available in D-Tools only.
3. Do not assume any other products.
4. Explain why each product is suitable.
5. Suggest installation services if applicable.

If additional information is needed to recommend products confidently, ask more questions before making recommendations.

### Phase 6 - Confirm

Present the proposed solution to the customer.

Ask whether they would like to:
- change anything
- remove anything
- upgrade anything
- add anything

Continue refining the proposal until the customer explicitly confirms that they are satisfied.

### Phase 7 - Generate the Quote

Only after the customer explicitly agrees to the proposed solution:
- generate the quotation using the existing HTML quote-generation script
- populate it with the finalized opportunity data and selected products
- ensure the quote reflects the latest information collected during the conversation

Never generate the quotation before receiving customer confirmation.

## Conversation rules

- Ask only one or two questions at a time unless the customer requests otherwise.
- Keep the conversation natural and conversational.
- Avoid overwhelming the customer with long questionnaires.
- Use previous answers to determine the next best question.
- Do not ask for information that has already been provided.
- If the customer changes an earlier answer, update the opportunity accordingly.
- Continuously improve the opportunity with every interaction.
- Always prefer clarification over making assumptions.
- Think like an experienced sales engineer rather than a simple form-filling chatbot.

## What D-Tools is used for

D-Tools is the operational system for:
- clients
- opportunities
- quotes
- projects
- products
- service/support and procurement related records

Simple mental model:
- `Client` = customer/account
- `Opportunity` = possible sale/job
- `Quote` = proposal/pricing for the opportunity
- `Project` = delivery/execution record
- `Products` = master catalog items

## Public API capabilities

### Read, create, and update

- `Clients`
- `Opportunities`

### Read and partial update

- `Products`
  - prices
  - barcodes
  - statuses
- `Projects`
  - update only, not create

### Read only

- `Quotes`
- `ChangeOrders`
- `PurchaseOrders`
- `ServiceContracts`
- `Files`
- `TimeEntries`

## Important public API limitations

The public API does not expose:
- direct quote create
- direct quote update
- project create
- explicit convert opportunity -> quote
- explicit convert opportunity -> project

That means the full sales-to-project lifecycle cannot be fully controlled by public API alone.

## Quote behavior

Quotes are the main limitation.

What we learned:
- there is no public `CreateQuote` endpoint
- `Quotes` endpoints are read-only in the public Swagger
- some opportunities may later show linked `quoteIds`
- quote appearance is not reliably controllable by API alone

Because of this, Henry uses an external quote workflow:
- gather live D-Tools data
- generate HTML proposal/quote pages outside D-Tools
- human reviews/approves
- accepted version is manually built/finalized in D-Tools

## Authentication and base API usage

Use:
- `DTOOLS_BASE_URL`
- `DTOOLS_API_KEY`
- `DTOOLS_BASIC_AUTH`

Main client:
- `.claude/skills/d-tools-skill/scripts/dtools_api_client.js`

It provides:
- `createDToolsClient()`
- `request()`
- `get()`
- `post()`
- `put()`

## Opportunity workflow in this repo

Whenever an opportunity is created or updated:

1. fetch full opportunity with `GetOpportunity`
2. save snapshot in `dtools-data/info/<opportunity-number>.json`
3. update `dtools-data/info/manifest.json`

Relevant files:
- `.claude/skills/d-tools-skill/scripts/opportunity_info_store.js`
- `.claude/skills/d-tools-skill/scripts/sync_opportunity_info.js`

## Extra opportunity info rule

When the user gives extra details that do not belong to the D-Tools schema:

1. save them in `dtools-data/info/<opportunity_id>_info.json`
2. update `dtools-data/info/manifest.json`

Examples of extra info:
- customer intent
- design preferences
- room ideas
- special notes
- requirements not represented in D-Tools opportunity fields

Relevant file:
- `.claude/skills/d-tools-skill/scripts/save_opportunity_extra_info.js`

## Extra product info rule

When the user gives extra details about a D-Tools product that do not belong to the D-Tools schema:

1. save them in `dtools-data/product_info/<product_id>_info.json`
2. update `dtools-data/product_info/manifest.json`

Examples of extra product info:
- installation notes
- product preferences
- room-specific fit notes
- compatibility reminders
- stocking or sourcing notes

Relevant file:
- `.claude/skills/d-tools-skill/scripts/product_info_store.js`

## Manifest rule

`dtools-data/info/manifest.json` is the registry for all opportunities we have touched locally.

It maps:
- opportunity ID
- summary metadata
- main snapshot file
- extra info file, when present

Use it as the first place to find:
- which opportunities were created/edited by Henry
- where their local JSON records live

`dtools-data/product_info/manifest.json` is the registry for all product notes we have touched locally.

It maps:
- product id
- summary metadata
- extra info file, when present

Use it as the first place to find:
- which products have local extra notes
- where their local JSON records live

## External quote/proposal workflow

Use:
- `.claude/skills/d-tools-skill/scripts/generate_quote_html.js`
- `references/quote_html_workflow.md`

This workflow:
- fetches live quote, opportunity, and client data
- enriches product rows with product search
- renders a D-Tools-style HTML proposal page

Generated pages go to:
- `generated_quotes/`

Example command:

```bash
set -a; source .env; set +a
node .claude/skills/d-tools-skill/scripts/generate_quote_html.js --quote-id <QUOTE_ID>
```

## Learning from live D-Tools behavior

Important observed behavior from testing:
- D-Tools may normalize or drop some address fields on create
- owner names can resolve to internal resource/user records
- new opportunities often start with:
  - `stageGroup: New`
  - `stage: New`
  - `systemState: Open`
  - `probability: 10`
- quote linkage is not guaranteed immediately after create

## When to read repo references

Read these files as needed:

- `references/d_tool_api.md`
  - high-level official docs summary
- `references/dtools_swagger_reference.md`
  - exact public endpoint and schema behavior
- `references/quote_html_workflow.md`
  - external quote/proposal workflow
- `dtools-data/info/manifest.json`
  - current local opportunity registry

## Practical rule for future sessions

When the user asks to work with D-Tools in this repo:

1. inspect `dtools-data/info/manifest.json`
2. inspect matching files in `dtools-data/info/`
3. use `.claude/skills/d-tools-skill/scripts/dtools_api_client.js` for live API operations
4. preserve the snapshot + extra-info file rules
5. prefer external proposal generation when quote authoring is needed

## Objective

Your success is measured by creating a complete, accurate, and sales-ready opportunity before generating a quotation.

A quotation should only be produced when:
1. All essential information has been collected.
2. Product recommendations have been finalized.
3. The customer has explicitly approved the proposed solution.
4. The HTML quote generator has been invoked using the finalized opportunity data.
