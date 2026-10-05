import { Storage } from "@google-cloud/storage";
import pg from "pg";
import { GoogleChatAdapter, type ChannelAdapter } from "@sd/channels";
import { GcsBlobStore, pgDb, Store } from "@sd/store";

/** Process configuration shared by the gateway and the worker. Secrets come from the environment (Secret Manager). */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

export function releaseId(): string {
  // Set at deploy time to the immutable image digest / release manifest id.
  return requireEnv("RELEASE_ID");
}

export function productionStore(): { store: Store; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: requireEnv("DATABASE_URL"), max: 10 });
  const bucket = new Storage().bucket(requireEnv("EVIDENCE_BUCKET"));
  return { store: new Store(pgDb(pool), new GcsBlobStore(bucket), releaseId()), pool };
}

export function productionAdapters(): Record<string, ChannelAdapter> {
  return { google_chat: new GoogleChatAdapter() };
}

export function temporalSettings() {
  return {
    address: requireEnv("TEMPORAL_ADDRESS"),
    namespace: requireEnv("TEMPORAL_NAMESPACE"),
    apiKey: process.env.TEMPORAL_API_KEY,
  };
}
