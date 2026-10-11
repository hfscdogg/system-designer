import { DESIGN_RETAINER_PCT, formatUsd, RETAINER_TEMPLATE, type CustomerProposal } from "@sd/build";
import type { DToolsReader, DToolsWriter } from "@sd/dtools";
import type { RunRecord, Store } from "@sd/store";

/**
 * "Send design retainer": create a D-Tools opportunity from the "Design
 * Retainer" quote template. D-Tools' API can't set a quote's price, so the reply
 * tells the rep the amount to type into its line before sending it for
 * e-signature and payment. Idempotent per budget: the opportunity is recorded as
 * the run's retainer/opportunity artifact, and an opportunity already created
 * under this budget's reference is found by name before anything is created.
 */
export interface RetainerDeps {
  store: Store;
  dtools: DToolsReader;
  writer: DToolsWriter | null;
  notify: (run: RunRecord, text: string, key: string) => Promise<void>;
}

export interface RetainerRecord {
  opportunity_id: string;
  number: string | null;
  name: string;
  quote_template: string;
  retainer_cents: number;
  /** The draft quote's price as D-Tools reports it; null when it could not be read. */
  quote_price_cents: number | null;
  /** What the amount is 4% of, for the reply ("the low estimate, $14,075.00"). */
  basis?: string;
}

const json = (read: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(read.body)) as Record<string, unknown>;

/** `tap` identifies the button press, so each press gets its own reply (a retry of one press does not post twice). */
export async function createRetainer(deps: RetainerDeps, runId: string, tap: string): Promise<void> {
  const { store } = deps;
  const run = await store.getRun(runId);
  const say = (text: string, suffix: string) => deps.notify(run, text, `${runId}:retainer:${tap}:${suffix}`);
  if (run.state !== "READY_HELD") {
    await say(run.state === "SUPERSEDED" ? "That budget was revised. Send the retainer from the newest one." : "That budget isn't finished yet.", "not-ready");
    return;
  }
  const done = await store.readArtifact<RetainerRecord>(runId, "retainer", "opportunity");
  if (done) return say(ready(done), "ready");
  if (!deps.writer || !deps.dtools.getOpportunity || !deps.dtools.findOpportunities) {
    return say("Sending the retainer from D-Tools isn't switched on here yet. Create it in D-Tools by hand for now.", "off");
  }

  const view = await store.readArtifact<CustomerProposal>(runId, "validate", "customer_view");
  if (!view) throw new Error(`run ${runId} has no customer view`);
  const cents = view.commercial.retainer.cents;
  const template = RETAINER_TEMPLATE;
  const ref = `SD-${runId.slice(4, 12)}`;
  const name = `Design Retainer · ${view.client} · ${ref}`;

  // A retry after a lost response must not create a second opportunity.
  const found = json(await deps.dtools.findOpportunities(ref)).opportunities as Array<{ id: string; name?: string }> | undefined;
  const existing = found?.find((o) => o.name?.includes(ref));
  const id =
    existing?.id ??
    (await deps.writer.createOpportunity({
      name,
      clientName: view.client,
      quoteTemplate: template,
      budget: Math.round((view.commercial.total_cents ?? view.commercial.subtotal_cents) / 100),
    }));

  // Read back what D-Tools made: the number reps search by, and the draft quote's price.
  const opp = json(await deps.dtools.getOpportunity(id));
  const quoteId = (opp.quoteIds as string[] | undefined)?.[0];
  let quotePrice: number | null = null;
  if (quoteId && deps.dtools.getQuote) {
    const price = json(await deps.dtools.getQuote(quoteId)).price;
    quotePrice = typeof price === "number" ? Math.round(price * 100) : null;
  }
  const c = view.commercial;
  const basis = c.likely_range ? `the low estimate, ${formatUsd(c.likely_range.low_cents)}` : `the budget, ${formatUsd(c.total_cents ?? c.subtotal_cents)}`;
  const record: RetainerRecord = {
    opportunity_id: id,
    number: typeof opp.number === "string" ? opp.number : null,
    name: typeof opp.name === "string" ? opp.name : name,
    quote_template: template,
    retainer_cents: cents,
    quote_price_cents: quotePrice,
    basis,
  };
  await store.publishArtifact(runId, "retainer", "opportunity", record);
  await say(ready(record), "ready");
}

function ready(r: RetainerRecord): string {
  const amount = formatUsd(r.retainer_cents);
  const where = `D-Tools opportunity ${r.number ?? r.opportunity_id} "${r.name}"`;
  const of = r.basis ? ` (${DESIGN_RETAINER_PCT}% of ${r.basis})` : "";
  if (r.quote_price_cents === null) {
    return `Design retainer: ${amount}${of}. It's set up as ${where}, but D-Tools made no quote from the "${r.quote_template}" template.\n⚠️ Check that the template exists, then add a Design Retainer quote for ${amount} by hand and send it for e-signature.`;
  }
  return `Design retainer: ${amount}${of}. It's ready as ${where}. Open it, set the Design Retainer line to ${amount}, then send the quote for e-signature; the client signs and pays the retainer there.`;
}
