import { describeDiff, diffSelections, scoreBudget, type BudgetVersion, type CustomerProposal, type Outcome, type RevisionDiff, type Selection } from "@sd/build";
import type { RunReportRow, Store } from "@sd/store";
import { readFinalQuote } from "@sd/worker";

/** What happened to a run: its change from the version it revised, and (on a thread's newest version) the thread's score. */
export interface RunOutcome {
  changes: string | null;
  /** Runs in this budget's thread: its revisions and any restarts. */
  thread_runs: number;
  diff: RevisionDiff | null;
  stars: Outcome["stars"];
  why: string | null;
  final_quote_usd: number | null;
  final_quote_diff_pct: number | null;
}

export type ScoredRow = RunReportRow & RunOutcome;

const COLUMNS: Array<keyof ScoredRow> = [
  "run_id",
  "created_at",
  "requester",
  "space_id",
  "revision",
  "parent_run_id",
  "request",
  "later_messages",
  "changes",
  "state",
  "pattern",
  "client",
  "subtotal_usd",
  "total_usd",
  "likely_low_usd",
  "likely_high_usd",
  "retainer_usd",
  "retainer_opportunity",
  "retainer_invoice",
  "retainer_paid_at",
  "items",
  "allowances",
  "total_withheld",
  "to_verify",
  "final_quote_usd",
  "final_quote_diff_pct",
  "thread_runs",
  "stars",
  "why",
  "pdf_sha256",
  "last_error",
];

/** RFC 4180 CSV: every field quoted, quotes doubled; lists (later messages, items, …) joined with " | ". */
export function runsCsv(rows: ScoredRow[]): string {
  const cell = (v: unknown) => `"${(Array.isArray(v) ? v.join(" | ") : v == null ? "" : String(v)).replace(/"/g, '""')}"`;
  return [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

async function versionOf(store: Store, runId: string, state: string, createdAt: Date): Promise<BudgetVersion> {
  const selection = await store.readArtifact<Selection>(runId, "selection", "selection");
  const view = await store.readArtifact<Pick<CustomerProposal, "commercial">>(runId, "validate", "customer_view");
  return {
    run_id: runId,
    state,
    created_at: createdAt,
    selection,
    total_cents: view ? (view.commercial.total_cents ?? view.commercial.subtotal_cents) : null,
    retainer_sent: (await store.readArtifact(runId, "retainer", "opportunity")) !== null,
    retainer_paid: (await store.readArtifact(runId, "retainer", "payment")) !== null,
    final_quote: await readFinalQuote(store, runId),
  };
}

/** A fresh request for the same client from the same person within this long is a retry of the same budget. */
const RESTART_WINDOW_MS = 24 * 3_600_000;

/**
 * Score the report's runs by budget thread: revisions chain by parent, and a
 * fresh request for the same client from the same person within 24 hours of an
 * earlier one (a rep starting over after a bad result) joins that thread. The
 * thread is scored once, on its newest run. A parent from before the report
 * window is read from the store so the first revision in it still shows its change.
 */
export async function scoreRuns(store: Store, rows: RunReportRow[], now: Date): Promise<ScoredRow[]> {
  const versions = new Map<string, BudgetVersion>();
  for (const r of rows) versions.set(r.run_id, await versionOf(store, r.run_id, r.state, new Date(r.created_at)));
  for (const r of rows) {
    if (r.parent_run_id && !versions.has(r.parent_run_id)) {
      const parent = await store.getRun(r.parent_run_id);
      // Only a thread's newest run's date matters (for "dropped"), so an older parent's date can be left unset.
      versions.set(parent.id, await versionOf(store, parent.id, parent.state, new Date(0)));
    }
  }

  // Threads: union revisions with their parents, and restarts with the run they restart.
  const root = new Map<string, string>();
  const find = (id: string): string => {
    const up = root.get(id) ?? id;
    return up === id ? id : find(up);
  };
  const join = (a: string, b: string) => root.set(find(a), find(b));
  const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const [i, r] of ordered.entries()) {
    if (r.parent_run_id) join(r.run_id, r.parent_run_id);
    else if (r.client) {
      const at = Date.parse(r.created_at);
      const earlier = ordered
        .slice(0, i)
        .reverse()
        .find((e) => e.requester === r.requester && e.client === r.client && at - Date.parse(e.created_at) <= RESTART_WINDOW_MS);
      if (earlier) join(r.run_id, earlier.run_id);
    }
  }
  const threads = new Map<string, BudgetVersion[]>();
  for (const v of versions.values()) threads.set(find(v.run_id), [...(threads.get(find(v.run_id)) ?? []), v]);
  for (const t of threads.values()) t.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  return rows.map((r) => {
    const v = versions.get(r.run_id)!;
    const parent = r.parent_run_id ? versions.get(r.parent_run_id) : undefined;
    const diff = parent?.selection && v.selection ? diffSelections(parent.selection, v.selection, parent.total_cents, v.total_cents) : null;
    const thread = threads.get(find(r.run_id))!;
    const latest = thread.at(-1)!.run_id === r.run_id;
    const outcome = latest ? scoreBudget(thread, now) : null;
    const final = thread.map((x) => x.final_quote).filter((q) => q !== null).at(-1) ?? null;
    return {
      ...r,
      changes: diff ? describeDiff(diff) : null,
      diff,
      thread_runs: thread.length,
      stars: outcome?.stars ?? null,
      why: outcome?.why ?? (latest ? null : "see the newer version of this budget"),
      final_quote_usd: latest && final ? final.price_cents / 100 : null,
      final_quote_diff_pct: outcome?.final_quote_diff_pct ?? null,
    };
  });
}

/**
 * What reps changed, for tuning patterns: stars by pattern, the roles most
 * edited, products swapped in, and systems nothing covers. Plain text.
 */
export function learnReport(rows: ScoredRow[]): string {
  const count = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
  const top = (m: Map<string, number>, n = 10) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  const stars = new Map<string, number[]>();
  const qty = new Map<string, number>();
  const up = new Map<string, number>();
  const added = new Map<string, number>();
  const removed = new Map<string, number>();
  const swaps = new Map<string, number>();
  const uncovered = new Map<string, number>();
  const off: Array<{ run: string; pct: number }> = [];
  for (const r of rows) {
    const p = r.pattern ?? "(no pattern)";
    if (r.stars !== null) stars.set(p, [...(stars.get(p) ?? [0, 0, 0, 0, 0])].map((n, i) => n + (i + 1 === r.stars ? 1 : 0)));
    for (const q of r.diff?.quantity_changes ?? []) {
      count(qty, `${p} ${q.role}`);
      if (q.to > q.from) count(up, `${p} ${q.role}`);
    }
    for (const x of [...(r.diff?.roles_added ?? []), ...(r.diff?.systems_added ?? [])]) count(added, `${p} ${x}`);
    for (const x of [...(r.diff?.roles_removed ?? []), ...(r.diff?.systems_removed ?? [])]) count(removed, `${p} ${x}`);
    for (const s of r.diff?.swaps ?? []) count(swaps, `${s.role}: ${s.from.join("/")} → ${s.to.join("/")}`);
    const covers = /pattern covers (.+?);/.exec(r.last_error ?? "")?.[1];
    if (covers) count(uncovered, covers);
    if (r.final_quote_diff_pct !== null && Math.abs(r.final_quote_diff_pct) > 20) off.push({ run: `${r.run_id} ${r.client ?? ""}`.trim(), pct: r.final_quote_diff_pct });
  }
  const section = (title: string, lines: string[]) => [`${title}:`, ...(lines.length ? lines.map((l) => `  ${l}`) : ["  (none)"])];
  return [
    ...section("Stars by pattern (1★ … 5★)", [...stars].sort().map(([p, s]) => `${p}: ${s.join(" / ")}`)),
    ...section("Quantities reps changed most (times; times raised)", top(qty).map(([k, n]) => `${k}: ${n}; raised ${up.get(k) ?? 0}`)),
    ...section("Added by reps", top(added).map(([k, n]) => `${k}: ${n}`)),
    ...section("Removed by reps", top(removed).map(([k, n]) => `${k}: ${n}`)),
    ...section("Products swapped", top(swaps).map(([k, n]) => `${k}: ${n}`)),
    ...section("Blocked: systems no pattern covers", top(uncovered).map(([k, n]) => `${k}: ${n}`)),
    ...section("Final quote more than ±20% from ours", off.map((o) => `${o.run}: ours ${o.pct > 0 ? "+" : ""}${o.pct}%`)),
  ].join("\n") + "\n";
}
