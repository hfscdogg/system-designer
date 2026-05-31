#!/usr/bin/env python3
"""
Thread 1 — D-Tools Cloud API spike.

Proves the deliverable model from the planning doc (Outline sections 5-6) against
the REAL D-Tools Cloud API, before any more agent work. It walks the spine of the
deliverable:

    0. auth     — validate the API key + base URL + X-API-Key header
    1. template — find the standard Quote Template id
    2. create   — create an Opportunity from that template (POST) -> draft Quote
    3. readback — read the Opportunity + its Quote, confirm it is in Draft state
    4. chunks   — probe HOW (or whether) reusable product chunks (packages /
                  assemblies) can be written into the quote via the API

Each step's result resolves a TODO(spike) field in agents/controller.agent.yaml.
Record what you learn in FINDINGS.md.

CREDENTIALS — read from the environment, never hardcoded, never logged:
    DTOOLS_API_KEY           required for --live. The X-API-Key value from
                             D-Tools Cloud: Settings > Integration > Developer.
                             Lives host-side in the orchestrator's secret store
                             (see README.md "Where the key lives"). NOT in the
                             agent sandbox, prompt, repo, or logs.
    DTOOLS_BASE_URL          default https://dtcloudapi.d-tools.cloud/api/v1
    DTOOLS_QUOTE_TEMPLATE_ID optional; skip step 1 if you already know it.

USAGE:
    python3 dtools_spike.py                 # DRY RUN: print the plan, call nothing
    DTOOLS_API_KEY=... python3 dtools_spike.py --live          # run all steps
    DTOOLS_API_KEY=... python3 dtools_spike.py --live --step 0 # run one step

Zero dependencies — stdlib only, so you can paste-and-run.

NOTE ON ENDPOINT PATHS: the D-Tools Cloud API uses RPC-style paths under
/api/v1 (confirmed example: GET Opportunities/GetOpportunities). The exact paths
for create-opportunity, list-templates, and any quote/item write are marked
TODO(spike) below — confirm them against your tenant's API reference
(docs.d-tools.cloud > Cloud API Documentation) or the live /api/v1 surface, then
fill them in. The script fails loudly rather than guessing silently.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://dtcloudapi.d-tools.cloud/api/v1"

# ── Endpoint map ────────────────────────────────────────────────────────────
# Confirmed from public docs: GET Opportunities/GetOpportunities exists and the
# host is dtcloudapi.d-tools.cloud. Everything marked TODO(spike) is the
# INTENDED call, unverified — confirm the exact path + verb + body, then edit.
ENDPOINTS = {
    # step 0 — known-good GET used purely to validate auth + base + header.
    "auth_check":      ("GET",  "Opportunities/GetOpportunities"),
    # step 1 — list quote templates to find the standard one.
    "list_templates":  ("GET",  "QuoteTemplates/GetQuoteTemplates"),   # TODO(spike): confirm path
    # step 2 — create an Opportunity from a template (this spawns the draft Quote).
    "create_opp":      ("POST", "Opportunities/AddOpportunity"),       # TODO(spike): confirm path + body
    # step 3 — read the Opportunity (and its Quote) back.
    "get_opp":         ("GET",  "Opportunities/GetOpportunities"),     # TODO(spike): confirm by-id filter
    "get_quote":       ("GET",  "Quotes/GetQuotes"),                   # TODO(spike): confirm by-opp filter
    # step 4 — probe quote/item write surface. Quotes appear GET-only over the
    # Cloud API; if so, chunk writes are NOT exposed and the plan changes.
    "add_items":       ("PUT",  "Quotes/UpdateQuoteItems"),           # TODO(spike): may not exist
}


def _redact(headers: dict) -> dict:
    """Never let the key reach a log."""
    return {k: ("***REDACTED***" if k.lower() == "x-api-key" else v) for k, v in headers.items()}


def call(base_url: str, api_key: str, name: str, *, body=None, query=None,
         live: bool, timeout: float = 30.0):
    """Make (or, in dry-run, describe) one D-Tools API call."""
    method, path = ENDPOINTS[name]
    url = f"{base_url.rstrip('/')}/{path}"
    if query:
        from urllib.parse import urlencode
        url = f"{url}?{urlencode(query)}"
    headers = {"X-API-Key": api_key or "<DTOOLS_API_KEY>", "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"

    print(f"\n  {method} {url}")
    print(f"    headers: {_redact(headers)}")
    if body is not None:
        print(f"    body:    {json.dumps(body)}")

    if not live:
        print("    [dry-run] not sent. Re-run with --live to execute.")
        return None

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            print(f"    -> {resp.status} {resp.reason}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        print(f"    -> {e.code} {e.reason}")
    except urllib.error.URLError as e:
        print(f"    -> NETWORK ERROR: {e.reason}")
        return None

    try:
        parsed = json.loads(raw)
        print("    response:")
        print("      " + json.dumps(parsed, indent=2).replace("\n", "\n      "))
        return parsed
    except json.JSONDecodeError:
        print(f"    response (non-JSON): {raw[:500]}")
        return raw


# ── Steps ───────────────────────────────────────────────────────────────────

def step0_auth(base_url, api_key, live):
    print("STEP 0 — Validate auth (X-API-Key header + base URL).")
    print("  Resolves: that DTOOLS_API_KEY/base URL/header are correct before anything else.")
    return call(base_url, api_key, "auth_check", live=live, query={"take": 1})


def step1_template(base_url, api_key, live):
    print("STEP 1 — Find the standard Quote Template id.")
    print("  Resolves: the template the agent builds every opportunity from (Outline 5).")
    preset = os.environ.get("DTOOLS_QUOTE_TEMPLATE_ID")
    if preset:
        print(f"  DTOOLS_QUOTE_TEMPLATE_ID is set ({preset}); skipping the list call.")
        return preset
    return call(base_url, api_key, "list_templates", live=live)


def step2_create(base_url, api_key, live, template_id):
    print("STEP 2 — Create an Opportunity from the template (POST).")
    print("  Resolves: get_opportunity_link.opportunity_id, and confirms the draft")
    print("            Quote is spawned by the template (Outline 5).")
    # TODO(spike): confirm the real request body field names against the API ref.
    body = {
        "name": "SPIKE - System Designer test (safe to delete)",  # TODO(spike)
        "quoteTemplateId": template_id or "<TEMPLATE_ID>",         # TODO(spike)
    }
    return call(base_url, api_key, "create_opp", body=body, live=live)


def step3_readback(base_url, api_key, live, opportunity_id):
    print("STEP 3 — Read the Opportunity + Quote back; confirm Draft state.")
    print("  Resolves: get_quote.quote_id, set_quote_state.quote_id, and the exact")
    print("            Draft state value (Outline 5: new quote is always Draft).")
    call(base_url, api_key, "get_opp", live=live,
         query={"id": opportunity_id or "<OPPORTUNITY_ID>"})  # TODO(spike): confirm by-id filter
    return call(base_url, api_key, "get_quote", live=live,
                query={"opportunityId": opportunity_id or "<OPPORTUNITY_ID>"})  # TODO(spike)


def step4_chunks(base_url, api_key, live, quote_id):
    print("STEP 4 — Probe how reusable product chunks (packages/assemblies) are written.")
    print("  OPEN QUESTION (Outline 11 Q2): public docs suggest Quotes are GET-only over")
    print("  the Cloud API. If so, the agent CANNOT assemble arbitrary chunks per-quote via")
    print("  API — the template must carry them, OR promotion/structure is an Opportunity")
    print("  PUT, not a Quote write. Confirm here; this can change the plan.")
    print("  Resolves: set_quote_state mechanism (Quote write vs Opportunity PUT) + whether")
    print("            chunk assembly is even API-writable.")
    # TODO(spike): if no quote-write endpoint exists, DELETE this attempt and record
    # the finding instead. This call is a probe, expected to possibly 404/405.
    body = {"quoteId": quote_id or "<QUOTE_ID>", "items": []}  # TODO(spike)
    return call(base_url, api_key, "add_items", body=body, live=live)


STEPS = [step0_auth, step1_template, step2_create, step3_readback, step4_chunks]


def main():
    ap = argparse.ArgumentParser(description="D-Tools Cloud API spike (Thread 1).")
    ap.add_argument("--live", action="store_true",
                    help="actually call the API (default: dry-run, calls nothing).")
    ap.add_argument("--step", type=int, default=None,
                    help="run a single step 0-4 (default: all).")
    args = ap.parse_args()

    base_url = os.environ.get("DTOOLS_BASE_URL", DEFAULT_BASE_URL)
    api_key = os.environ.get("DTOOLS_API_KEY", "")

    print("=" * 72)
    print("D-Tools Cloud API spike — Thread 1")
    print(f"  base URL : {base_url}")
    print(f"  mode     : {'LIVE' if args.live else 'DRY RUN (no calls sent)'}")
    print(f"  API key  : {'present' if api_key else 'NOT SET'}"
          + ("" if api_key or not args.live else "  <-- set DTOOLS_API_KEY for --live"))
    print("=" * 72)

    if args.live and not api_key:
        print("\nERROR: --live needs DTOOLS_API_KEY in the environment. Aborting.")
        sys.exit(2)

    # Manual chaining: the create step yields ids the later steps need. In a real
    # run, copy the returned opportunity/quote ids out of step 2/3 output (the
    # field names are TODO(spike)) and pass them via env or by editing inline.
    if args.step is not None:
        fn = STEPS[args.step]
        # steps 2/3/4 take an extra id arg (opportunity/quote); pass None when
        # running them in isolation, then chain by hand from the printed output.
        if args.step in (2, 3, 4):
            fn(base_url, api_key, args.live, None)
        else:
            fn(base_url, api_key, args.live)
        return

    step0_auth(base_url, api_key, args.live)
    template_id = step1_template(base_url, api_key, args.live)
    template_id = template_id if isinstance(template_id, str) else os.environ.get("DTOOLS_QUOTE_TEMPLATE_ID")
    step2_create(base_url, api_key, args.live, template_id)
    print("\n  >> Copy the opportunity id from STEP 2 output into the readback below.")
    opportunity_id = os.environ.get("DTOOLS_OPPORTUNITY_ID")  # set after step 2 to chain
    step3_readback(base_url, api_key, args.live, opportunity_id)
    quote_id = os.environ.get("DTOOLS_QUOTE_ID")  # set after step 3 to chain
    step4_chunks(base_url, api_key, args.live, quote_id)

    print("\nDone. Record what each step returned in FINDINGS.md, then update the")
    print("TODO(spike) fields in agents/controller.agent.yaml accordingly.")


if __name__ == "__main__":
    main()
