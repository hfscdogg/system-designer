import type { RunReportRow } from "@sd/store";

const COLUMNS: Array<keyof RunReportRow> = [
  "run_id",
  "created_at",
  "requester",
  "space_id",
  "revision",
  "parent_run_id",
  "request",
  "later_messages",
  "state",
  "pattern",
  "client",
  "subtotal_usd",
  "total_usd",
  "likely_low_usd",
  "likely_high_usd",
  "retainer_usd",
  "retainer_opportunity",
  "pdf_sha256",
  "last_error",
];

/** RFC 4180 CSV: every field quoted, quotes doubled; later messages joined with " | ". */
export function runsCsv(rows: RunReportRow[]): string {
  const cell = (v: unknown) => `"${(Array.isArray(v) ? v.join(" | ") : v == null ? "" : String(v)).replace(/"/g, '""')}"`;
  return [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
