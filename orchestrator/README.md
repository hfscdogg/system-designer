# Orchestrator (host-side runtime driver)

This is the **host-side orchestrator** — *not* the Controller. See the root
README "Terminology" section: the Controller is the agent that decides which
tool to call; this is the process on **your** infrastructure that executes those
calls with the real credentials and drives the Managed Agents session.

> **Where this runs:** on a host you control (a server, container, or function).
> GitHub only *stores* this code; it does not run it. The keys live in this
> host's environment, never in the repo and never in the agent sandbox.

## Files

```
orchestrator/
├── run_session.py       # the SDK driver: create session -> stream -> dispatch -> break
├── custom_tools.py      # host-side tool handlers — WHERE THE KEYS PLUG IN (stubbed)
├── config.example.env   # env-var template (copy to .env, gitignored)
└── README.md            # this file
```

## What it does (per the root README "Runtime overview")

1. `sessions.create(agent=SD_AGENT_ID, environment_id=SD_ENVIRONMENT_ID)`.
2. **Stream-first** — opens the event stream before sending anything.
3. Sends the kickoff `user.message` (the normalized intake; sample for now).
4. On `agent.custom_tool_use`, runs the matching handler in `custom_tools.py`
   **host-side** with the real key, then replies with `user.custom_tool_result`.
5. Breaks on `session.status_terminated`, or on `session.status_idle` with a
   terminal `stop_reason` (not `requires_action`, which is transient while the
   agent waits on a tool result).

## Status: skeleton, intentionally stubbed

- The session loop is real and follows the Managed Agents client patterns.
- The **D-Tools tool bodies are stubbed** (`SPIKE_RESOLVED = False` in
  `custom_tools.py`) — they return a labelled placeholder instead of calling
  D-Tools with a guessed endpoint. Thread 1 (`spikes/thread1-dtools/`) resolves
  the real paths/bodies; then flip `SPIKE_RESOLVED = True` and fill them in.
- `send_text` is stubbed until Thread 2 (intake/SMS plumbing).
- The kickoff intake is a static sample until Thread 2 produces real normalized
  intake objects.

So it's the runnable shape with the seams in the right places — not a finished
runtime.

## Run

```sh
pip install anthropic
cp orchestrator/config.example.env orchestrator/.env   # then fill it in
set -a; . orchestrator/.env; set +a                    # load into the env
python3 orchestrator/run_session.py
```

Needs `SD_AGENT_ID` + `SD_ENVIRONMENT_ID` (from the `ant ... create` calls) and
`ANTHROPIC_API_KEY`. With `DTOOLS_API_KEY` unset / `SPIKE_RESOLVED = False`, the
D-Tools tools return stubs — safe to run end-to-end without touching D-Tools.

## Where the keys plug in

`custom_tools.py` reads `DTOOLS_API_KEY` (and the SMS creds) from the host
environment and injects `X-API-Key` into the D-Tools call. This is the only place
a credential is used, and it is host-side — the Controller and the sandbox never
see it. If Thread 1 decides D-Tools should be reached over MCP instead, this file
goes away for D-Tools and the key moves to a Managed Agents Vault (`vault_ids`).
