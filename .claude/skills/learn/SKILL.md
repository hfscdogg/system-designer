---
name: learn
description: >-
  Weekly System Designer improvement pass. Reads the production run log
  (BigQuery sd_runlog_prod.runs) and rep feedback email, root-causes the worst
  misses, opens one draft PR of safe fixes, and writes Henry a one-page summary
  with the decisions only he can make (pricing and pattern defaults). Use when
  asked to "run learn", "what did reps change this week", "improve the
  patterns", or by the Monday routine.
---

# Learn: turn last week's runs into fixes

System Designer improves only through this loop. The system captures every request and result in the run log. It scores each budget (`packages/build/src/outcome.ts`): 5★ means left as built, 4★ small edits, 3★ the scope changed, 2★ blocked, 1★ dropped. A final quote within ±20% of ours raises the score. A person or this skill then reads the evidence and ships a PR. Nothing changes patterns or prices on its own.

## Guardrails (never break these)

- **Never merge.** Open a draft PR. Henry, or a session he has authorized, merges.
- **No pricing changes without Henry.** That covers new products, default quantities, hours, allowances, margins, Design & Delivery and the retainer. Propose those with evidence. Don't touch `config/commercial-policy*.json`.
- **No outward writes.** Make no D-Tools or QuickBooks writes. Email only henry@getlivewire.com.
- **No secrets** in code, PRs or email. Commit nothing from scratchpad D-Tools exports.
- **No model identifiers** in commits or PRs.

## 1. Pull the week

Read from BigQuery, read-only, project `livewire-system-designer-deux`:

```sql
-- Scores by pattern, last 7 days (newest run per thread carries the score)
SELECT pattern, COUNT(*) runs, COUNTIF(stars=5) s5, COUNTIF(stars=4) s4, COUNTIF(stars=3) s3,
       COUNTIF(stars<=2) s12, COUNTIF(stars IS NULL) open
FROM `livewire-system-designer-deux.sd_runlog_prod.runs`
WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY pattern ORDER BY runs DESC;

-- What went wrong: low scores, blocks, revisions that changed nothing, final quotes far off
SELECT run_id, requester, client, pattern, state, stars, why, changes, last_error,
       subtotal_usd, total_usd, ARRAY_TO_STRING(total_withheld, ' | ') total_withheld,
       final_quote_diff_pct, LEFT(request, 400) request, ARRAY_TO_STRING(later_messages, ' | ') later
FROM `livewire-system-designer-deux.sd_runlog_prod.runs`
WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND (stars <= 3 OR state IN ('BLOCKED','FAILED') OR changes = 'total 0%'
       OR ABS(final_quote_diff_pct) > 20 OR ARRAY_LENGTH(total_withheld) > 0)
ORDER BY created_at;

-- Money: retainers sent and paid
SELECT COUNTIF(retainer_invoice IS NOT NULL) sent, COUNTIF(retainer_paid_at IS NOT NULL) paid,
       SUM(IF(retainer_paid_at IS NOT NULL, retainer_usd, 0)) paid_usd
FROM `livewire-system-designer-deux.sd_runlog_prod.runs`
WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY);
```

For any run worth a closer look, read what it priced: `items` ("Manufacturer Model × qty"), `allowances`, `total_withheld` (why there is no total) and `to_verify`. Rows exported before 2026-10-13 have these empty.

From Gmail, read-only: search for rep feedback to Henry from the last 8 days, e.g. `from:getlivewire.com ("System Designer" OR "D&E Agent" OR budget) newer_than:8d`. Read whole threads.

Skip test runs: anything Henry or a rep labels as a test, and staging.

## 2. Root-cause the top 3–5

Rank problems by how often they happen and how much money they move. For each one:
- Trace it to code or pattern data with file:line evidence. The pipeline runs materialize (`packages/build/src/materialize.ts`), then compile, bind and validate, then render. Patterns live in `packages/build/patterns/*.json`, and the intake prompts are in `packages/llm/src/index.ts`.
- Reproduce it with `materialize` or `selectPattern` in a scratch test, never against prod.
- Check beyond the one case. Did the same thing happen on other runs this week?

## 3. Classify

- **(a) Safe fix:** a bug, wording, PDF check, revision handling, intake parsing, a role included when it wasn't asked for, a verify-list repeat. Fix it.
- **(b) Needs Henry:** anything that changes what gets priced or for how much. Don't build it. Give the evidence from Livewire's D-Tools quotes (counts, shares, the most common SKUs, two or three examples) and a recommendation.

## 4. Ship (a) as one draft PR

- `pnpm typecheck && pnpm test` must pass. Add a test per fix, built from the real run that exposed it.
- Bump the version string of every pattern you change.
- In the PR body, put **Why** (run IDs, rep quotes), **What changed**, **Verification**, and a **Needs Henry** list for the (b) items.
- Don't merge.

## 5. One-page summary to Henry

Email henry@getlivewire.com and nobody else. Subject: `System Designer — week of <date>`. Plain text, about one page:

1. **This week in numbers:** runs, stars mix, blocks, retainers sent and paid.
2. **What went wrong:** the top issues, each with a sentence of cause.
3. **Fixed in the PR:** the link, one line per fix.
4. **Decisions for you:** each (b) item with the evidence, a recommendation, and how to answer ("reply 1, 2 or 3").

If the week had no runs, say so in two lines and stop.
