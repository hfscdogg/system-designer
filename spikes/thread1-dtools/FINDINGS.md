# Thread 1 — D-Tools API spike: FINDINGS

Fill this in as you run `dtools_spike.py --live`. Each answer either confirms or
corrects Outline §5–§6 and resolves a `TODO(spike)` in
`agents/controller.agent.yaml`. Status: ☐ not yet run.

## Environment confirmed
- Base URL in use: `__________` (default `https://dtcloudapi.d-tools.cloud/api/v1`)
- Auth header works (`X-API-Key`): ☐ yes / ☐ no
- Rate limits observed: `__________`

## Step 0 — Auth
- Result: `__________`

## Step 1 — Standard Quote Template
- List-templates endpoint (confirmed path): `__________`
- Standard template id: `__________`
- Template id field name in response: `__________`

## Step 2 — Create Opportunity (POST)
- Confirmed endpoint path + verb: `__________`
- Request body fields that worked: `__________`
- Opportunity identifier field name + example value: `__________`
  → updates `get_opportunity_link.opportunity_id`
- Rep-visible link: is there a shareable URL field on the opportunity? `__________`
  → confirms `get_opportunity_link` returns a real link
- Did creating from the template auto-spawn a Quote? ☐ yes / ☐ no

## Step 3 — Read back + Draft state
- Get-opportunity by-id filter that worked: `__________`
- Get-quote by-opportunity filter that worked: `__________`
- Quote identifier field name + example value: `__________`
  → updates `get_quote.quote_id` and `set_quote_state.quote_id`
- Exact Draft-state field name + value: `__________`  (docs say `Draft`)

## Step 4 — Product chunks + promotion (THE pivotal question)
- Is there ANY quote-item write endpoint (PUT/POST)? ☐ yes / ☐ no
  - If yes — path + body to add a package/assembly: `__________`
  - If no — **plan change:** chunks must live in the Quote Template(s); the
    Learner picks a template rather than assembling per-quote. Note it here and
    in the root README/Outline follow-up: `__________`
- How is "promote past Draft" actually done?
  - ☐ Quote write (state field) — path/body: `__________`
  - ☐ Opportunity `PUT` (state on the opportunity) — path/body: `__________`
  - Target state value the rep should see (e.g. `In Progress`): `__________`
  → updates `set_quote_state.state` (and possibly retargets the tool from Quote
    to Opportunity)

## Ownership-boundary check (Outline §6)
- After promotion, does the API still let the agent write the record? `__________`
- Confirmed clean hand-off point (the call after which the agent stops writing): `__________`

## Plan deltas vs Outline §5–§6
- `__________`

## TODO(spike) fields now resolved
- [ ] `get_quote.quote_id`
- [ ] `set_quote_state.quote_id`
- [ ] `set_quote_state.state`
- [ ] `get_opportunity_link.opportunity_id`
- [ ] (`send_text`, `log_internal_record` are not D-Tools — unaffected by this spike)
