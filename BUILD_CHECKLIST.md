# Build Checklist — System Designer (Voltron)

Threads from `System_Designer_Kickoff_Briefs.md`, ordered **by risk, not by
document order**. Do the thing that could break the architecture first.

Status legend: ✅ scaffolded · ☐ todo

---

## Thread 1 — D-Tools API Spike — ☐ todo **(do this first)**

The highest-risk, highest-leverage step. Proves the deliverable model against
the real D-Tools Cloud API before any more agent work. **Resolves every
`TODO(spike)` field name in `agents/controller.agent.yaml`** — the custom-tool
input schemas are currently the intended shape, unverified.

**Done when:** an Opportunity with a draft Quote has been created through the
API, Draft-state behavior confirmed, the quote read back, and the mechanism for
adding reusable product chunks (package vs. assembly) confirmed. Any divergence
from Outline §5–§6 updates the plan.

**Also decides (deferred here):** whether the Controller reaches D-Tools via
client-side custom tools (key host-side, hosts out of `allowed_hosts` — the
current scaffold) or over an MCP server (hosts in `allowed_hosts`, vault
credential). Until the spike lands, the scaffold stays client-side.

**Touches:** `agents/controller.agent.yaml` (rewrites the `TODO(spike)` input
schemas of `get_quote`, `set_quote_state`, `get_opportunity_link` to the real
D-Tools shapes); feeds the orchestrator's host-side D-Tools tool implementations.

**Carry:** agent system owns the record only through Draft. Never put the API key
in a prompt or a log.

---

## Thread 2 — Intake Plumbing — ☐ todo

Forgiving intake: messy email + MMS collapse into one normalized intake object
(sender identity, raw text, image attachments, timestamp). Fragment buffering,
soft "anything else?" check-in, identity resolution against the rep roster,
image resolution surviving MMS compression.

**Done when:** a messy multi-part text or email reliably becomes one clean intake
object, soft gate working, images flowing through as visual input.

**Touches:** new intake layer (host-side, upstream of the session) + the
`send_text` host-side implementation; not an agent YAML change.

**Carry:** forgiving above all — never demand detail-oriented behavior, never
hold a project hostage over a missing confirmation.

---

## Thread 3 — Controller + Learner Thin Slice — Controller ✅ / Learner ☐

First runnable agent pair on Managed Agents.

- ✅ **Controller** — `agents/controller.agent.yaml` (pure router, verbatim
  system prompt, custom tools, multiagent roster intentionally omitted).
- ✅ **Environment** — `environments/livewire-cloud.environment.yaml`
  (cloud, egress-locked, MCP allowed).
- ☐ **Learner** — write the Learner system prompt + the Controller↔Learner
  input/output contract; add the Learner to the Controller's `multiagent`
  roster via `ant beta:agents update` (one-level delegation); stand up the
  multiagent session and test against a real past intake.

**Done when:** the Controller takes a normalized intake, invokes the Learner,
runs clarification over text, and produces a draft scope — no antagonistic
roster yet.

**Touches:** `agents/controller.agent.yaml` (uncomment + populate `multiagent`),
new `agents/learner.agent.yaml`.

**Carry:** hybrid gate (small checklist floor + judgment, assume and flag the
rest). Ownership boundary holds.

---

## Thread 4 — The Antagonistic Roster — ☐ todo

Add Feedback, Critic, Reflector so the system protects the house.

**Done when:** a draft scope goes through Feedback → Critic → Reflector, and the
Controller promotes the quote past Draft (via `set_quote_state`) only once it
passes.

**Touches:** new `agents/feedback.agent.yaml`, `agents/critic.agent.yaml`,
`agents/reflector.agent.yaml`; extends the Controller `multiagent` roster via
`ant beta:agents update`.

**Carry:** antagonistic on the back end — a quality gatekeeper on output, never a
bottleneck on intake.

---

## Thread 5 — Efficiency Engine — ☐ todo *(separate track, prototype offline)*

Bottom-up discovery of reusable product chunks from the historical corpus in
Google Drive. Clustering, similarity threshold for "essentially the same
bundle," lightweight redirection mechanism that captures *why* a human approved
or redirected a candidate.

**Done when:** the engine scans historical projects and surfaces a ranked list of
candidate chunks, each with the data behind it, ready for human blessing.

**Touches:** standalone offline track (not part of the live session); later feeds
the chunk library the Learner draws from.

**Carry:** common is not the same as good. Discovered groupings are candidates,
never automatic. Capture the reason behind every human redirection.

---

## Thread 6 — Validation Against Gold-Standard History — ☐ todo

Prove the full roster against known-good past projects before going live. Feed
past intakes through the full roster; score against what was actually built and
sold using a tagged gold-standard subset.

**Done when:** the roster reproduces gold-standard designs closely enough on the
rubric that a senior designer would send the output cold, interleaved blind with
real past proposals.

**Touches:** test harness + scoring rubric (designer blind eyeball test primary,
product overlap diagnostic, final price within range guardrail; flag the danger
case where price matches but product overlap is low).

**Carry:** benchmark against the gold-standard subset only, never all history
indiscriminately.

---

### Scaffolded in this pass (Thread 3 control plane)

| File | Status |
|---|---|
| `agents/controller.agent.yaml` | ✅ scaffolded |
| `environments/livewire-cloud.environment.yaml` | ✅ scaffolded |
| `README.md` | ✅ |
| `BUILD_CHECKLIST.md` | ✅ |

Everything else is ☐ todo.
