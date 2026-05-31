#!/usr/bin/env python3
"""
System Designer — host-side orchestrator (the runtime driver).

This is the process described in the root README "Terminology" section as the
*host-side orchestrator* — distinct from the Controller agent. It runs on YOUR
infrastructure, holds the credentials, and drives one Managed Agents session per
project intake:

    sessions.create  ->  stream-first  ->  send kickoff intake
                     ->  handle agent.custom_tool_use host-side
                     ->  break on terminal idle / terminated

The Controller (the agent) decides WHICH tool to call; this driver EXECUTES the
call with the real keys (see custom_tools.py) and feeds the result back. The
agent sandbox never sees a credential.

Run on a host with these env vars set (NOT in the repo, NOT in the sandbox):
    ANTHROPIC_API_KEY   drives the Anthropic API / this session
    SD_AGENT_ID         the Controller agent id (from `ant beta:agents create`)
    SD_ENVIRONMENT_ID   the environment id (from `ant beta:environments create`)
    DTOOLS_API_KEY, SMS_*   consumed host-side by custom_tools.py

    pip install anthropic
    python3 run_session.py            # uses the built-in sample intake
"""

from __future__ import annotations

import os
import sys

import custom_tools

try:
    import anthropic
except ImportError:
    sys.exit("pip install anthropic — the SDK is required to run the orchestrator.")


def build_kickoff_intake() -> list[dict]:
    """The normalized intake object handed to the Controller as the first user
    message: sender identity, raw text, image attachments, timestamp.

    In production this comes from the Thread 2 intake layer (email/MMS -> one
    normalized object). Here it's a static sample so the loop is runnable.
    Image attachments would be added as {"type": "image", "source": {...}} blocks.
    """
    sample = (
        "intake from rep Dana (555-0100) @ 2026-05-31T18:00Z:\n"
        "got a lake house, 4 rooms wanna do music. budget midish. "
        "client likes sonos. pics coming"
    )
    return [{"type": "text", "text": sample}]


def run(client: anthropic.Anthropic, agent_id: str, environment_id: str) -> None:
    session = client.beta.sessions.create(
        agent=agent_id,                 # string shorthand -> latest version
        environment_id=environment_id,
        title="System Designer intake",
    )
    # Watch it live while developing:
    print(f"Session {session.id} ({session.status})")
    print(f"Console: https://platform.claude.com/workspaces/default/sessions/{session.id}")

    # Stream-first: open the stream BEFORE sending, or early events arrive buffered.
    with client.beta.sessions.events.stream(session_id=session.id) as stream:
        client.beta.sessions.events.send(
            session_id=session.id,
            events=[{"type": "user.message", "content": build_kickoff_intake()}],
        )

        for event in stream:
            if event.type == "agent.message":
                for block in event.content:
                    if block.type == "text":
                        print(block.text, end="", flush=True)

            elif event.type == "agent.custom_tool_use":
                # The Controller named a tool; perform it host-side with real creds.
                print(f"\n[tool] {event.name}({event.input})")
                result, is_error = custom_tools.handle(event.name, event.input)
                client.beta.sessions.events.send(
                    session_id=session.id,
                    events=[{
                        "type": "user.custom_tool_result",
                        "custom_tool_use_id": event.id,
                        "content": [{"type": "text", "text": result}],
                        "is_error": is_error,
                    }],
                )

            elif event.type == "session.status_terminated":
                print("\n[session terminated]")
                break

            elif event.type == "session.status_idle":
                # Correct break gate: idle is transient while the agent waits on a
                # tool result (requires_action). Only a terminal stop_reason ends it.
                if getattr(event.stop_reason, "type", None) == "requires_action":
                    continue
                print("\n[session idle — done]")
                break


def main() -> None:
    agent_id = os.environ.get("SD_AGENT_ID")
    environment_id = os.environ.get("SD_ENVIRONMENT_ID")
    if not agent_id or not environment_id:
        sys.exit("Set SD_AGENT_ID and SD_ENVIRONMENT_ID (from the ant create calls).")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Set ANTHROPIC_API_KEY in the host environment.")

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
    run(client, agent_id, environment_id)


if __name__ == "__main__":
    main()
