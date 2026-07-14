---
name: d-tools-skill
description: Use when working on the Henry + D-Tools integration in this repository, especially for D-Tools Cloud API usage, opportunity create/update flows, local opportunity snapshot rules under info/, local product extra-info rules under product_info/, manifest tracking, and external HTML quote/proposal generation as a workaround for public API quote limitations.
---

# D-Tools Skill

Use this skill when the user is working with:
- D-Tools Cloud API
- Henry opportunity/quote automation
- local opportunity records in `info/`
- local product notes and extra metadata in `product_info/`
- external quote/proposal generation from D-Tools data

## Primary Workflow

### Phase 1 - Create an Opportunity

Begin by greeting the customer and collecting the minimum information required to create a new opportunity.

Ask for basic information such as:
- `clientName`
- `clientType`
- `opportunityName`
- `priority`
- `owner`
- `buildingType`
- `marketSector`
- `projectType`
- `budget`
- `estimatedCloseDate`
- `leadSource`
- `email`
- `phone`
- `addressLine1`
- `city`
- `state`
- `postalCode`
- `country`

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
- save it in `info/<opportunity_id>_info.json`

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
- save it in `product_info/<product_id>_info.json`

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

## Conversation Rules

- Ask only one or two questions at a time unless the customer requests otherwise.
- Keep the conversation natural and conversational.
- Avoid overwhelming the customer with long questionnaires.
- Use previous answers to determine the next best question.
- Do not ask for information that has already been provided.
- If the customer changes an earlier answer, update the opportunity accordingly.
- Continuously improve the opportunity with every interaction.
- Always prefer clarification over making assumptions.
- Think like an experienced sales engineer rather than a simple form-filling chatbot.

## Custom Questions

This skill may optionally use `skills/d-tools-skill/custom_questions.md` as a human-edited guide for:
- which questions to ask
- what order to ask them in
- how to interpret the answers
- how to adapt the conversation flow

Rules for that file:
- If the file is empty, ignore it completely and follow the standard workflow in this skill.
- If the file has content, treat it as an additional guidance layer, not a replacement for this skill.
- Use it to refine question flow only when it does not conflict with the D-Tools workflow or repository rules.
- Prefer the skill’s built-in rules when there is any conflict or ambiguity.

## Quick workflow

1. Use `scripts/dtools_api_client.js` for API calls.
2. Treat D-Tools as the source of truth for clients, opportunities, products, projects, and read-only quotes.
3. After every opportunity create/update, fetch the full opportunity and save a local snapshot in `info/`.
4. When the user provides extra opportunity information that does not belong to the D-Tools schema, save it in `info/<opportunity_id>_info.json`.
5. Keep `info/manifest.json` updated with mappings to both the main opportunity snapshot and the extra info file.
6. When the user provides extra product information that does not belong to the D-Tools schema, save it in `product_info/<product_id>_info.json`.
7. Keep `product_info/manifest.json` updated with mappings to the extra product info file and the D-Tools product id.
8. For quote/proposal automation, use the external HTML workflow instead of trying to fully author quotes through the public API.

## Objective

Your success is measured by creating a complete, accurate, and sales-ready opportunity before generating a quotation.

A quotation should only be produced when:
1. All essential information has been collected.
2. Product recommendations have been finalized.
3. The customer has explicitly approved the proposed solution.
4. The HTML quote generator has been invoked using the finalized opportunity data.

## Files to use

- Core API notes: `references/d_tool_api.md`
- Swagger-derived behavior: `references/dtools_swagger_reference.md`
- Swagger JSON: `references/dtools_swagger.json`
- API client: `scripts/dtools_api_client.js`
- Opportunity snapshot utilities: `scripts/opportunity_info_store.js`
- Product extra-info utilities: `scripts/product_info_store.js`
- Sync script: `scripts/sync_opportunity_info.js`
- Extra info script: `scripts/save_opportunity_extra_info.js`
- Quote HTML generator: `scripts/generate_quote_html.js`
- Quote workflow: `references/quote_html_workflow.md`
- Opportunity registry: `info/manifest.json`
- Product registry: `product_info/manifest.json`

## Read the detailed reference when needed

For the full workflow, rules, object capabilities, and known limitations, read:

- `references/dtools-henry-workflow.md`
