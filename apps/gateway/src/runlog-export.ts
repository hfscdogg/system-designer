import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigQuery } from "@google-cloud/bigquery";
import type { Store } from "@sd/store";
import { scoreRuns, type ScoredRow } from "./report.ts";

/**
 * Copy the scored run log into BigQuery so it can be queried read-only (by an
 * admin, or Claude through the BigQuery connector) without database access.
 * Each pass replaces the table with the last 180 days, so a retry is harmless.
 */
const DAYS = 180;

export type RunlogRow = Omit<ScoredRow, "diff" | "later_messages"> & { later_messages: string[]; exported_at: string };

export interface RunlogSink {
  replace(rows: RunlogRow[]): Promise<void>;
}

const FIELDS: Array<[keyof RunlogRow, "STRING" | "INTEGER" | "FLOAT" | "TIMESTAMP", "NULLABLE" | "REQUIRED" | "REPEATED"]> = [
  ["run_id", "STRING", "REQUIRED"],
  ["created_at", "TIMESTAMP", "REQUIRED"],
  ["requester", "STRING", "NULLABLE"],
  ["space_id", "STRING", "NULLABLE"],
  ["revision", "INTEGER", "NULLABLE"],
  ["parent_run_id", "STRING", "NULLABLE"],
  ["request", "STRING", "NULLABLE"],
  ["later_messages", "STRING", "REPEATED"],
  ["changes", "STRING", "NULLABLE"],
  ["state", "STRING", "NULLABLE"],
  ["pattern", "STRING", "NULLABLE"],
  ["client", "STRING", "NULLABLE"],
  ["subtotal_usd", "FLOAT", "NULLABLE"],
  ["total_usd", "FLOAT", "NULLABLE"],
  ["likely_low_usd", "FLOAT", "NULLABLE"],
  ["likely_high_usd", "FLOAT", "NULLABLE"],
  ["retainer_usd", "FLOAT", "NULLABLE"],
  ["retainer_opportunity", "STRING", "NULLABLE"],
  ["final_quote_usd", "FLOAT", "NULLABLE"],
  ["final_quote_diff_pct", "FLOAT", "NULLABLE"],
  ["stars", "INTEGER", "NULLABLE"],
  ["why", "STRING", "NULLABLE"],
  ["pdf_sha256", "STRING", "NULLABLE"],
  ["last_error", "STRING", "NULLABLE"],
  ["exported_at", "TIMESTAMP", "REQUIRED"],
];

export async function exportRunlog(store: Store, sink: RunlogSink, now: Date): Promise<number> {
  const since = new Date(now.getTime() - DAYS * 86_400_000);
  const scored = await scoreRuns(store, await store.runReport(since), now);
  const rows = scored.map(({ diff: _diff, ...r }) => ({ ...r, exported_at: now.toISOString() }));
  await sink.replace(rows);
  return rows.length;
}

/** Replace `<dataset>.runs` with a load job (WRITE_TRUNCATE), from a temporary newline-delimited JSON file. */
export function bigQueryRunlogSink(datasetId: string, bigquery = new BigQuery()): RunlogSink {
  return {
    async replace(rows) {
      const dir = await mkdtemp(join(tmpdir(), "runlog-"));
      const file = join(dir, "runs.jsonl");
      try {
        await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
        await bigquery.dataset(datasetId).table("runs").load(file, {
          sourceFormat: "NEWLINE_DELIMITED_JSON",
          writeDisposition: "WRITE_TRUNCATE",
          createDisposition: "CREATE_IF_NEEDED",
          schema: { fields: FIELDS.map(([name, type, mode]) => ({ name, type, mode })) },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
