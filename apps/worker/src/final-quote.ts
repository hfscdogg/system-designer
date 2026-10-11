import type { FinalQuote } from "@sd/build";
import { hashCanonical } from "@sd/core";
import type { DToolsReader } from "@sd/dtools";
import type { Store } from "@sd/store";
import type { RetainerRecord } from "./retainer.ts";

/**
 * Find the real quote for each budget whose retainer went out. Reps build the
 * system quote under the opportunity "Send design retainer" created; once it is
 * Presented or Accepted, record it as the run's outcome/final_quote-<state>-…
 * artifact so the run log can compare it with our budget. Read-only in D-Tools.
 */
const FINAL_STATES = ["Presented", "Accepted"];
const MAX_AGE_DAYS = 180;

const json = (read: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(read.body)) as Record<string, unknown>;

interface QuoteItem {
  type?: string | null;
  quantity?: number | null;
  isBillable?: boolean | null;
  system?: string | null;
  unitLaborTime?: number | null;
}

/** The final-quote record for a D-Tools quote, or null when it is the retainer itself or not final yet. */
export function finalQuoteOf(q: Record<string, unknown>, retainerCents: number): FinalQuote | null {
  const name = typeof q.name === "string" ? q.name : "";
  const price = typeof q.price === "number" ? Math.round(q.price * 100) : null;
  const state = typeof q.state === "string" ? q.state : "";
  if (price === null || /^design retainer/i.test(name) || price === retainerCents || q.isServiceQuote === true) return null;
  if (!FINAL_STATES.includes(state) && !q.acceptedDate) return null;
  const items = (Array.isArray(q.items) ? q.items : []) as QuoteItem[];
  const equipment: Record<string, number> = {};
  let laborSeconds = 0;
  for (const i of items) {
    if (i.isBillable === false) continue;
    const qty = i.quantity ?? 0;
    laborSeconds += (i.unitLaborTime ?? 0) * qty;
    if (i.type === "Labor") continue;
    const system = i.system ?? "Unassigned";
    equipment[system] = (equipment[system] ?? 0) + qty;
  }
  return {
    quote_id: String(q.id),
    number: typeof q.number === "string" ? q.number : null,
    name,
    state: q.acceptedDate ? "Accepted" : state,
    version: typeof q.version === "number" ? q.version : 1,
    price_cents: price,
    accepted_at: typeof q.acceptedDate === "string" ? q.acceptedDate : null,
    modified_at: typeof q.modifiedDate === "string" ? q.modifiedDate : null,
    equipment_by_system: Object.fromEntries(Object.entries(equipment).sort(([a], [b]) => a.localeCompare(b))),
    labor_hours: Math.round((laborSeconds / 3600) * 10) / 10,
  };
}

export async function followUpFinalQuotes(store: Store, dtools: DToolsReader): Promise<{ checked: number; recorded: number; failed: string[] }> {
  if (!dtools.getOpportunity || !dtools.getQuote) return { checked: 0, recorded: 0, failed: [] };
  const runIds = await store.runsAwaitingFinalQuote(MAX_AGE_DAYS);
  let recorded = 0;
  const failed: string[] = [];
  for (const runId of runIds) {
    try {
      const retainer = await store.readArtifact<RetainerRecord>(runId, "retainer", "opportunity");
      if (!retainer) continue;
      const opp = json(await dtools.getOpportunity(retainer.opportunity_id));
      for (const quoteId of (opp.quoteIds as string[] | undefined) ?? []) {
        const final = finalQuoteOf(json(await dtools.getQuote(quoteId)), retainer.retainer_cents);
        if (!final) continue;
        // Named by content: a quote revised after it was presented adds a new record instead of overwriting one.
        const name = `final_quote-${final.state.toLowerCase()}-${final.quote_id}-${hashCanonical(final).replace(/^sha256:/, "").slice(0, 12)}`;
        if (!(await store.listArtifacts(runId)).some((a) => a.stage === "outcome" && a.name === name)) {
          await store.publishArtifact(runId, "outcome", name, final);
          recorded++;
        }
      }
    } catch (err) {
      failed.push(runId);
      await store.appendEvent(runId, "final_quote_check_failed", "system", { error: String(err) });
    }
  }
  return { checked: runIds.length, recorded, failed };
}

/** The run's best final quote: accepted over presented, then the newest. */
export async function readFinalQuote(store: Store, runId: string): Promise<FinalQuote | null> {
  const names = (await store.listArtifacts(runId)).filter((a) => a.stage === "outcome" && a.name.startsWith("final_quote-")).map((a) => a.name);
  const quotes = (await Promise.all(names.map((n) => store.readArtifact<FinalQuote>(runId, "outcome", n)))).filter((q): q is FinalQuote => q !== null);
  const rank = (q: FinalQuote) => [q.state === "Accepted" ? 1 : 0, q.version, q.modified_at ?? ""] as const;
  return quotes.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
  }).at(-1) ?? null;
}
