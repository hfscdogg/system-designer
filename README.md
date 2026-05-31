# Livewire System Designer — Claude Managed Agents

The "Voltron" multi-agent build that turns a sales rep's messy project intake
into a reviewed scope of work, staged as a **draft quote in D-Tools Cloud** and
promoted past Draft only after an antagonistic review roster signs off.

This repo scaffolds the **System Designer Controller** — the orchestrator/router
that runs the show — plus the shared environment it runs in. The specialist
agents (Learner, Feedback, Critic, Reflector) and the intake/efficiency tracks
are built later; see [`BUILD_CHECKLIST.md`](./BUILD_CHECKLIST.md).

Source of truth: `System_Designer_Agent_Outline` (revision 4) and
`System_Designer_Kickoff_Briefs.md` in the team Google Drive. The Controller
system prompt in [`agents/controller.agent.yaml`](./agents/controller.agent.yaml)
is reproduced **verbatim** from the kickoff doc.

---

## Locked-in architecture decisions

These are decided — not up for re-litigation during the build.

1. **Tools are per-agent.** `tools` / `mcp_servers` / `skills` live on the agent
   object, never on the session. Each specialist gets exactly the tools its role
   needs.

2. **The Controller is a pure router.** It does not design, edit files, run bash,
   or search the web. It declares **no** `agent_toolset_20260401` — only its own
   custom client-side tools: `get_quote`, `set_quote_state` (the promote-past-
   Draft gate), `get_opportunity_link`, `send_text`, and `log_internal_record`.

3. **Networking is per-session.** One environment / container is shared by the
   whole multiagent session. Egress is locked: `networking.type: limited`,
   `allow_package_managers: false`, `allow_mcp_servers: true` (for the Learner's
   future Google Drive reads over MCP), `allowed_hosts: []`.

4. **D-Tools Cloud and SMS are client-side custom tools.** The orchestrator (the
   process holding the SSE stream) executes them host-side with its own
   credentials — the D-Tools native API key and the SMS provider token. The
   sandbox never sees those keys, so **the D-Tools and SMS hosts are NOT in the
   environment allow-list.** Vaults hold MCP credentials only; there are no
   container env vars. (See `shared/managed-agents-client-patterns.md` Pattern 9
   in the claude-api skill for the host-side-secret pattern.)

5. **Model is the bare string `claude-opus-4-8`.**

6. **Ownership boundary.** The agent system owns the Opportunity + draft Quote
   from creation through validation, up to promotion. The instant the quote is
   promoted past Draft and the rep gets the link, **D-Tools Cloud becomes the
   system of record** and the agents stop writing to it. `set_quote_state` is
   that hand-off moment.

7. **One level of delegation.** The Controller coordinates the specialists
   directly; specialists do not sub-delegate. The `multiagent` roster is a
   top-level field on the Controller agent, added later via `agents update`.

---

## Reconciliation with prior Console state

A prior session shipped a Controller agent and environment to the Anthropic
Console (`HANDOFF.md`) that **diverge from the planning docs**. Per Henry's call,
**the planning docs (`System_Designer_Agent_Outline` rev 4 +
`System_Designer_Kickoff_Briefs.md`) are the source of truth**, and this YAML is
faithful to them. Where the live Console differs, re-apply from this repo:

- **Controller toolset.** Live `v3` carries `agent_toolset_20260401` (8 built-in
  tools). The docs describe the Controller as a pure orchestrator that *"does not
  design the system yourself"* — so this scaffold declares **no** toolset, only
  its custom router tools. Re-apply to drop the built-ins.
- **D-Tools / SMS access — deferred to Thread 1.** This scaffold uses client-side
  custom tools (key stays host-side, hosts out of `allowed_hosts`). The live env
  instead lists `*.d-tools.cloud` / `api.d-tools.com` and reaches D-Tools over
  MCP. **The D-Tools API spike decides** which integration is correct; until then
  the scaffold stays client-side and the env allow-list stays empty.
- **Roster mechanism.** This build targets **Managed Agents** — the `multiagent`
  coordinator is a stored top-level agent field (added via `agents update`). The
  handoff's Agent-SDK subagents (`.claude/agents/*.md` + `Agent` tool) are a
  *different* Anthropic surface; don't mix the two.

---

## Apply flow (`ant` CLI)

The control plane (agents, environments) is version-controlled YAML applied with
the `ant` CLI. The data plane (sessions, events) is driven by the orchestrator
through the SDK. **Create the env and agent once, store the IDs, then update —
never re-create.** Re-creating accumulates orphaned objects and breaks the
versioning model.

```sh
# ── One-time setup: create, capture the IDs, store them (config / .env / CI) ──
ENV_ID=$(ant beta:environments create \
  < environments/livewire-cloud.environment.yaml --transform id -r)

AGENT_ID=$(ant beta:agents create \
  < agents/controller.agent.yaml --transform id -r)

# ── Thereafter: UPDATE in place (do not re-create). Each update bumps the
#    agent version; pass the current version as the optimistic lock. This is
#    also how the Learner/Feedback/Critic/Reflector roster gets added later. ──
ant beta:agents update --agent-id "$AGENT_ID" --version N \
  < agents/controller.agent.yaml

ant beta:environments update --environment-id "$ENV_ID" \
  < environments/livewire-cloud.environment.yaml
```

Auth: `ANTHROPIC_API_KEY` in the environment, or `ant auth login`.

---

## Runtime overview (orchestrator, per intake)

The orchestrator is application code driving one session per project intake via
the SDK. The shape:

1. **`sessions.create(agent=AGENT_ID, environment_id=ENV_ID, ...)`** — references
   the pre-created Controller agent and the shared environment. (Attach
   `vault_ids` for MCP credentials once the Learner needs Drive.)
2. **Stream-first.** Open the event stream **before** sending anything — the
   stream only delivers events emitted after it opens.
3. **Kickoff `user.message`** — hand the Controller the normalized intake
   (sender identity, raw text, image attachments, timestamp).
4. **Handle `agent.custom_tool_use` host-side.** When the Controller calls
   `get_quote` / `set_quote_state` / `get_opportunity_link` / `send_text` /
   `log_internal_record`, the orchestrator executes it with its own credentials
   (D-Tools API key, SMS token) and replies with `user.custom_tool_result`. The
   container never sees those secrets.
5. **Break on terminal idle / terminated.** Stop the loop on
   `session.status_terminated`, or on `session.status_idle` when its
   `stop_reason` is terminal (anything except `requires_action`, which fires
   transiently while the Controller waits on a custom-tool result — keep going).

---

## Build order is by risk

The next real step is **Thread 1: the D-Tools API spike** — it proves the
deliverable model (create Opportunity → populate draft Quote from the standard
Quote Template → confirm it stays Draft → read it back → confirm how reusable
product chunks are written in) against the real D-Tools Cloud API. **That spike
resolves every `TODO(spike)` field name in `agents/controller.agent.yaml`** — the
custom-tool input schemas there are the intended shape, not yet verified. Do the
thing that could break the architecture first. Full thread map:
[`BUILD_CHECKLIST.md`](./BUILD_CHECKLIST.md).

---

## Layout

```
agents/controller.agent.yaml              # System Designer Controller (pure router) — scaffolded
environments/livewire-cloud.environment.yaml  # shared egress-locked env — scaffolded
BUILD_CHECKLIST.md                        # Threads 1–6, done-criteria, file each touches
README.md                                 # this file
```
