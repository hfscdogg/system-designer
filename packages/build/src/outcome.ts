import type { Selection } from "./materialize.ts";

/**
 * What happened to a budget after it was built, as a 1–5 score: left alone and
 * sent is a 5, small edits a 4, scope changes a 3, blocked a 2, dropped a 1.
 * A paid retainer reads "retainer paid" but scores the same as one sent.
 * When the rep later presents or the client accepts the real quote in D-Tools,
 * that quote is the final answer: within ±20% of ours lifts the score, further
 * off caps it at 3. Pure; the run log reads it for the pilot review.
 */

/** The quote Livewire actually presented or the client accepted, read from the retainer's D-Tools opportunity. */
export interface FinalQuote {
  quote_id: string;
  number: string | null;
  name: string;
  /** D-Tools quote state: "Presented" or "Accepted". */
  state: string;
  version: number;
  price_cents: number;
  accepted_at: string | null;
  modified_at: string | null;
  /** Billable equipment quantity per D-Tools system (e.g. "AV System"). */
  equipment_by_system: Record<string, number>;
  labor_hours: number;
}

export interface RevisionDiff {
  systems_added: string[];
  systems_removed: string[];
  roles_added: string[];
  roles_removed: string[];
  quantity_changes: Array<{ role: string; from: number; to: number }>;
  /** Same role, different product (a rep named another model). */
  swaps: Array<{ role: string; from: string[]; to: string[] }>;
  total_change_pct: number | null;
}

/** One built (or attempted) version of a budget, oldest first in a thread. */
export interface BudgetVersion {
  run_id: string;
  state: string;
  created_at: Date;
  selection: Pick<Selection, "pattern" | "lines"> | null;
  /** Total, or the priced scope while tax is unknown. */
  total_cents: number | null;
  retainer_sent: boolean;
  /** QuickBooks shows the retainer invoice paid. */
  retainer_paid: boolean;
  final_quote: FinalQuote | null;
}

export interface Outcome {
  stars: 1 | 2 | 3 | 4 | 5 | null;
  why: string;
  /** Our last version vs the final quote, in percent (+ means we were high); null without a final quote. */
  final_quote_diff_pct: number | null;
}

const ABANDONED_DAYS = 14;
const SMALL_TOTAL_CHANGE_PCT = 10;
const ACCURATE_PCT = 20;
const STOPPED = ["BLOCKED", "FAILED", "STALE", "RECONCILIATION_REQUIRED"];

const pct = (to: number, from: number) => Math.round((to / from - 1) * 1000) / 10;

function byRole(s: Pick<Selection, "lines">) {
  const roles = new Map<string, { quantity: number; products: Set<string> }>();
  for (const l of s.lines) {
    const r = roles.get(l.role) ?? { quantity: 0, products: new Set<string>() };
    r.quantity += l.quantity;
    r.products.add(l.requested_model ?? l.record_id);
    roles.set(l.role, r);
  }
  return roles;
}

export function diffSelections(
  before: Pick<Selection, "pattern" | "lines">,
  after: Pick<Selection, "pattern" | "lines">,
  beforeTotal: number | null,
  afterTotal: number | null,
): RevisionDiff {
  const sys = (s: Pick<Selection, "pattern">) => new Set(s.pattern.split("+"));
  const [sa, sb] = [sys(before), sys(after)];
  const [ra, rb] = [byRole(before), byRole(after)];
  const sorted = (xs: Iterable<string>) => [...xs].sort();
  const quantity_changes: RevisionDiff["quantity_changes"] = [];
  const swaps: RevisionDiff["swaps"] = [];
  for (const [role, a] of ra) {
    const b = rb.get(role);
    if (!b) continue;
    if (a.quantity !== b.quantity) quantity_changes.push({ role, from: a.quantity, to: b.quantity });
    const [pa, pb] = [sorted(a.products), sorted(b.products)];
    if (pa.join() !== pb.join()) swaps.push({ role, from: pa, to: pb });
  }
  return {
    systems_added: sorted([...sb].filter((s) => !sa.has(s))),
    systems_removed: sorted([...sa].filter((s) => !sb.has(s))),
    roles_added: sorted([...rb.keys()].filter((r) => !ra.has(r))),
    roles_removed: sorted([...ra.keys()].filter((r) => !rb.has(r))),
    quantity_changes: quantity_changes.sort((x, y) => x.role.localeCompare(y.role)),
    swaps: swaps.sort((x, y) => x.role.localeCompare(y.role)),
    total_change_pct: beforeTotal && afterTotal !== null ? pct(afterTotal, beforeTotal) : null,
  };
}

/** One line for the run log: "tv_mount 2→1; removed mesh_wifi; total −34%". */
export function describeDiff(d: RevisionDiff): string {
  const parts = [
    ...d.systems_added.map((s) => `added ${s}`),
    ...d.systems_removed.map((s) => `removed ${s}`),
    ...d.roles_added.map((r) => `+${r}`),
    ...d.roles_removed.map((r) => `-${r}`),
    ...d.quantity_changes.map((q) => `${q.role} ${q.from}→${q.to}`),
    ...d.swaps.map((s) => `${s.role} ${s.from.join("/")}→${s.to.join("/")}`),
  ];
  if (d.total_change_pct !== null) parts.push(`total ${d.total_change_pct > 0 ? "+" : ""}${d.total_change_pct}%`);
  return parts.join("; ") || "no change";
}

function isSmall(d: RevisionDiff): boolean {
  return !d.systems_added.length && !d.systems_removed.length && !d.roles_added.length && !d.roles_removed.length && d.swaps.length <= 1;
}

/** Score a thread: its versions oldest first (the original, then each revision). */
export function scoreBudget(versions: BudgetVersion[], now: Date): Outcome {
  const last = versions.at(-1);
  if (!last) return { stars: null, why: "no versions", final_quote_diff_pct: null };
  const built = versions.filter((v) => v.selection);
  const diffs = built.slice(1).map((v, i) => diffSelections(built[i]!.selection!, v.selection!, built[i]!.total_cents, v.total_cents));
  const sent = versions.some((v) => v.retainer_sent);
  const paid = versions.some((v) => v.retainer_paid);
  const final = versions.map((v) => v.final_quote).filter((q): q is FinalQuote => q !== null).at(-1) ?? null;
  const ageDays = (now.getTime() - last.created_at.getTime()) / 86_400_000;

  if (STOPPED.includes(last.state)) return { stars: 2, why: `stopped at ${last.state}`, final_quote_diff_pct: null };
  if (last.state !== "READY_HELD") {
    return ageDays >= ABANDONED_DAYS
      ? { stars: 1, why: `never finished (${last.state})`, final_quote_diff_pct: null }
      : { stars: null, why: `in progress (${last.state})`, final_quote_diff_pct: null };
  }

  // Tries that blocked on the way (a change the system couldn't apply) mean the rep had to fight it.
  const blocked = versions.slice(0, -1).filter((v) => STOPPED.includes(v.state)).length;
  const revisions = diffs.length;
  const first = built[0]?.total_cents ?? null;
  const moved = first && last.total_cents !== null ? Math.abs(pct(last.total_cents, first)) : 0;
  let stars: 3 | 4 | 5;
  let why: string;
  if (revisions === 0) {
    stars = 5;
    why = "left as built";
  } else if (diffs.every(isSmall) && moved < SMALL_TOTAL_CHANGE_PCT) {
    stars = 4;
    why = `${revisions} small edit${revisions > 1 ? "s" : ""}, total moved ${moved}%`;
  } else {
    stars = 3;
    why = `${revisions} edit${revisions > 1 ? "s" : ""} changed the scope, total moved ${moved}%`;
  }

  if (blocked && stars > 3) stars = 3;
  if (blocked) why = `${why}; ${blocked} ${blocked > 1 ? "tries" : "try"} blocked`;

  if (final && last.total_cents) {
    const off = pct(last.total_cents, final.price_cents);
    const label = `ours ${off > 0 ? "+" : ""}${off}% vs ${final.state.toLowerCase()} quote ${final.number ?? final.quote_id}`;
    if (Math.abs(off) <= ACCURATE_PCT) return { stars: Math.min(5, stars + 1) as 4 | 5, why: `${why}; ${label}`, final_quote_diff_pct: off };
    return { stars: Math.min(stars, 3) as 3, why: `${why}; ${label}`, final_quote_diff_pct: off };
  }
  if (!sent && ageDays >= ABANDONED_DAYS) return { stars: 1, why: `${why}; no retainer after ${ABANDONED_DAYS} days`, final_quote_diff_pct: null };
  if (!sent) return { stars: null, why: `${why}; retainer not sent yet`, final_quote_diff_pct: null };
  return { stars, why: `${why}; retainer ${paid ? "paid" : "sent"}`, final_quote_diff_pct: null };
}
