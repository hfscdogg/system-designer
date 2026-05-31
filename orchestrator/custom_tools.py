"""
Host-side custom-tool handlers for the System Designer Controller.

THIS IS WHERE THE KEYS PLUG IN. The Controller (the agent) only *names* a tool
call; this module *performs* it, host-side, with the real credentials. The agent
sandbox never sees these secrets — that is the entire point of the client-side
custom-tool design (locked decision #4 in the root README).

Credentials are read from the host environment (a secret manager in production):
    DTOOLS_API_KEY   X-API-Key for D-Tools Cloud (Settings > Integration > Developer)
    DTOOLS_BASE_URL  default https://dtcloudapi.d-tools.cloud/api/v1
    SMS_*            your SMS provider creds (e.g. Twilio SID/token/from-number)

Every D-Tools call shape below is marked TODO(spike): it is the INTENDED shape,
not yet verified. Thread 1 (spikes/thread1-dtools/) resolves these; until then
the handlers run in STUB mode and return a clearly-labelled placeholder instead
of calling D-Tools with a guessed path.
"""

from __future__ import annotations

import json
import os

DTOOLS_BASE_URL = os.environ.get("DTOOLS_BASE_URL", "https://dtcloudapi.d-tools.cloud/api/v1")

# Flip to True only after Thread 1 confirms the real endpoint paths/bodies and
# you've filled them in below. Until then handlers return labelled stubs.
SPIKE_RESOLVED = False


def _dtools_ready() -> bool:
    return bool(os.environ.get("DTOOLS_API_KEY")) and SPIKE_RESOLVED


def _dtools_call(method: str, path: str, *, body=None, query=None) -> dict:
    """Thin host-side D-Tools client. Injects X-API-Key from the host env."""
    import urllib.error
    import urllib.parse
    import urllib.request

    api_key = os.environ["DTOOLS_API_KEY"]  # host-side only; never logged
    url = f"{DTOOLS_BASE_URL.rstrip('/')}/{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    headers = {"X-API-Key": api_key, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


# ── Tool handlers ───────────────────────────────────────────────────────────
# Each takes the agent-supplied input dict and returns a string result that the
# orchestrator sends back as a user.custom_tool_result.

def get_quote(tool_input: dict) -> str:
    """Read back a draft Quote from D-Tools (read-only)."""
    quote_id = tool_input.get("quote_id")  # TODO(spike): confirm field name
    if not _dtools_ready():
        return _stub("get_quote", tool_input)
    # TODO(spike): confirm path + by-id filter (Quotes are GET-only per docs).
    data = _dtools_call("GET", "Quotes/GetQuotes", query={"id": quote_id})
    return json.dumps(data)


def set_quote_state(tool_input: dict) -> str:
    """The promote-past-Draft gate. The ownership boundary flips here.

    NOTE (Thread 1 open question): if Quotes are GET-only, promotion is likely an
    Opportunity PUT, not a quote write — in which case this handler retargets the
    Opportunity. Confirm in the spike, then wire the real call.
    """
    quote_id = tool_input.get("quote_id")  # TODO(spike)
    state = tool_input.get("state")        # TODO(spike): e.g. "In Progress"
    if not _dtools_ready():
        return _stub("set_quote_state", tool_input)
    # TODO(spike): confirm whether this is Quotes/Update... or Opportunities PUT.
    data = _dtools_call("PUT", "Opportunities/UpdateOpportunity",
                        body={"quoteId": quote_id, "state": state})
    return json.dumps(data)


def get_opportunity_link(tool_input: dict) -> str:
    """Return the rep-visible Opportunity link for a promoted quote."""
    opportunity_id = tool_input.get("opportunity_id")  # TODO(spike)
    if not _dtools_ready():
        return _stub("get_opportunity_link", tool_input)
    # TODO(spike): confirm by-id filter + the shareable-link field on the response.
    data = _dtools_call("GET", "Opportunities/GetOpportunities", query={"id": opportunity_id})
    return json.dumps(data)


def send_text(tool_input: dict) -> str:
    """Send an SMS/MMS to the rep via the host-side SMS provider (e.g. Twilio)."""
    to = tool_input.get("to")      # TODO(spike): recipient shape
    body = tool_input.get("body")  # TODO(spike)
    sms_sid = os.environ.get("SMS_ACCOUNT_SID")
    if not sms_sid:
        return _stub("send_text", tool_input)
    # TODO: wire the SMS provider SDK/HTTP call here (host-side creds).
    raise NotImplementedError("SMS provider call not wired yet (Thread 2).")


def log_internal_record(tool_input: dict) -> str:
    """Write the internal margin/assembly + routing audit trail (host-side)."""
    record_type = tool_input.get("record_type")  # TODO(spike)
    payload = tool_input.get("payload")           # TODO(spike)
    # TODO: persist to the internal store. For now, log locally so the trail is
    # visible during development. Never write secrets here.
    print(f"  [internal-record] {record_type}: {json.dumps(payload)}")
    return "recorded"


TOOL_HANDLERS = {
    "get_quote": get_quote,
    "set_quote_state": set_quote_state,
    "get_opportunity_link": get_opportunity_link,
    "send_text": send_text,
    "log_internal_record": log_internal_record,
}


def _stub(name: str, tool_input: dict) -> str:
    msg = (f"STUB[{name}]: not wired yet — pending Thread 1 D-Tools spike "
           f"(see spikes/thread1-dtools/). input={json.dumps(tool_input)}")
    print(f"  [stub] {msg}")
    return msg


def handle(name: str, tool_input: dict) -> tuple[str, bool]:
    """Dispatch a custom tool call. Returns (result_text, is_error)."""
    fn = TOOL_HANDLERS.get(name)
    if fn is None:
        return (f"Unknown tool: {name}", True)
    try:
        return (fn(tool_input or {}), False)
    except NotImplementedError as e:
        return (f"{name} not implemented yet: {e}", True)
    except Exception as e:  # noqa: BLE001 — surface any host-side failure to the agent
        return (f"{name} failed host-side: {e}", True)
