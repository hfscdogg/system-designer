# Thread 1 — D-Tools Cloud API spike

The highest-risk, do-it-first step from the kickoff briefs. Proves the
deliverable model (Outline §5–§6) against the **real** D-Tools Cloud API before
any more agent work, and **resolves every `TODO(spike)` field** in
`agents/controller.agent.yaml`.

> **Henry runs this — not the build session.** The D-Tools key lives in your
> environment, and there is no egress to D-Tools from the agent sandbox or the
> build container. This harness is paste-and-run with zero dependencies.

## What it proves

| Step | Question | Resolves in `controller.agent.yaml` |
|---|---|---|
| 0 auth | Key + base URL + `X-API-Key` header valid? | — (gate) |
| 1 template | The standard Quote Template id | (Learner's build-from-template) |
| 2 create | `POST` an Opportunity from the template → draft Quote spawned? | `get_opportunity_link.opportunity_id` |
| 3 readback | Read Opportunity + Quote; is the quote in **Draft**? exact state value? | `get_quote.quote_id`, `set_quote_state.quote_id` |
| 4 chunks | **How (or whether) product chunks get written into the quote** | `set_quote_state.state` + the whole chunk-write model |

## Known facts (from public D-Tools docs, May 2026)

- **Base URL:** `https://dtcloudapi.d-tools.cloud/api/v1` (host `dtcloudapi.d-tools.cloud`).
  The `api.d-tools.com` host from the prior handoff is the **SI / on-prem** API,
  not Cloud — don't point the agent build at it.
- **Auth:** `X-API-Key: <key>` header. Key from **Settings → Integration →
  Developer → API Keys** (max 5 active).
- **Opportunities:** GET / POST / PUT. **Quotes: GET only** over the Cloud API.
  Products: GET / PUT.
- **Quote states:** a new quote is **always `Draft`** → `In Progress` →
  `Accepted` / `Declined`. The template is chosen at opportunity-create time and
  preloads products + labor.

## ⚠️ The finding that may change the plan

Public docs indicate **Quotes are GET-only** via the Cloud API. If step 4
confirms there is no quote-item write endpoint, then:

- The agent **cannot** assemble arbitrary product chunks per-quote through the
  API. The reusable chunks (packages/assemblies) would have to be **baked into
  the Quote Template(s)**, not dropped in per-design — which reshapes the
  efficiency-engine → Learner handoff (Outline §5, §9).
- **"Promote past Draft"** (`set_quote_state`) is then most likely an
  **Opportunity `PUT`**, not a quote write. The Controller's gate tool would
  target the Opportunity, not the Quote.

Confirm empirically before locking the Controller's tool shapes. If reality
differs from Outline §5–§6, that updates the plan (the brief says so explicitly).

## Where the key lives

Host-side, in the orchestrator's secret store — **never** in the agent sandbox,
a system prompt, the repo, or logs. The script reads it from `DTOOLS_API_KEY`
and redacts it from all output. This matches locked decision #4 in the root
README: D-Tools is a **client-side custom tool**, so its key stays host-side and
`dtcloudapi.d-tools.cloud` is **not** in the environment `allowed_hosts`. (Only
if this spike concludes D-Tools should be reached over MCP does the key move to a
Managed Agents **Vault** and the host go into `allowed_hosts`.)

## Run it

```sh
# Dry run — prints the exact calls, sends nothing. Safe with no key.
python3 dtools_spike.py

# Live — needs the key in the environment.
export DTOOLS_API_KEY=...                      # from D-Tools Settings > Integration > Developer
python3 dtools_spike.py --live                 # all steps
python3 dtools_spike.py --live --step 0        # just the auth check

# Optional overrides:
export DTOOLS_BASE_URL=...                      # if your tenant differs
export DTOOLS_QUOTE_TEMPLATE_ID=...             # skip the template lookup
export DTOOLS_OPPORTUNITY_ID=... DTOOLS_QUOTE_ID=...  # chain readback/chunks after create
```

The RPC-style endpoint paths (e.g. `Opportunities/AddOpportunity`) are marked
`TODO(spike)` in the script — only the GET `Opportunities/GetOpportunities` path
is doc-confirmed. Confirm each path against your tenant's API reference
(docs.d-tools.cloud → Cloud API Documentation) and edit `ENDPOINTS` at the top of
`dtools_spike.py`, then re-run.

## When you're done

Fill in `FINDINGS.md`, then update the `TODO(spike)` fields in
`agents/controller.agent.yaml` to the verified shapes and flip Thread 1 to done
in `BUILD_CHECKLIST.md`.
